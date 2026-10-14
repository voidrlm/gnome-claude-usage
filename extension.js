import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const REFRESH_SECONDS = 30;
const HOUR = 3600e3;
const SESSION = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
// A day of slack so the session window running into the week start is known.
const KEEP = WEEK + 24 * HOUR;
// Panel icon colour by how much of the 5-hour session is used.
const YELLOW_FROM = 50;
const RED_FROM = 80;
const CHUNK = 1 << 20;
const ATTRS = 'standard::name,standard::type,standard::size,time::modified';
const decoder = new TextDecoder();

// The weekly limit resets at a fixed time for each account (shown on
// claude.ai/settings/usage). 6 = Saturday.
const WEEK_RESET_DAY = 6;
const WEEK_RESET_HOUR = 12;

// The real limits aren't in the logs, so usage is measured in "cost units"
// (tokens weighted like API pricing, relative to an input token) and divided
// by budgets calibrated against claude.ai's usage page. Adjust if the
// percentages drift from what claude.ai shows.
const WEIGHTS = {inp: 1, out: 5, cw: 1.25, cr: 0.1};
const SESSION_BUDGET = 12.9e6;
const WEEK_BUDGET = 107e6;

// Claude Code keeps one JSONL transcript per session under <config>/projects/.
function projectDirs() {
    const env = GLib.getenv('CLAUDE_CONFIG_DIR');
    const bases = env
        ? env.split(',').map(s => s.trim()).filter(Boolean)
        : [GLib.build_filenamev([GLib.get_home_dir(), '.claude']),
            GLib.build_filenamev([GLib.get_user_config_dir(), 'claude'])];
    return bases.map(b => GLib.build_filenamev([b, 'projects']));
}

function costOf(list) {
    let c = 0;
    for (const e of list) c += e.cost;
    return c;
}

// A session window opens with the first message (to the minute) and lasts
// 5 hours. While you keep working, windows follow back to back; after a
// window passes with no messages, the next opens with the next message.
function sessionWindow(sorted, now) {
    let start = null, list = [];
    for (const e of sorted) {
        if (start === null || e.t >= start + SESSION) {
            start = start !== null && e.t < start + 2 * SESSION
                ? start + SESSION
                : Math.floor(e.t / 60e3) * 60e3;
            list = [];
        }
        list.push(e);
    }
    if (start === null || now >= start + SESSION) return null;
    return {end: start + SESSION, list};
}

// Most recent weekly reset at or before now, in local time.
function weekStart(now) {
    const d = new Date(now);
    d.setHours(WEEK_RESET_HOUR, 0, 0, 0);
    d.setDate(d.getDate() - (d.getDay() - WEEK_RESET_DAY + 7) % 7);
    if (d.getTime() > now) d.setDate(d.getDate() - 7);
    return d.getTime();
}

// "6:30 AM" today, otherwise "Saturday 12:00 PM".
function fmtReset(ms) {
    const dt = GLib.DateTime.new_from_unix_local(Math.round(ms / 1000));
    const sameDay = new Date(ms).toDateString() === new Date().toDateString();
    return `Resets ${sameDay ? 'at ' : ''}${dt.format(sameDay ? '%-l:%M %p' : '%A %-l:%M %p')}`;
}

export default class ClaudeUsage extends Extension {
    enable() {
        // "<message id>:<request id>" -> entry. Claude Code writes one line per
        // content block, each repeating the message's usage, so later lines
        // overwrite earlier ones instead of being counted again.
        this._entries = new Map();
        // path -> {offset, partial}: files are read incrementally.
        this._files = new Map();
        this._cancellable = new Gio.Cancellable();

        this._button = new PanelMenu.Button(0.5, this.metadata.name);
        // Just an icon, like the system icons next to it; its colour shows how
        // much of the session is left.
        this._icons = Object.fromEntries(['green', 'yellow', 'red'].map(c =>
            [c, Gio.icon_new_for_string(`${this.path}/icons/claude-${c}.svg`)]));
        this._icon = new St.Icon({gicon: this._icons.green, style_class: 'system-status-icon'});
        this._button.add_child(this._icon);

        const menu = this._button.menu;
        menu.box.add_style_class_name('cu-menu');
        this._sessionRow = this._addRow(menu, 'Current session', 'cu-session');
        this._weekRow = this._addRow(menu, 'This week', 'cu-week');

        // Right of the network speed / performance gauge, whatever the load order.
        const rightBox = Main.panel._rightBox;
        const left = Main.panel.statusArea['net-speed@arjun']?.container
            ?? Main.panel.statusArea['system-monitor-panel@arjun']?.container;
        const idx = left ? rightBox.get_children().indexOf(left) + 1 : 0;
        Main.panel.addToStatusArea(this.uuid, this._button, idx, 'right');

        this._scan();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _scan() {
        if (this._busy) return;
        this._busy = true;
        try {
            const cutoff = Date.now() - KEEP;
            for (const dir of projectDirs())
                await this._scanDir(Gio.File.new_for_path(dir), cutoff, 0);
            if (!this._button) return; // disabled mid-scan
            for (const [k, e] of this._entries) {
                if (e.t < cutoff) this._entries.delete(k);
            }
            this._update();
        } catch (e) {
            if (this._button && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`${this.uuid}: ${e}`);
        } finally {
            this._busy = false;
        }
    }

    // projects/<project>/<session>.jsonl, plus subagent transcripts a level
    // or two further down.
    async _scanDir(dir, cutoff, depth) {
        let en;
        try {
            en = await dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
            throw e;
        }
        try {
            for (;;) {
                const infos = await en.next_files_async(100, GLib.PRIORITY_LOW, this._cancellable);
                if (!infos.length) break;
                for (const info of infos) {
                    const child = en.get_child(info);
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        if (depth < 3) await this._scanDir(child, cutoff, depth + 1);
                    } else if (info.get_name().endsWith('.jsonl') &&
                               info.get_modification_date_time().to_unix() * 1000 >= cutoff) {
                        await this._readNew(child, info.get_size(), cutoff);
                    }
                }
            }
        } finally {
            en.close(null);
        }
    }

    // Reads only what was appended since the last scan.
    async _readNew(file, size, cutoff) {
        const path = file.get_path();
        let st = this._files.get(path);
        if (!st || size < st.offset) {
            st = {offset: 0, partial: new Uint8Array(0)};
            this._files.set(path, st);
        }
        if (size === st.offset) return;

        const stream = await file.read_async(GLib.PRIORITY_LOW, this._cancellable);
        try {
            if (st.offset) stream.seek(st.offset, GLib.SeekType.SET, this._cancellable);
            for (;;) {
                const bytes = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_LOW, this._cancellable);
                const data = bytes.toArray();
                if (!data.length) break;
                st.offset += data.length;
                // Split on the last newline in raw bytes: GJS's TextDecoder has
                // no streaming mode, and a chunk can end mid-character.
                const buf = new Uint8Array(st.partial.length + data.length);
                buf.set(st.partial);
                buf.set(data, st.partial.length);
                const end = buf.lastIndexOf(10) + 1;
                st.partial = buf.slice(end);
                if (!end) continue;
                for (const line of decoder.decode(buf.subarray(0, end)).split('\n'))
                    this._ingest(line, cutoff);
            }
        } finally {
            stream.close(null);
        }
    }

    _ingest(line, cutoff) {
        // Cheap filter first: most lines are user turns and tool output.
        if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
        let d;
        try {
            d = JSON.parse(line);
        } catch (e) {
            return;
        }
        const m = d.message, u = m?.usage;
        if (d.type !== 'assistant' || !u || m.model === '<synthetic>') return;
        const t = Date.parse(d.timestamp);
        if (!(t >= cutoff)) return;
        const w = WEIGHTS;
        this._entries.set(`${m.id}:${d.requestId}`, {
            t,
            cost: (u.input_tokens ?? 0) * w.inp + (u.output_tokens ?? 0) * w.out +
                  (u.cache_creation_input_tokens ?? 0) * w.cw + (u.cache_read_input_tokens ?? 0) * w.cr,
        });
    }

    _update() {
        if (!this._button) return;
        const now = Date.now();
        const sorted = [...this._entries.values()].sort((a, b) => a.t - b.t);

        const win = sessionWindow(sorted, now);
        const sessionPct = win ? costOf(win.list) / SESSION_BUDGET * 100 : 0;
        this._setRow(this._sessionRow, sessionPct, win ? fmtReset(win.end) : 'Starts with your next message');

        const ws = weekStart(now);
        const weekPct = costOf(sorted.filter(e => e.t >= ws)) / WEEK_BUDGET * 100;
        this._setRow(this._weekRow, weekPct, fmtReset(ws + WEEK));

        const level = sessionPct >= RED_FROM ? 'red' : sessionPct >= YELLOW_FROM ? 'yellow' : 'green';
        if (this._icon.gicon !== this._icons[level]) this._icon.gicon = this._icons[level];
    }

    // Title and reset time on the left, a bar in the middle, "43% used" right.
    _addRow(menu, title, barClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'cu-row', x_expand: true});
        const text = new St.BoxLayout({vertical: true, style_class: 'cu-text', y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: title, style_class: 'cu-title'}));
        const sub = new St.Label({text: '', style_class: 'cu-sub'});
        text.add_child(sub);
        box.add_child(text);
        const bg = new St.Widget({style_class: `cu-bar-bg ${barClass}`, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const fg = new St.Widget({style_class: `cu-bar-fg ${barClass}`});
        bg.add_child(fg);
        box.add_child(bg);
        const pct = new St.Label({text: '', style_class: 'cu-pct', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(pct);
        item.add_child(box);
        menu.addMenuItem(item);
        const row = {sub, bg, fg, pct, frac: 0};
        bg.connect('notify::width', () => fg.set_width(Math.round(bg.width * row.frac)));
        return row;
    }

    _setRow(row, percent, resetText) {
        row.frac = Math.min(1, percent / 100);
        row.fg.set_width(Math.round(row.bg.width * row.frac));
        row.pct.text = `${Math.round(percent)}% used`;
        row.sub.text = resetText;
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable?.cancel();
        this._button?.destroy();
        this._button = this._icon = this._icons = this._sessionRow = this._weekRow = null;
        this._entries = this._files = this._cancellable = null;
        this._busy = false;
    }
}
