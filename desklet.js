const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;

const API_URL = "https://api.monday.com/v2";
const API_VERSION = "2025-01";
const BOARDS_PER_REQUEST = 50;

const PRIORITY_RANK = { "Critical": 0, "High": 1, "Medium": 2, "Low": 3 };
const DATE_UPCOMING = "#0073ea";
const DATE_DONE = "#797e93";
const STATUS_FALLBACK = "#797e93";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bytesToString(bytes) {
    let data = bytes instanceof GLib.Bytes ? bytes.get_data() : bytes;
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(data);
    return imports.byteArray.toString(data);
}

function MondayDesklet(metadata, deskletId) {
    this._init(metadata, deskletId);
}

MondayDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, deskletId) {
        Desklet.Desklet.prototype._init.call(this, metadata, deskletId);
        this.metadata = metadata;
        this._timer = 0;
        this._inFlight = false;
        this._items = [];
        this._lastError = null;
        this._lastUpdated = null;
        this._boards = null;
        this._boardsFetchedAt = 0;

        this.settings = new Settings.DeskletSettings(this, metadata.uuid, deskletId);
        let rerender = () => this._render();
        let refetch = () => this._fetch();
        let retimer = () => this._scheduleRefresh();
        this.settings.bind("api_token", "apiToken", refetch);
        let rediscover = () => { this._boards = null; this._fetch(); };
        this.settings.bind("exclude_boards", "excludeBoards", refetch);
        this.settings.bind("workspaces", "workspaces", refetch);
        this.settings.bind("board_refresh_interval", "boardRefreshInterval", rediscover);
        this.settings.bind("show_done", "showDone", rerender);
        this.settings.bind("hide_undated", "hideUndated", rerender);
        this.settings.bind("hide_date_overdue", "hideDateOverdue", rerender);
        this.settings.bind("max_items", "maxItems", rerender);
        this.settings.bind("width", "width", rerender);
        this.settings.bind("font_size", "fontSize", rerender);
        this.settings.bind("title", "title", rerender);
        this.settings.bind("auto_refresh", "autoRefresh", retimer);
        this.settings.bind("refresh_interval", "refreshInterval", retimer);

        this._session = new Soup.Session();
        this._session.timeout = 30;

        this._root = new St.BoxLayout({ vertical: true, style_class: "mw-root" });
        this.setContent(this._root);
        this.setHeader(this.title || "My work");

        this._render();
        this._fetch();
        this._scheduleRefresh();
    },

    on_desklet_removed: function() {
        this._clearTimer();
    },

    _clearTimer: function() {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
    },

    _scheduleRefresh: function() {
        this._clearTimer();
        if (!this.autoRefresh) return;
        let secs = Math.max(30, parseInt(this.refreshInterval) || 300);
        this._timer = Mainloop.timeout_add_seconds(secs, () => {
            this._fetch();
            return true;
        });
    },

    // ---- board discovery -------------------------------------------------

    _parseIdList: function(text) {
        let out = {};
        (text || "").split(/[\s,]+/).forEach(t => {
            let n = parseInt(t);
            if (n) out[n] = true;
        });
        return out;
    },

    _boardsStale: function() {
        if (!this._boards) return true;
        let mins = Math.max(1, parseInt(this.boardRefreshInterval) || 15);
        return (Date.now() - this._boardsFetchedAt) > mins * 60 * 1000;
    },

    // Page through every active board the token can see and keep the ones
    // that have a people column. Subitem boards are ordinary boards here.
    _discoverBoards: function(page, acc, cb) {
        let q = "query { boards(limit: 100, page: " + page + ", state: active) {" +
                " id name type workspace_id columns(types: [people]) { id } } }";
        this._request(q, (err, data) => {
            if (err) { cb(err); return; }
            let list = (data && data.boards) || [];
            list.forEach(b => {
                let isBoard = (b.type === "board" || b.type === "sub_items_board");
                if (isBoard && b.columns && b.columns.length) {
                    acc.push({ id: parseInt(b.id), name: b.name, type: b.type,
                               workspace: parseInt(b.workspace_id) || 0,
                               cols: b.columns.map(c => c.id) });
                }
            });
            if (list.length === 100 && page < 50) this._discoverBoards(page + 1, acc, cb);
            else cb(null, acc);
        });
    },

    _filteredBoards: function() {
        let excl = this._parseIdList(this.excludeBoards);
        let ws = this._parseIdList(this.workspaces);
        let anyWs = Object.keys(ws).length > 0;
        return (this._boards || []).filter(b => !excl[b.id] && (!anyWs || ws[b.workspace]));
    },

    // ---- item query ------------------------------------------------------

    _buildQuery: function(boards) {
        let parts = [];
        boards.forEach((b, i) => {
            b.cols.forEach((col, j) => {
                parts.push("b" + i + "_" + j + ": boards(ids: [" + b.id + "]) { id name items_page(limit: 100, query_params: {" +
                    "rules: [{column_id: \"" + col + "\", compare_value: [\"assigned_to_me\"], operator: any_of}]}) {" +
                    " items { id name url column_values(types: [status, date, timeline]) { id type text column { title }" +
                    " ... on StatusValue { is_done label_style { color } } } } } }");
            });
        });
        return "query { " + parts.join(" ") + " }";
    },

    _fetch: function() {
        if (this._inFlight) return;
        let token = (this.apiToken || "").trim();
        if (!token) {
            this._lastError = "No API token set. Right-click → Configure.";
            this._render();
            return;
        }
        this._inFlight = true;

        let afterBoards = (err) => {
            if (err) { this._fail(err); return; }
            let boards = this._filteredBoards();
            if (!boards.length) { this._fail("No boards with a people column found."); return; }
            this._fetchItems(boards, 0, [], (err2, items) => {
                if (err2) { this._fail(err2); return; }
                this._inFlight = false;
                this._items = items;
                this._lastError = null;
                this._lastUpdated = new Date();
                this._render();
            });
        };

        if (this._boardsStale()) {
            this._discoverBoards(1, [], (err, boards) => {
                if (!err) { this._boards = boards; this._boardsFetchedAt = Date.now(); }
                afterBoards(err);
            });
        } else {
            afterBoards(null);
        }
    },

    _fetchItems: function(boards, offset, acc, cb) {
        if (offset >= boards.length) { cb(null, acc); return; }
        let chunk = boards.slice(offset, offset + BOARDS_PER_REQUEST);
        this._request(this._buildQuery(chunk), (err, data) => {
            if (err) { cb(err); return; }
            this._extract(data || {}).forEach(it => {
                if (!acc.some(x => x.id === it.id)) acc.push(it);
            });
            this._fetchItems(boards, offset + BOARDS_PER_REQUEST, acc, cb);
        });
    },

    _fail: function(err) {
        this._inFlight = false;
        this._lastError = String(err && err.message ? err.message : err);
        this._render();
    },

    // One GraphQL request; cb(err, data).
    _request: function(query, cb) {
        let token = (this.apiToken || "").trim();
        let body = JSON.stringify({ query: query });
        let msg = Soup.Message.new("POST", API_URL);
        msg.request_headers.append("Authorization", token);
        msg.request_headers.append("API-Version", API_VERSION);

        let done = (text, status) => {
            try {
                if (status < 200 || status >= 300) throw new Error("HTTP " + status);
                let json = JSON.parse(text);
                if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
                if (json.error_message) throw new Error(json.error_message);
                cb(null, json.data || {});
            } catch (e) {
                cb(e);
            }
        };

        if (Soup.MAJOR_VERSION === 2) {
            msg.set_request("application/json", Soup.MemoryUse.COPY, body);
            this._session.queue_message(msg, (s, m) => {
                done(m.response_body ? m.response_body.data : "", m.status_code);
            });
        } else {
            msg.set_request_body_from_bytes("application/json", new GLib.Bytes(body));
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                let text = "";
                try { text = bytesToString(s.send_and_read_finish(res)); } catch (e) { text = ""; }
                done(text, msg.get_status());
            });
        }
    },

    _extract: function(data) {
        let items = [];
        Object.keys(data).forEach(key => {
            let boards = data[key] || [];
            boards.forEach(board => {
                let page = board.items_page || {};
                (page.items || []).forEach(raw => {
                    let it = { id: raw.id, name: raw.name, url: raw.url, board: board.name,
                               start: null, end: null, status: "", statusColor: STATUS_FALLBACK,
                               priority: "", priorityColor: null, done: false };
                    let phase = null, status = null;
                    (raw.column_values || []).forEach(cv => {
                        let title = (cv.column && cv.column.title) || "";
                        if (cv.type === "timeline" && cv.text) {
                            let m = cv.text.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
                            if (m) { it.start = m[1]; it.end = m[2]; }
                        } else if (cv.type === "date" && cv.text && !it.end) {
                            let m = cv.text.match(/\d{4}-\d{2}-\d{2}/);
                            if (m) { it.start = m[0]; it.end = m[0]; }
                        } else if (cv.type === "status") {
                            if (cv.is_done) it.done = true;
                            if (title === "Priority") {
                                it.priority = (cv.text || "").replace(/\s*⚠.*$/, "").trim();
                                it.priorityColor = cv.label_style ? cv.label_style.color : null;
                            } else if (title === "Phase") {
                                phase = cv;
                            } else if (title === "Status" || (!status && !phase)) {
                                status = cv;
                            }
                        }
                    });
                    let pick = (phase && phase.text) ? phase : status;
                    if (pick && pick.text) {
                        it.status = pick.text;
                        it.statusColor = (pick.label_style && pick.label_style.color) || STATUS_FALLBACK;
                    }
                    items.push(it);
                });
            });
        });
        return items;
    },

    _today: function() {
        let d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    },

    _bucket: function(it, today) {
        if (it.done) return "Done";
        if (!it.end) return "No date";
        if (it.end < today) return "Overdue";
        if (it.end === today) return "Today";
        return "Upcoming";
    },

    _fmtDate: function(s) {
        let p = s.split("-");
        return MONTHS[parseInt(p[1]) - 1] + " " + parseInt(p[2]);
    },

    _dateLabel: function(it) {
        if (!it.start) return "";
        if (it.end && it.end !== it.start) {
            let a = it.start.split("-"), b = it.end.split("-");
            if (a[1] === b[1]) return this._fmtDate(it.start) + " - " + parseInt(b[2]);
            return this._fmtDate(it.start) + " - " + this._fmtDate(it.end);
        }
        return this._fmtDate(it.start);
    },

    _pill: function(text, color, width, extraClass) {
        let cls = "mw-pill" + (extraClass ? " " + extraClass : "");
        let style = "width: " + width + "px;";
        if (text) style += " background-color: " + color + ";";
        else cls += " mw-pill-empty";
        let l = new St.Label({ text: text || " ", style_class: cls, style: style });
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        l.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        return l;
    },

    _row: function(it, bucket, nameWidth) {
        let row = new St.BoxLayout({ style_class: "mw-row", reactive: true, track_hover: true });
        let name = new St.Label({ text: it.name, style_class: "mw-name", style: "width: " + nameWidth + "px;" });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add(name, { expand: true, y_align: St.Align.MIDDLE });

        let hideDate = (bucket === "Overdue" && this.hideDateOverdue);
        let dateText = hideDate ? "" : this._dateLabel(it);
        if (hideDate) {
            row.add(new St.Label({ text: " ", style: "width: 104px;" }), { y_align: St.Align.MIDDLE });
        } else {
            row.add(this._pill(dateText, it.done ? DATE_DONE : DATE_UPCOMING, 104, "mw-pill-date"), { y_align: St.Align.MIDDLE });
        }
        row.add(new St.Label({ text: " ", style: "width: 6px;" }));
        row.add(this._pill(it.status, it.statusColor, 120), { y_align: St.Align.MIDDLE });
        row.add(new St.Label({ text: " ", style: "width: 6px;" }));
        let prText = it.priority === "Critical" ? "Critical \u26A0" : it.priority;
        row.add(this._pill(prText, it.priorityColor || STATUS_FALLBACK, 96), { y_align: St.Align.MIDDLE });

        row.connect("button-release-event", () => {
            if (it.url) Gio.AppInfo.launch_default_for_uri(it.url, null);
            return true;
        });
        return row;
    },

    _render: function() {
        this._root.destroy_all_children();
        let width = parseInt(this.width) || 620;
        let fontSize = parseInt(this.fontSize) || 10;
        this._root.set_style("width: " + width + "px; font-size: " + fontSize + "pt;");
        this.setHeader(this.title || "My work");

        let top = new St.BoxLayout();
        top.add(new St.Label({ text: this.title || "My work", style_class: "mw-title" }), { expand: true, y_align: St.Align.MIDDLE });
        let metaText = this._lastUpdated
            ? "Updated " + this._lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : (this._inFlight ? "Loading…" : "");
        this._metaLabel = new St.Label({ text: metaText, style_class: "mw-meta" });
        top.add(this._metaLabel, { y_align: St.Align.MIDDLE });
        let btn = new St.Button({ label: "\u21BB", style_class: "mw-btn", reactive: true, track_hover: true });
        btn.connect("clicked", () => { this._metaLabel.set_text("Loading…"); this._boards = null; this._fetch(); });
        top.add(btn, { y_align: St.Align.MIDDLE });
        this._root.add(top);

        if (this._lastError) {
            this._root.add(new St.Label({ text: this._lastError, style_class: "mw-error" }));
            if (!this._items.length) return;
        }

        let today = this._today();
        let groups = {};
        let shown = 0;
        let sorted = this._items.slice().sort((x, y) => {
            let a = PRIORITY_RANK[x.priority] !== undefined ? PRIORITY_RANK[x.priority] : 4;
            let b = PRIORITY_RANK[y.priority] !== undefined ? PRIORITY_RANK[y.priority] : 4;
            if (a !== b) return a - b;
            return (x.end || "9") < (y.end || "9") ? -1 : 1;
        });
        sorted.forEach(it => {
            if (it.done && !this.showDone) return;
            if (!it.end && this.hideUndated) return;
            let b = this._bucket(it, today);
            (groups[b] = groups[b] || []).push(it);
        });

        let order = ["Overdue", "Today", "Upcoming", "No date", "Done"];
        let nameWidth = width - 104 - 120 - 96 - 12 - 40;
        let max = parseInt(this.maxItems) || 30;
        let any = false;
        order.forEach(b => {
            let list = groups[b];
            if (!list || !list.length || shown >= max) return;
            any = true;
            let head = new St.BoxLayout();
            head.add(new St.Label({ text: b, style_class: "mw-section" }), { y_align: St.Align.END });
            head.add(new St.Label({ text: "  " + list.length + (list.length === 1 ? " item" : " items"), style_class: "mw-count" }), { y_align: St.Align.END });
            this._root.add(head);
            let hdr = new St.BoxLayout({ style_class: "mw-header" });
            hdr.add(new St.Label({ text: "", style: "width: " + nameWidth + "px;" }), { expand: true });
            hdr.add(new St.Label({ text: "Date", style: "width: 104px; text-align: center;" }));
            hdr.add(new St.Label({ text: " ", style: "width: 6px;" }));
            hdr.add(new St.Label({ text: "Status", style: "width: 120px; text-align: center;" }));
            hdr.add(new St.Label({ text: " ", style: "width: 6px;" }));
            hdr.add(new St.Label({ text: "Priority", style: "width: 96px; text-align: center;" }));
            this._root.add(hdr);
            list.forEach(it => {
                if (shown >= max) return;
                this._root.add(this._row(it, b, nameWidth));
                shown++;
            });
        });
        if (!any && !this._lastError) {
            this._root.add(new St.Label({ text: this._inFlight ? "Loading…" : "Nothing to show", style_class: "mw-meta" }));
        }
    }
};

function main(metadata, deskletId) {
    return new MondayDesklet(metadata, deskletId);
}
