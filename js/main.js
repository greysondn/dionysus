// The client shell: a connection, a file cache, text, and the screens. It runs no game code: everything game-
// specific arrives as data (layouts, templates, controls, text keys) and is drawn by the generic renderer.
import { FileCache } from "./cache.js";
import { CodeError, TARGET_CHARS, decode } from "./handshake.js";
import { Net } from "./net.js";
import { ReplayScreen } from "./replay.js";
import { sha256Hex } from "./softcrypto.js";
import { TableScreen } from "./table.js";
import { Text } from "./text.js";
import { bytes, clear, dialog, formatTime, h, toast } from "./ui.js";

const TOKEN = "dionysus.session";               // one session per server: dionysus.session.<server_id>
const KEY = "dionysus.redial";                  // a reconnect key and the details to re-dial, per server: dionysus.redial.<server_id>

// Uploads: the bytes in each chunk, the frame header before them (the
// frame type, the 16-byte upload id and the 8-byte offset), how much may
// sit in the send buffer before waiting, and how long each wait is.
const UPLOAD_CHUNK_BYTES = 16384;
const UPLOAD_HEADER_BYTES = 25;
const UPLOAD_BUFFERED_MAX = 1 << 20;
const UPLOAD_WAIT_MS = 20;
const REDIAL_WAITS_MS = [0, 2000, 5000, 10000, 15000];   // after a drop: when to try re-dialing, before asking for an invite
const DEFAULT_CONFIG = { stun_servers: ["stun:stun.l.google.com:19302"] };

class App {
  constructor() {
    this.root = document.getElementById("app");
    this.net = new Net();
    this.cache = new FileCache(this.net);
    this.text = new Text();
    this.account = null;
    this.screen = null;
    this.table = null;
  }

  async start() {
    await this.text.loadCore((navigator.language || "en").slice(0, 2));
    try {
      await this.cache.open();
    } catch {
      toast("This browser cannot keep a file cache; files will be downloaded each time.", "warn");
    }
    this.net.addEventListener("closed", () => this.onClosed());
    this.net.addEventListener("notice", (e) => this.onNotice(e.detail));
    this.config = { ...DEFAULT_CONFIG, ...(await fetchJSON(new URL("../config.json", import.meta.url))) };
    const join = location.hash.match(/#join=(.+)$/);
    if (join) return this.joinScreen(decodeURIComponent(join[1]));
    if (await this.servedByServer()) return this.connect();
    if (this.heldKey()) return this.reconnect();  // back after a reload: dial the server we were on
    return this.joinScreen();                     // a static copy of the client: players join with an invite code
  }

  /** Whether a Dionysus server serves this page (then the two WebSockets reach it), or a static host does. */
  async servedByServer() {
    const info = await fetchJSON(new URL("/api/info", location.href), 2500);
    return Boolean(info?.dionysus);
  }

  async connect() {
    clear(this.root, h("div.splash", {}, h("h1.brand", {}, "Dionysus"), h("p.muted", {}, "Connecting…")));
    try {
      await this.net.connect();
    } catch (e) {
      clear(this.root, h("div.splash", {}, h("h1.brand", {}, "Dionysus"), h("p", {}, e.message), h("button", { onclick: () => this.connect() }, "Try again")));
      return;
    }
    return this.connected();
  }

  tokenKey() {
    return `${TOKEN}.${this.net.welcome.server_id || "local"}`;
  }

  /** Connected and welcomed, over either transport: resume the session for this server, or sign in. */
  async connected() {
    const token = localStorage.getItem(this.tokenKey());
    const held = this.heldKey(this.net.welcome.server_id);
    // back through a new invite: our key lets the session follow us to a new address (a re-dial presented it already)
    if (held && this.net.mode === "webrtc" && !this.net.redialed && !(await this.net.presentKey(held.key))) {
      this.dropKey(held.srv);
    }
    if (token) {
      try {
        const r = await this.net.request("account.resume", { session_token: token });
        return this.signedIn(r, token);
      } catch (e) {
        localStorage.removeItem(this.tokenKey());
        if (e.code === "session_ip_changed") toast("Your network address changed, so you were logged out. Please log in again.", "warn", 8000);
      }
    }
    this.authScreen();
  }

  onClosed() {
    // the table screen is kept, with its state, so the server can send just what was missed once we are back
    const where = this.table ? { id: this.table.id, opts: this.table.opts, screen: this.table } : null;
    if (this.table) this.table.detach();
    this.resumeTable = where;                    // signing in again goes back to it
    if (this.net.mode === "webrtc") {
      this.table = null;
      this.reconnect();
      return;
    }
    toast("Disconnected. Reconnecting…", "warn");
    setTimeout(() => this.connect(), 1500);
  }

  // ---------------------------------------------------------------- reconnecting over WebRTC (redial.py)

  heldKey(serverId = localStorage.getItem(`${KEY}.last`)) {
    try {
      return serverId ? JSON.parse(localStorage.getItem(`${KEY}.${serverId}`)) : null;
    } catch {
      return null;
    }
  }

  keepKey(held) {
    localStorage.setItem(`${KEY}.${held.srv}`, JSON.stringify(held));
    localStorage.setItem(`${KEY}.last`, held.srv);
  }

  dropKey(serverId) {
    localStorage.removeItem(`${KEY}.${serverId}`);
    if (localStorage.getItem(`${KEY}.last`) === serverId) localStorage.removeItem(`${KEY}.last`);
  }

  /** A fresh reconnect key, over a connection the host approved (or a re-dial). Without one, a drop needs an invite. */
  async issueKey() {
    if (this.net.mode !== "webrtc") return;
    try {
      const r = await this.net.request("redial.issue");
      this.keepKey({ srv: this.net.welcome.server_id, key: r.key, details: r.details });
    } catch {
      // the server cannot issue one (an old server): the next drop needs an invite
    }
  }

  /** Dial `details` with our key. True once in (then signed in again, back where we were). */
  async redialWith(held, details = held.details, timeoutMs) {
    this.net.close();
    this.net = this.freshNet();
    try {
      await this.net.redial(details, held.key, timeoutMs);
    } catch (e) {
      if (e.code === "refused") this.dropKey(held.srv);
      this.net = this.freshNet();
      return false;
    }
    this.net.redialed = true;
    if (details !== held.details) this.keepKey({ ...held, details });
    await this.connected();
    return true;
  }

  /** The connection dropped: dial the server again, a few times, before asking the player for a new invite. */
  async reconnect() {
    const held = this.heldKey(this.net.welcome?.server_id);
    if (!held?.details) return this.joinScreen("", { lost: true });
    let stopped = false;
    const status = h("p.muted", { role: "status" }, "Reconnecting…");
    clear(this.root, h("div.splash", {}, h("h1.brand", {}, "Dionysus"), h("p", {}, "The connection was lost."), status,
      h("button.ghost", { onclick: () => { stopped = true; this.joinScreen(); } }, "Use a new invite instead")));
    for (const [i, wait] of REDIAL_WAITS_MS.entries()) {
      await new Promise((r) => setTimeout(r, wait));
      if (stopped || !status.isConnected) return;
      status.textContent = `Reconnecting… (try ${i + 1} of ${REDIAL_WAITS_MS.length})`;
      if (await this.redialWith(held)) return;
      if (!this.heldKey(held.srv)) break;          // refused: the key is gone, so trying again cannot help
    }
    if (!stopped && status.isConnected) this.joinScreen("", { lost: true });
  }

  // ---------------------------------------------------------------- joining with an invite (WebRTC)

  joinScreen(code = "", { lost = false } = {}) {
    history.replaceState(null, "", location.pathname + location.search);
    if (!this.net.open) {
      this.net.close();
      this.net = this.freshNet();
    }
    const pasted = h("textarea.code", { rows: 5, placeholder: "dny1c.…", spellcheck: "false", autocomplete: "off" }, code);
    const name = h("input", { type: "text", placeholder: "So the host knows who answered", maxlength: 64,
                               value: localStorage.getItem("dionysus.joinName") || "" });
    const err = h("p.error", { role: "alert" });
    const answer = async (e) => {
      e?.preventDefault();
      err.textContent = "";
      localStorage.setItem("dionysus.joinName", name.value.trim());
      // holding a key for this server, a new invite's re-dial details may be enough: no response code needed
      const envelope = await decode(pasted.value, "c").catch(() => null);
      const held = envelope?.rd && this.heldKey(envelope.srv);
      if (held) {
        err.textContent = "Reconnecting…";
        if (await this.redialWith(held, envelope.rd, 8000)) return;
        err.textContent = "";
      }
      try {
        const { response, envelope, connected } = await this.net.answer(pasted.value, { name: name.value.trim() || undefined,
                                                                                      stunServers: this.config.stun_servers,
                                                                                      policy: this.config.ice_transport_policy });
        this.respondScreen(response, envelope, connected);
      } catch (ex) {
        err.textContent = ex instanceof CodeError ? ex.message : `Could not answer that invite: ${ex.message}`;
      }
    };
    clear(this.root, h("div.auth", {}, h("div.auth-card.wide", {},
      h("h1.brand", {}, "Dionysus"),
      lost ? h("div.notice", {}, h("b", {}, "The connection was lost, "), "and reconnecting on its own did not work. Ask the host for a new invite code to rejoin; your game is safe on the server.")
        : h("p.muted", {}, "Join a game server with the invite code its host sent you."),
      h("form", { onsubmit: answer },
        h("label.field", {}, h("span", {}, "Invite code from the host"), pasted),
        h("label.field", {}, h("span", {}, "Your name (optional)"), name),
        err,
        h("button.primary.wide", { type: "submit" }, "Answer the invite")),
      h("p.muted.small", {}, "You will get a code back to send to the host. Once they enter it, you are connected. Nothing passes through any server but theirs."))));
    if (code) answer();
    else pasted.focus();
  }

  freshNet() {
    const net = new Net();
    // carry on numbering actions where the last connection stopped: the server answers a client_sequence it has seen with
    // that action's ack (a retry), so a new connection must not reuse one
    if (this.net) net.clientSequence = Math.max(net.clientSequence, this.net.clientSequence);
    net.addEventListener("closed", () => this.onClosed());
    net.addEventListener("notice", (e) => this.onNotice(e.detail));
    this.cache.net = net;
    net.frameHandlers.add((frame) => this.cache.onFrame(frame));
    return net;
  }

  respondScreen(response, envelope, connected) {
    const box = h("textarea.code", { rows: 6, readonly: true, spellcheck: "false" }, response);
    const status = h("p.waiting", { role: "status" }, "Waiting for the host to enter your code…");
    const left = h("span.muted");
    const tick = () => {
      const s = Math.max(0, Math.round(envelope.exp - Date.now() / 1000));
      left.textContent = s ? ` The invite is valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} more.` : " The invite has expired; ask for a new one.";
    };
    tick();
    const timer = setInterval(tick, 1000);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(response);
        toast("Copied. Send it to the host.");
      } catch {
        box.select();
      }
    };
    clear(this.root, h("div.auth", {}, h("div.auth-card.wide", {},
      h("h1.brand", {}, "Dionysus"),
      h("p", {}, "Joining ", h("b", {}, envelope.name || "a Dionysus server"), ". Send this code back to the host:"),
      box,
      h("div.row", {}, h("button.primary", { onclick: copy }, "Copy the code"),
        h("span.muted.small", {}, `${response.length} characters`)),
      status, h("p.small", {}, left),
      h("p.muted.small", {}, "Keep this page open. The code works only with the invite it answers."))));
    box.addEventListener("focus", () => box.select());
    connected.then(async () => {
      clearInterval(timer);
      status.textContent = "Connected.";
      await this.connected();                    // signing in reopens the table we were at, if any
    }, (ex) => {
      clearInterval(timer);
      status.textContent = ex.message;
      status.classList.add("error");
    });
  }

  onNotice(n) {
    if (n.code === "media_deleted") this.cache.purge(n.text?.params?.hash);
    else if (n.code === "runtime_alert" && this.account?.is_admin) toast(this.text.t(n.text), "warn", 6000);
    else if (n.level === "error") toast(this.text.t(n.text || { key: `core.${n.code}` }), "error");
  }

  async signedIn(result, token) {
    if (result.session_token) localStorage.setItem(this.tokenKey(), result.session_token);
    this.account = result.account;
    this.issueKey();
    for (const h0 of result.tombstones || []) this.cache.purge(h0).catch(() => {});
    if (!sessionStorage.getItem("dionysus.disclosed")) {
      await this.showDisclosures(this.net.welcome.disclosures);
      sessionStorage.setItem("dionysus.disclosed", "1");
    }
    const games = await this.net.request("games.list");
    this.games = games.games;
    const hash = location.hash.match(/^#table\/([\w-]+)/);
    const replay = location.hash.match(/^#replay\/([\w-]+)\/(\d+)\/(own|released)(?:\/(\d+))?/);
    const resume = this.resumeTable;
    this.resumeTable = null;
    if (resume) this.openTable(resume.id, resume.opts, resume.screen);      // back to the table we were at, as it was
    else if (replay) this.openReplay(replay[1], Number(replay[2]), { view: replay[3], seat: replay[4] ? Number(replay[4]) : undefined });
    else if (hash) this.openTable(hash[1], {});
    else this.go("lobby");
  }

  async showDisclosures(list) {
    const items = list || this.net.welcome.disclosures;
    await dialog(this.text.t("disclosure.title"), h("ul.disclosures", {}, items.map((d) => h("li", {}, this.text.t(d.text)))), [["I understand", true, "primary"]]);
  }

  // ---------------------------------------------------------------- signing in

  authScreen(mode) {
    const w = this.net.welcome;
    mode = mode || (w.bootstrap_required ? "bootstrap" : "login");
    const user = h("input", { name: "username", autocomplete: "username", required: true, minlength: 2 });
    const pass = h("input", { name: "password", type: "password", autocomplete: mode === "login" ? "current-password" : "new-password", required: true, minlength: 6 });
    const display = h("input", { name: "display_name", autocomplete: "nickname" });
    const code = h("input", { name: "code", autocomplete: "one-time-code", required: true });
    const err = h("p.error", { role: "alert" });
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const method = { login: "account.login", register: "account.register", bootstrap: "account.bootstrap" }[mode];
      const params = { username: user.value.trim(), password: pass.value };
      if (mode !== "login") params.display_name = display.value.trim() || undefined;
      if (mode === "bootstrap") params.code = code.value.trim();
      try {
        this.signedIn(await this.net.request(method, params));
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
    const field = (label, input, hint) => h("label.field", {}, h("span", {}, label), input, hint ? h("small.muted", {}, hint) : null);
    clear(this.root, h("div.auth", {},
      h("div.auth-card", {},
        h("h1.brand", {}, "Dionysus"), h("p.muted", {}, this.text.t("app.tagline")),
        mode === "bootstrap" ? h("div.notice", {}, h("b", {}, "This server has no admin yet. "), "The first account becomes the admin. Use the one-time code the server printed when it started.") : null,
        h("form", { onsubmit: submit },
          field("Username", user),
          field("Password", pass, mode === "login" ? null : "There is no password recovery: the admin can set a new one, nothing else."),
          mode !== "login" ? field("Display name", display) : null,
          mode === "bootstrap" ? field("One-time code", code) : null,
          err,
          h("button.primary.wide", { type: "submit" }, { login: "Log in", register: "Create account", bootstrap: "Create the admin account" }[mode])),
        mode === "login" && w.registration !== false ? h("p.switch", {}, "New here? ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.authScreen("register"); } }, "Create an account")) : null,
        mode === "register" ? h("p.switch", {}, h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.authScreen("login"); } }, "I have an account")) : null)));
    user.focus();
  }

  // ---------------------------------------------------------------- navigation

  shell(active, content) {
    const nav = [["lobby", "Tables"], ["profile", "Profile"], ["leaderboards", "Leaderboards"]];
    if (this.canInvite()) nav.push(["invite", "Invite"]);
    if (this.account.is_admin) nav.push(["admin", "Admin"]);
    clear(this.root, h("div.shell", {},
      h("header.topbar", {},
        h("div.brand-small", {}, "Dionysus"),
        h("nav", {}, nav.map(([k, label]) => h("button", { class: k === active ? "nav on" : "nav", onclick: () => this.go(k) }, label))),
        h("div.who", {}, h("span", {}, this.account.display_name), h("button.ghost.small", { onclick: () => this.logout() }, "Log out"))),
      h("main.page", {}, content)));
  }

  go(where, arg) {
    if (this.table) {
      this.net.request("tables.leave", { table_id: this.table.id }).catch(() => {});
      this.table.destroy();
      this.table = null;
    }
    this.closeReplay();
    history.replaceState(null, "", "#");
    ({ lobby: () => this.lobby(), profile: () => this.profile(arg), leaderboards: () => this.leaderboards(arg), admin: () => this.admin(),
       invite: () => this.invitePage() })[where]();
  }

  async logout() {
    await this.net.request("account.logout").catch(() => {});
    localStorage.removeItem(this.tokenKey());
    this.dropKey(this.net.welcome?.server_id);     // the server ended it too
    this.account = null;
    this.authScreen("login");
  }

  // ---------------------------------------------------------------- the lobby

  async lobby() {
    const list = h("div.table-list", {}, h("p.muted", {}, "Loading…"));
    const ended = h("div.table-list");
    this.shell("lobby", h("div.lobby", {},
      h("section", {}, h("div.section-head", {}, h("h2", {}, "Tables"), h("button.primary", { onclick: () => this.newTable() }, "New table")), list),
      h("section", {}, h("h2", {}, "Games on this server"), h("div.game-grid", {}, this.games.map((g) => this.gameCard(g)))),
      h("section", {}, h("h2", {}, "Finished tables"), h("p.muted", {}, "Watch a match again: as anyone may now see it, or as you saw it."), ended)));
    const [r, done] = await Promise.all([this.net.request("tables.list"), this.net.request("tables.list", { ended: true })]);
    clear(list, r.tables.length ? r.tables.map((t) => this.tableCard(t)) : h("p.muted", {}, "No tables yet. Start one."));
    clear(ended, done.tables.length ? done.tables.map((t) => this.endedCard(t)) : h("p.muted", {}, "None yet."));
  }

  endedCard(t) {
    const played = t.matches.filter((m) => m.status !== "running");
    return h("article.table-card", {},
      h("div", {}, h("h3", {}, t.name), h("p.muted", {}, `${this.gameName(t.game_id)} · ${played.length} match${played.length === 1 ? "" : "es"} · ${formatTime(t.created_at)}${t.archived ? " · archived" : ""}`)),
      h("div.actions", {}, played.map((m) => h("button", { onclick: () => this.chooseReplay(t.table_id, m.number) }, `Replay match ${m.number}`))));
  }

  /** Pick a view of a match: your own (for each seat you held), or what anyone may see now. */
  async chooseReplay(tableId, number) {
    const r = await this.net.request("replay.matches", { table_id: tableId }).catch((e) => toast(e.message, "warn"));
    const m = r?.matches.find((x) => x.number === number);
    if (!m) return;
    const actions = [["What anyone may see", { view: "released" }, "primary"], ...m.my_seats.map((s) => [`My view (seat ${s})`, { view: "own", seat: s }])];
    actions.push(["Cancel", null]);
    const choice = await dialog(`Match ${number} of ${r.name}`, h("p.muted", {},
      "Anyone may watch what every player saw, plus whatever has been released since. Your own view shows exactly what your seat saw."), actions);
    if (choice) this.openReplay(tableId, number, choice);
  }

  /** Open a match's replay. opts: { view: "own" | "released", seat, timeline, atSequence (the event to open at) }. */
  async openReplay(id, number, opts = {}) {
    if (this.table) {
      this.net.request("tables.leave", { table_id: this.table.id }).catch(() => {});
      this.table.destroy();
      this.table = null;
    }
    this.closeReplay();
    const view = opts.view || "released";
    history.replaceState(null, "", `#replay/${id}/${number}/${view}${view === "own" && opts.seat != null ? `/${opts.seat}` : ""}`);
    const screen = new ReplayScreen(this, id, { ...opts, number, view });
    this.replay = screen;
    clear(this.root, screen.el);
    try {
      await screen.start();
    } catch (e) {
      toast(e.message, "error");
      if (this.replay === screen) this.go("lobby");
    }
  }

  closeReplay() {
    this.replay?.destroy();
    this.replay = null;
  }

  gameCard(g) {
    const players = g.max_players && g.max_players !== g.min_players ? `${g.min_players}–${g.max_players} players` : `${g.min_players} players`;
    return h("article.game-card", {},
      h("h3", {}, g.name, g.dev ? h("span.badge.dev", { title: "In development: loaded without packing, and its tables are never rated" }, "dev") : null),
      h("p.muted", {}, `${players} · ${g.archetype.replace("_", " ")} · v${g.version}`),
      h("p.small", {}, g.mechanics.map((m) => m.mechanic_id).join(", ")),
      h("p.small.muted", {}, `${bytes(g.download_bytes)} to download`),
      h("button", { onclick: () => this.newTable(g) }, "Play"));
  }

  tableCard(t) {
    const seated = t.seats.filter((x) => x.occupied).length;
    const m = t.match || {};
    const status = m.status === "running" ? `match ${m.number} in play` : m.status === "ready_to_end" ? "ready to end" : t.status === "ended" ? "ended" : "in the lobby";
    const mine = t.my_seats.length;
    return h("article.table-card", {},
      h("div", {}, h("h3", {}, t.name, t.dev ? h("span.badge.dev", { title: "A game in development: this table is never rated and keeps no stats on profiles" }, "dev") : null),
        h("p.muted", {}, `${t.game_name} · ${status} · ${seated}/${t.seats.length} seated`),
        h("div.seat-dots", {}, t.seats.map((x) => h("span", { class: x.occupied ? "dot on" : "dot", title: x.name || `seat ${x.seat_id} (empty)` })))),
      h("div.actions", {},
        mine ? h("button.primary", { onclick: () => this.openTable(t.table_id, { view: "both" }) }, "Rejoin") :
          t.seats.some((x) => !x.occupied) ? h("button.primary", { onclick: () => this.openTable(t.table_id, { seat: t.seats.find((x) => !x.occupied).seat_id, view: "both" }) }, "Take a seat") : null,
        h("button", { onclick: () => this.openTable(t.table_id, { view: "table" }) }, "Table view"),
        t.may_close ? h("button.ghost", { onclick: () => this.closeTable(t) }, "Close") : null));
  }

  /** End a table from the lobby (its creator or GM, when no one else is seated and connected; an admin, always). */
  async closeTable(t) {
    const ok = await dialog(`Close ${t.name}?`, h("p", {}, "The table ends for good, and any match in play is abandoned. Its finished matches stay watchable under Finished tables."),
      [["Close the table", true, "danger"], ["Keep it", false]]);
    if (!ok) return;
    try {
      await this.net.request("tables.close", { table_id: t.table_id });
    } catch (e) {
      toast(e.message, "warn");
    }
    this.lobby();
  }

  async newTable(game) {
    game = game || this.games[0];
    const select = h("select", {}, this.games.map((g) => h("option", { value: g.game_id, selected: g.game_id === game.game_id }, g.name)));
    const name = h("input", { type: "text", value: game.name });
    const players = h("input", { type: "number", min: game.min_players || 1, max: game.max_players || 8, value: Math.max(2, game.min_players || 1) });
    const gm = h("input", { type: "checkbox" });
    const bots = h("div.bot-seats");
    const update = () => {
      const g = this.games.find((x) => x.game_id === select.value);
      players.min = g.min_players || 1;
      players.max = g.max_players || 8;
      if (Number(players.value) < players.min) players.value = players.min;
      if (Number(players.value) > players.max) players.value = players.max;
      name.value = g.name;
      clear(bots, Array.from({ length: Math.max(0, Number(players.value) - 1) }, (_, i) =>
        h("label.field.inline", {}, h("span", {}, `Seat ${i + 2 + (gm.checked ? 1 : 0)}`),
          h("select", { dataset: { seat: i + 2 + (gm.checked ? 1 : 0) } }, h("option", { value: "" }, "a person"), (g.bots || []).map((b) => h("option", { value: b }, `bot: ${b}`))))));
    };
    select.addEventListener("change", update);
    players.addEventListener("input", update);
    gm.addEventListener("change", update);
    update();
    const ok = await dialog("A new table", h("div.form", {},
      h("label.field", {}, h("span", {}, "Game"), select),
      h("label.field", {}, h("span", {}, "Table name"), name),
      h("label.field", {}, h("span", {}, "Players"), players),
      h("label.field.inline", {}, gm, h("span", {}, "Add a GM seat (you take it)")),
      h("h4", {}, "Who sits where"), h("p.muted.small", {}, "You take the first seat. Bots are players too: they are rated like anyone."), bots),
      [["Create", true, "primary"], ["Cancel", false]]);
    if (!ok) return;
    try {
      const t = await this.net.request("tables.create", { game_id: select.value, name: name.value, players: Number(players.value), gm: gm.checked });
      await this.openTable(t.table_id, { seat: 1, view: "both" });
      for (const sel of bots.querySelectorAll("select")) {
        if (sel.value) await this.net.request("tables.seat_bot", { table_id: t.table_id, seat: Number(sel.dataset.seat), bot_id: sel.value }).catch((e) => toast(e.message, "warn"));
      }
    } catch (e) {
      toast(e.message, "error");
    }
  }

  /** Open a table, or with `resume` (the screen kept when the connection dropped), go back to it with its state. */
  async openTable(id, opts, resume = null) {
    this.closeReplay();
    if (this.table && this.table !== resume) {
      this.table.destroy();
      this.table = null;
    }
    history.replaceState(null, "", `#table/${id}`);
    let screen = resume?.id === id ? resume : null;
    if (screen) screen.attach(this.net);
    else {
      resume?.destroy();
      screen = new TableScreen(this, id, opts || {});
    }
    this.table = screen;
    clear(this.root, screen.el);
    try {
      await screen.start();
      this.issueKey();                            // a seat keeps a key alive: leaving the last one ends it
    } catch (e) {
      toast(e.message, "error");
      this.go("lobby");
    }
  }

  /**
   * Upload a file to the server in chunks on the bulk channel.
   *
   * @param {File} file the file to upload
   * @param {object} opts more fields for uploads.begin
   * @returns {Promise<object>} the server's answer to uploads.finish
   */
  async upload(file, opts) {
    const bytesIn = new Uint8Array(await file.arrayBuffer());
    let mime = undefined;
    let offset = 0;

    // Name the file by its hash and open the upload.
    const sha = await sha256Hex(bytesIn);
    if (file.type !== "") {
      mime = file.type;
    }
    const begun = await this.net.request(
      "uploads.begin",
      { name: file.name, mime, size: bytesIn.length, sha256: sha, ...opts },
    );
    const id = Uint8Array.from(
      begun.upload_id.match(/../g).map((x) => parseInt(x, 16)),
    );

    // Send the chunks, waiting whenever too much is still buffered.
    while (offset < bytesIn.length) {
      const chunk = bytesIn.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
      const frame = new Uint8Array(UPLOAD_HEADER_BYTES + chunk.length);
      frame[0] = begun.frame_type;
      frame.set(id, 1);
      new DataView(frame.buffer).setBigUint64(17, BigInt(offset));
      frame.set(chunk, UPLOAD_HEADER_BYTES);
      this.net.sendBinary(frame);
      while (this.net.bufferedAmount > UPLOAD_BUFFERED_MAX) {
        await new Promise(
          (resolve) => setTimeout(resolve, UPLOAD_WAIT_MS),
        );
      }
      offset += UPLOAD_CHUNK_BYTES;
    }

    return this.net.request(
      "uploads.finish",
      {
        upload_id: begun.upload_id,
        asset_key: file.name.replace(/\.[^.]+$/, ""),
      },
    );
  }

  // ---------------------------------------------------------------- inviting players (the host's half of the handshake)

  canInvite() {
    return this.account?.is_admin || this.net.welcome?.invites === "players";
  }

  async invitePage(created) {
    const label = h("input", { type: "text", placeholder: "Who is it for? (optional)", maxlength: 64 });
    const responseBox = h("textarea.code", { rows: 4, placeholder: "dny1r.…", spellcheck: "false", autocomplete: "off" });
    const err = h("p.error", { role: "alert" });
    const list = h("div.invite-list");
    const create = async () => {
      try {
        this.invitePage(await this.net.request("invites.create", { label: label.value.trim() || undefined }));
      } catch (e) {
        toast(e.message, "error");
      }
    };
    const accept = async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        const r = await this.net.request("invites.accept", { code: responseBox.value });
        responseBox.value = "";
        toast(`Connecting${r.player ? ` to ${r.player}` : ""}…`);
        refresh();
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
    const copy = async (text, what) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`Copied the ${what}.`);
      } catch {
        toast("Select the text and copy it yourself.", "warn");
      }
    };
    let shown = null;
    if (created) {
      const qr = h("div.qr");
      if (created.qr_svg) qr.innerHTML = created.qr_svg;          // drawn by our own server
      shown = h("section.invite-card", {},
        h("h3", {}, created.label ? `Invite for ${created.label}` : "A new invite"),
        h("p.muted", {}, `Send this to the player, privately: a chat they trust, or show them the QR code. It works once, for ${Math.round(created.time_to_live_seconds / 60)} minutes.`),
        h("div.invite-body", {}, qr, h("div", {},
          h("textarea.code", { rows: 6, readonly: true, spellcheck: "false", onfocus: (e) => e.target.select() }, created.code),
          h("div.row", {}, h("button.primary", { onclick: () => copy(created.code, "invite code") }, "Copy the code"),
            created.link ? h("button", { onclick: () => copy(created.link, "join link") }, "Copy the join link") : null,
            h("span.muted.small", {}, `${created.chars} characters${created.chars > TARGET_CHARS ? " (long for one chat message)" : ""}`),
            created.candidates?.relay ? h("span.muted.small", {}, "· relay ready") : null),
          (created.warnings || []).map((w) => h("p.warn.small", {}, w)))));
    }
    const refresh = async () => {
      if (!list.isConnected && shown) return;
      const r = await this.net.request("invites.list").catch(() => ({ invites: [] }));
      clear(list, r.invites.length ? h("table.admin-table", {}, h("tbody", {}, r.invites.map((i) => h("tr", {},
        h("td", {}, i.label || i.player || i.invite_id), h("td", {}, h("span.status", { class: i.status }, i.status)),
        h("td.muted.small", {}, i.status === "waiting" ? `until ${new Date(i.expires_at * 1000).toLocaleTimeString()}`
          : i.route === "relay" ? "through the relay" : i.route === "direct" ? "direct" : ""),
        h("td", {}, i.status === "waiting" ? h("button.ghost.small", { onclick: async () => { await this.net.request("invites.cancel", { invite_id: i.invite_id }); refresh(); } }, "Cancel") : null)))))
        : h("p.muted", {}, "No invites yet."));
    };
    const keys = h("div.invite-list");
    const endSession = async () => {
      if (!confirm("End the session? Every reconnect key dies, so a player who drops after this needs a new invite.")) return;
      await this.net.request("redial.end_session").catch((e) => toast(e.message, "error"));
      refreshKeys();
    };
    const refreshKeys = async () => {
      const r = await this.net.request("redial.list").catch(() => null);
      if (!r) return clear(keys);
      clear(keys,
        r.available ? null : h("p.warn.small", {}, "Re-dialing is off on this server (redial_port is 0, its port could not be opened, or players connect only through the relay), so a player who drops needs a new invite."),
        r.keys.length ? h("table.admin-table", {}, h("tbody", {}, r.keys.map((k) => h("tr", {},
          h("td", {}, k.label || k.display_name), h("td.muted.small", {}, k.account),
          h("td.muted.small", {}, `last used ${new Date(k.last_used).toLocaleString()}`),
          h("td", {}, h("button.ghost.small", { onclick: async () => { await this.net.request("redial.revoke", { key_id: k.key_id }); refreshKeys(); } }, "Revoke"))))))
          : h("p.muted", {}, "Nobody holds a reconnect key."),
        r.keys.length ? h("button", { onclick: endSession }, "End the session") : null);
    };
    this.shell("invite", h("div.invites", {},
      h("h2", {}, "Invite a player"),
      h("p.muted", {}, "Players join over a direct, encrypted connection. You create an invite, send it to them, and they send a code back. ",
        this.net.welcome?.transport === "webrtc" ? "" : "Each player needs their own invite."),
      h("div.row", {}, label, h("button.primary", { onclick: create }, "Create an invite")),
      shown,
      h("section.invite-card", {}, h("h3", {}, "Their response"),
        h("form", { onsubmit: accept }, responseBox, err, h("button.primary", { type: "submit" }, "Connect"))),
      h("h3", {}, "Invites"), list,
      h("h3", {}, "Reconnect keys"),
      h("p.muted.small", {}, "A player who joined by invite holds one, so a dropped connection comes back without you. ",
        "It ends when they leave their last seat, their table ends, they log out, or you revoke it."),
      keys));
    refresh();
    refreshKeys();
    const poll = setInterval(() => (list.isConnected ? (refresh(), refreshKeys()) : clearInterval(poll)), 2000);
  }

  // ---------------------------------------------------------------- profile and leaderboards

  async profile(accountId) {
    const r = await this.net.request("profile.get", accountId ? { account_id: accountId } : {});
    const me = !accountId || accountId === this.account.id;
    const games = Object.entries(r.ratings);
    const statsBy = {};
    for (const s of r.stats) (statsBy[s.game_id] ??= []).push(s);
    const nameInput = h("input", { value: r.account.display_name });
    this.shell("profile", h("div.profile", {},
      h("h2", {}, r.account.display_name, r.account.is_bot ? h("span.badge", {}, "bot") : null, r.account.is_admin ? h("span.badge", {}, "admin") : null),
      h("p.muted", {}, this.text.t("disclosure.public_ratings_stats")),
      me ? h("details", {}, h("summary", {}, "Account"),
        h("div.form", {},
          h("label.field", {}, h("span", {}, "Display name"), nameInput),
          h("button", { onclick: async () => { this.account = await this.net.request("account.update", { display_name: nameInput.value }); toast("Saved."); } }, "Save"),
          h("button.ghost", { onclick: () => this.changePassword() }, "Change password"))) : null,
      h("h3", {}, "Ratings"),
      games.length ? h("div.rating-grid", {}, games.map(([g, ratings]) => h("article.rating-card", {}, h("h4", {}, this.gameName(g)),
        Object.entries(ratings).map(([k, v]) => h("div.rating-row", {}, h("span.muted", {}, k.split(":")[1].replace(/_/g, " ")), h("b", {}, v.text), h("span.muted.small", {}, `${v.matches} matches`)))))) :
        h("p.muted", {}, "No rated matches yet."),
      h("h3", {}, "Recorded stats"),
      Object.keys(statsBy).length ? Object.entries(statsBy).map(([g, rows]) => h("div.stat-block", {}, h("h4", {}, this.gameName(g)),
        h("table.stats", {}, h("tbody", {}, rows.map((s) => h("tr", {}, h("th", {}, s.name), h("td", {}, s.bucket ? `[${s.bucket}]` : ""), h("td.number", {}, fmt(s.value)), h("td.muted.small", {}, `${s.samples} samples`))))))) :
        h("p.muted", {}, "None yet."),
      r.recent.length ? [h("h3", {}, "Recent matches"), h("ul.recent", {}, r.recent.map((m) => h("li", {}, `${m.table} (${this.gameName(m.game_id)}) · ${m.competitive?.rank ? `placed ${m.competitive.rank}` : "unranked"} · ${formatTime(m.ended_at)} `,
        h("button.ghost.small", { onclick: () => this.chooseReplay(m.table_id, m.number) }, "Replay"))))] : null));
  }

  async changePassword() {
    const old = h("input", { type: "password", autocomplete: "current-password" });
    const neu = h("input", { type: "password", autocomplete: "new-password" });
    const ok = await dialog("Change password", h("div.form", {}, h("label.field", {}, h("span", {}, "Current password"), old),
      h("label.field", {}, h("span", {}, "New password"), neu), h("p.muted.small", {}, "Your other sessions will be logged out.")), [["Change", true, "primary"], ["Cancel", false]]);
    if (ok) this.net.request("account.change_password", { old_password: old.value, new_password: neu.value }).then(() => toast("Password changed."), (e) => toast(e.message, "error"));
  }

  async adminTable(method, t, done) {
    try {
      await this.net.request(method, { table_id: t.table_id });
      toast(done);
      this.admin();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async downloadBundle(t) {
    try {
      const r = await this.net.request("admin.tables.bundle", { table_id: t.table_id });
      const data = Uint8Array.from(atob(r.data_b64), (c) => c.charCodeAt(0));
      const a = h("a", { href: URL.createObjectURL(new Blob([data], { type: r.mime })), download: r.filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  gameName(id) {
    return this.games.find((g) => g.game_id === id)?.name || id;
  }

  async leaderboards(gameId) {
    gameId = gameId || this.games[0]?.game_id;
    const select = h("select", {}, this.games.map((g) => h("option", { value: g.game_id, selected: g.game_id === gameId }, g.name)));
    select.addEventListener("change", () => this.leaderboards(select.value));
    const [board, global] = await Promise.all([this.net.request("leaderboard.get", { game_id: gameId }), this.net.request("stats.global", { game_id: gameId })]);
    const game = this.games.find((g) => g.game_id === gameId);
    this.shell("leaderboards", h("div.boards", {},
      h("div.section-head", {}, h("h2", {}, "Leaderboards"), select),
      board.rows.length ? h("table.board", {}, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Player"), h("th", {}, "Rating"), h("th", {}, "Track"), h("th", {}, "Matches"))),
        h("tbody", {}, board.rows.map((r, i) => h("tr", {}, h("td", {}, i + 1),
          h("td", {}, h("a", { href: "#", onclick: (e) => { e.preventDefault(); this.go("profile", r.account_id); } }, r.account), r.is_bot ? h("span.badge", {}, "bot") : null),
          h("td.number", {}, r.text), h("td.muted", {}, r.track.replace(/_/g, " ")), h("td.number", {}, r.matches))))) : h("p.muted", {}, "No rated matches of this game yet."),
      game?.challenges?.length ? [h("h3", {}, "Challenges"), h("ul", {}, game.challenges.map((c) => h("li", {}, `${c.name}: ${Object.values(c.ratings)[0] ? Math.round(Object.values(c.ratings)[0].value) : "unrated"}`)))] : null,
      global.stats.length ? [h("h3", {}, "Across everyone who plays it"), h("table.stats", {}, h("tbody", {}, global.stats.map((s) =>
        h("tr", {}, h("th", {}, s.key.split(":")[1]), h("td", {}, s.bucket ? `[${s.bucket}]` : ""), h("td.number", {}, fmt(s.value)), h("td.muted", {}, s.holder ? `held by ${s.holder}` : "")))))] : null));
  }

  // ---------------------------------------------------------------- admin

  /**
   * Draw the Admin page: plugins, runtime alerts, automatic play, rating
   * systems, accounts, active tables, ended tables and uploaded media.
   */
  async admin() {
    const methods = [
      "admin.plugins.list",
      "admin.alerts",
      "admin.accounts.list",
      "admin.ratings.list",
      "admin.autoplay.status",
      "admin.media.list",
      "admin.tables.list",
    ];
    let replies = [];
    let ended = null;

    // Ask for everything the page shows.
    replies = await Promise.all(
      methods.map((method) => this.net.request(method)),
    );
    ended = await this.net.request(
      "tables.list",
      { ended: true, include_autoplay: true, limit: 200 },
    );

    // Draw a section for each.
    this.shell(
      "admin",
      h(
        "div.admin",
        {},
        this.adminPlugins(replies[0]),
        this.adminAlerts(replies[1]),
        this.adminAutoplay(replies[4]),
        this.adminRatings(replies[3]),
        this.adminAccounts(replies[2]),
        this.adminActive(replies[6]),
        this.adminEnded(ended),
        this.adminMedia(replies[5]),
      ),
    );
  }

  /**
   * The Plugins section: a rescan button, and a row for each plugin.
   *
   * @param {object} plugins the reply to admin.plugins.list
   * @returns {HTMLElement} the section
   */
  adminPlugins(plugins) {
    const rescan = h(
      "button",
      {
        onclick: async () => {
          await this.net.request("admin.plugins.rescan");
          toast("Rescanned.");
          this.admin();
        },
      },
      "Rescan plugins",
    );
    const rows = plugins.plugins.map((plugin) => this.adminPluginRow(plugin));

    return adminSection(
      "Plugins",
      rescan,
      h("table.admin-table", {}, h("tbody", {}, rows)),
    );
  }

  /**
   * One plugin's row: its id, kind, version and status, a switch for the
   * kinds that can be switched off, and its problems.
   *
   * @param {object} plugin the plugin's report
   * @returns {HTMLElement} the row
   */
  adminPluginRow(plugin) {
    const switchable = ["game", "bundle", "mechanic", "theme"];
    const isLoaded = (plugin.status === "loaded");
    let devBadge = null;
    let toggle = null;
    let toggleText = "Switch on";

    // A badge for a development copy.
    if (plugin.dev) {
      devBadge = h("span.badge.dev", {}, "dev");
    }

    // A switch, for a kind that has one and a plugin that is not broken.
    if (
      (switchable.includes(plugin.kind)) &&
      (plugin.status !== "broken")
    ) {
      if (isLoaded) {
        toggleText = "Switch off";
      }
      toggle = h(
        "button.ghost.small",
        {
          onclick: async () => {
            await this.net.request(
              "admin.plugins.enable",
              {
                kind: plugin.kind,
                id: plugin.plugin_id,
                version: plugin.version,
                enabled: (!isLoaded),
              },
            );
            this.admin();
          },
        },
        toggleText,
      );
    }

    return h(
      "tr",
      { class: plugin.status },
      h("td", {}, plugin.plugin_id, devBadge),
      h("td", {}, plugin.kind),
      h("td", {}, plugin.version),
      h("td", {}, h("span.status", { class: plugin.status }, plugin.status)),
      h("td", {}, toggle),
      h("td.small", {}, plugin.problems.join("; ")),
    );
  }

  /**
   * The Runtime alerts section: the latest 50, newest first.
   *
   * @param {object} alerts the reply to admin.alerts
   * @returns {HTMLElement} the section
   */
  adminAlerts(alerts) {
    let body = h("p.muted", {}, "None.");

    // List the alerts, if there are any.
    if (alerts.alerts.length > 0) {
      body = h(
        "ul.alerts",
        {},
        alerts.alerts.slice(-50).reverse().map(
          (alert) => h("li", {}, h("b", {}, alert.kind), ` ${alert.detail}`),
        ),
      );
    }

    return adminSection("Runtime alerts", body);
  }

  /**
   * The Automatic play section: a form to start a run of bot-only
   * matches, and a row for each run.
   *
   * @param {object} autoplay the reply to admin.autoplay.status
   * @returns {HTMLElement} the section
   */
  adminAutoplay(autoplay) {
    const gameSelect = h(
      "select",
      {},
      this.games.map(
        (game) => h("option", { value: game.game_id }, game.name),
      ),
    );
    const botSeats = h("div.row");
    const count = h("input", { type: "number", value: 20, min: 1, max: 1000 });
    const rows = autoplay.runs.map((run) => this.adminAutoplayRow(run));
    let start = null;

    // Offer a bot for each seat of the chosen game.
    gameSelect.addEventListener(
      "change",
      () => this.adminFillBots(gameSelect, botSeats),
    );
    this.adminFillBots(gameSelect, botSeats);

    // Start a run with the bots chosen.
    start = h(
      "button.primary",
      {
        onclick: async () => {
          const bots = Array.from(
            botSeats.querySelectorAll("select"),
            (select) => select.value,
          );
          try {
            await this.net.request(
              "admin.autoplay.start",
              {
                game_id: gameSelect.value,
                bots,
                matches: Number(count.value),
              },
            );
            toast("Started.");
            this.admin();
          } catch (e) {
            toast(e.message, "error");
          }
        },
      },
      "Start",
    );

    return adminSection(
      "Automatic play",
      h(
        "p.muted",
        {},
        "Seat only bots and let matches play out, to build a rating " +
        "baseline. They count toward ratings like any match.",
      ),
      h(
        "div.row",
        {},
        gameSelect,
        botSeats,
        h("label.field.inline", {}, h("span", {}, "matches"), count),
        start,
      ),
      h("table.admin-table", {}, h("tbody", {}, rows)),
    );
  }

  /**
   * Fill the bot seats with a bot picker for each seat of a game.
   *
   * @param {HTMLSelectElement} gameSelect the picker of the game
   * @param {HTMLElement} botSeats where the bot pickers go
   */
  adminFillBots(gameSelect, botSeats) {
    const game = this.games.find(
      (x) => (x.game_id === gameSelect.value),
    );
    const players = Math.max(2, game.min_players || 1);
    const bots = game.bots || [];
    const seats = Math.min(players, game.max_players || players);
    const pickers = [];

    // One picker for each seat, each starting on the next bot in turn.
    for (let i = 0; i < seats; i++) {
      const options = [];
      for (let j = 0; j < bots.length; j++) {
        options.push(h(
          "option",
          { value: bots[j], selected: (j === (i % bots.length)) },
          bots[j],
        ));
      }
      pickers.push(h("select", { dataset: { i } }, options));
    }
    clear(botSeats, pickers);
  }

  /**
   * One automatic play run's row, with a Stop button while it runs.
   *
   * @param {object} run the run
   * @returns {HTMLElement} the row
   */
  adminAutoplayRow(run) {
    let stop = null;

    // A Stop button, while it runs.
    if (run.status === "running") {
      stop = h(
        "button.ghost.small",
        {
          onclick: async () => {
            await this.net.request(
              "admin.autoplay.stop",
              { run_id: run.run_id },
            );
            this.admin();
          },
        },
        "Stop",
      );
    }

    return h(
      "tr",
      {},
      h("td", {}, `run ${run.run_id}`),
      h("td", {}, run.game_id),
      h("td", {}, run.status),
      h("td", {}, `${run.completed}/${run.requested}`),
      h("td.small.muted", {}, `seed ${run.seed}`),
      h("td", {}, stop),
    );
  }

  /**
   * The Rating systems section: a row for each game and system.
   *
   * @param {object} ratings the reply to admin.ratings.list
   * @returns {HTMLElement} the section
   */
  adminRatings(ratings) {
    const rows = [];

    // A row for each system, under each game.
    for (const game of this.games) {
      for (const system of ratings.systems) {
        rows.push(this.adminRatingRow(game, system, ratings));
      }
    }

    return adminSection(
      "Rating systems",
      h(
        "p.muted",
        {},
        "The only switch for ratings: which systems apply to which " +
        "games. Enabling one rebuilds it over the whole history.",
      ),
      h("table.admin-table", {}, h("tbody", {}, rows)),
    );
  }

  /**
   * One game and rating system's row: whether it is on, a switch, and a
   * Rebuild button while it is on.
   *
   * @param {object} game the game
   * @param {object} system the rating system
   * @param {object} ratings the reply to admin.ratings.list
   * @returns {HTMLElement} the row
   */
  adminRatingRow(game, system, ratings) {
    const row = ratings.enabled.find(
      (e) => (
        (e.game_id === game.game_id) &&
        (e.system_id === system.system_id)
      ),
    );
    const isEnabled = ((row != null) && (row.is_enabled));
    const which = { game_id: game.game_id, system_id: system.system_id };
    let stateText = "off";
    let method = "admin.ratings.enable";
    let switchText = "Switch on (rebuild)";
    let rebuild = null;

    // While it is on: switch it off, or rebuild it.
    if (isEnabled) {
      stateText = "on";
      method = "admin.ratings.disable";
      switchText = "Switch off";
      rebuild = h(
        "button.ghost.small",
        {
          onclick: async () => {
            const reply = await this.net.request(
              "admin.ratings.rebuild",
              which,
            );
            toast(`Rebuilt over ${reply.rebuilt_matches} matches.`);
          },
        },
        "Rebuild",
      );
    }

    return h(
      "tr",
      {},
      h("td", {}, game.name),
      h("td", {}, system.name),
      h("td", {}, stateText),
      h(
        "td",
        {},
        h(
          "button.ghost.small",
          {
            onclick: async () => {
              await this.net.request(method, which);
              this.admin();
            },
          },
          switchText,
        ),
      ),
      h("td", {}, rebuild),
    );
  }

  /**
   * The Accounts section: a form to create one, and a row for each
   * person's account (not the bots').
   *
   * @param {object} accounts the reply to admin.accounts.list
   * @returns {HTMLElement} the section
   */
  adminAccounts(accounts) {
    const newUser = h("input", { placeholder: "username" });
    const newPass = h("input", { type: "password", placeholder: "password" });
    const people = accounts.accounts.filter((account) => (!account.is_bot));
    const rows = people.map((account) => this.adminAccountRow(account));
    let create = null;

    // Create an account from the form.
    create = h(
      "button",
      {
        onclick: async () => {
          try {
            await this.net.request(
              "admin.accounts.create",
              { username: newUser.value, password: newPass.value },
            );
            this.admin();
          } catch (e) {
            toast(e.message, "error");
          }
        },
      },
      "Create account",
    );

    return adminSection(
      "Accounts",
      h("div.row", {}, newUser, newPass, create),
      h("table.admin-table", {}, h("tbody", {}, rows)),
    );
  }

  /**
   * One account's row: its names, whether it is an admin and ignores
   * limits, and buttons to set its password and its limits.
   *
   * @param {object} account the account
   * @returns {HTMLElement} the row
   */
  adminAccountRow(account) {
    let adminText = "";
    let limitsText = "";
    let limitsButton = "Ignore limits";

    // What it is and may do.
    if (account.is_admin) {
      adminText = "admin";
    }
    if (account.bypass_limits) {
      limitsText = "ignores limits";
      limitsButton = "Apply limits";
    }

    return h(
      "tr",
      {},
      h("td", {}, account.username),
      h("td", {}, account.display_name),
      h("td", {}, adminText),
      h("td", {}, limitsText),
      h(
        "td",
        {},
        h(
          "button.ghost.small",
          { onclick: async () => this.adminSetPassword(account) },
          "Set password",
        ),
        h(
          "button.ghost.small",
          {
            onclick: async () => {
              await this.net.request(
                "admin.accounts.set_limits",
                {
                  username: account.username,
                  bypass_limits: (!account.bypass_limits),
                },
              );
              this.admin();
            },
          },
          limitsButton,
        ),
      ),
    );
  }

  /**
   * Ask for an account's new password, and set it.
   *
   * @param {object} account the account
   */
  async adminSetPassword(account) {
    const password = prompt(`New password for ${account.username}?`);

    // Set it, unless the prompt was cancelled or left empty.
    if ((password != null) && (password !== "")) {
      this.net.request(
        "admin.accounts.set_password",
        { username: account.username, password },
      ).then(() => toast("Set."), (e) => toast(e.message, "error"));
    }
  }

  /**
   * The Active tables section: a row for each table that has not ended,
   * loaded or not, to retire it.
   *
   * @param {object} active the reply to admin.tables.list
   * @returns {HTMLElement} the section
   */
  adminActive(active) {
    let body = h("p.muted", {}, "No active tables.");

    // A row for each table, if there are any.
    if (active.tables.length > 0) {
      body = h(
        "table.admin-table",
        {},
        h(
          "tbody",
          {},
          active.tables.map((table) => this.adminActiveRow(table)),
        ),
      );
    }

    return adminSection(
      "Active tables",
      h(
        "p.muted",
        {},
        "Every table that has not ended, including those that could not " +
        "load (usually because their game version is no longer " +
        "installed). Retiring a table ends it: a running match is " +
        "abandoned and nothing is scored. Its log is kept.",
      ),
      body,
    );
  }

  /**
   * One active table's row: its name, game and version, status, creator
   * and date, whether it is loaded or why not, and a Retire button.
   *
   * @param {object} table the table
   * @returns {HTMLElement} the row
   */
  adminActiveRow(table) {
    let notes = `${table.status} · by ${table.created_by || "?"}`;
    let loaded = null;
    let rowClass = "";

    // What kind of table it is, and when it was made.
    if (table.autoplay) {
      notes += " · autoplay";
    }
    if (table.dev) {
      notes += " · dev";
    }
    notes += ` · ${formatTime(table.created_at)}`;

    // Whether it is loaded, or why not.
    if (table.loaded) {
      loaded = "loaded";
    } else {
      rowClass = "broken";
      loaded = h("span.status.broken", {}, table.problem);
    }

    return h(
      "tr",
      { class: rowClass },
      h("td", {}, table.name),
      h("td", {}, `${table.game_id}@${table.game_version}`),
      h("td.small.muted", {}, notes),
      h("td.small", {}, loaded),
      h(
        "td",
        {},
        h(
          "button.ghost.small",
          { onclick: async () => this.adminRetire(table) },
          "Retire",
        ),
      ),
    );
  }

  /**
   * Ask the admin to confirm, then retire a table.
   *
   * @param {object} table the table
   */
  async adminRetire(table) {
    const question = (
      `Retire "${table.name}"? It ends now, and cannot be played again. ` +
      "A running match is abandoned and nothing is scored."
    );

    // Retire it, once confirmed.
    if (confirm(question)) {
      this.adminTable("admin.tables.retire", table, "Retired.");
    }
  }

  /**
   * The Ended tables section: a row for each ended table, to export,
   * download and prune its log.
   *
   * @param {object} ended the reply to tables.list for ended tables
   * @returns {HTMLElement} the section
   */
  adminEnded(ended) {
    let body = h("p.muted", {}, "No ended tables.");

    // A row for each table, if there are any.
    if (ended.tables.length > 0) {
      body = h(
        "table.admin-table",
        {},
        h("tbody", {}, ended.tables.map((table) => this.adminEndedRow(table))),
      );
    }

    return adminSection(
      "Ended tables",
      h(
        "p.muted",
        {},
        "Export an ended table's log to a replay bundle (kept on the " +
        "server, and yours to download), then prune it from the " +
        "database. Results, recorded stats and ratings stay; replays then " +
        "load from the bundle and still follow the table's release rules. " +
        "A pruned table is frozen: what is released stays as it was.",
      ),
      body,
    );
  }

  /**
   * One ended table's row: its name, game, matches and archive state,
   * and the buttons that fit that state.
   *
   * @param {object} table the table
   * @returns {HTMLElement} the row
   */
  adminEndedRow(table) {
    let notes = `${table.matches.length} match(es)`;
    let state = "";
    let exportButton = null;
    let exportText = "Export";
    let download = null;
    let prune = null;

    // What kind of table it was, and how far its log is archived.
    if (table.autoplay) {
      notes += " · autoplay";
    }
    if (table.dev) {
      notes += " · dev";
    }
    if (table.retired) {
      notes += " · retired";
    }
    if (table.archived) {
      state = "archived";
    } else if (table.exported) {
      state = "exported";
    } else {
      state = "";
    }

    // Export, until it is archived.
    if (!table.archived) {
      if (table.exported) {
        exportText = "Export again";
      }
      exportButton = h(
        "button.ghost.small",
        {
          onclick: () => this.adminTable(
            "admin.tables.export",
            table,
            "Exported.",
          ),
        },
        exportText,
      );
    }

    // Download, once exported; prune, once exported and not yet archived.
    if (table.exported) {
      download = h(
        "button.ghost.small",
        { onclick: () => this.downloadBundle(table) },
        "Download",
      );
    }
    if ((table.exported) && (!table.archived)) {
      prune = h(
        "button.ghost.small",
        {
          onclick: async () => {
            if (confirm(
              `Remove the log of "${table.name}" from the database? ` +
              "It stays in its bundle.",
            )) {
              this.adminTable("admin.tables.prune", table, "Pruned.");
            }
          },
        },
        "Prune",
      );
    }

    return h(
      "tr",
      {},
      h("td", {}, table.name),
      h("td", {}, this.gameName(table.game_id)),
      h("td.small.muted", {}, notes),
      h("td", {}, state),
      h("td", {}, exportButton, download, prune),
    );
  }

  /**
   * The Uploaded media section: a row for each file.
   *
   * @param {object} media the reply to admin.media.list
   * @returns {HTMLElement} the section
   */
  adminMedia(media) {
    let body = h("p.muted", {}, "No uploads.");

    // A row for each file, if there are any.
    if (media.media.length > 0) {
      body = h(
        "table.admin-table",
        {},
        h("tbody", {}, media.media.map((file) => this.adminMediaRow(file))),
      );
    }

    return adminSection(
      "Uploaded media",
      h(
        "p.muted",
        {},
        "You can see who uploaded any file, and delete any file. " +
        "Deletion keeps a tombstone.",
      ),
      body,
    );
  }

  /**
   * One uploaded file's row: its hash, type, size and uploader, and a
   * Delete button or who deleted it.
   *
   * @param {object} file the file
   * @returns {HTMLElement} the row
   */
  adminMediaRow(file) {
    let rowClass = "";
    let deleted = null;

    // Who deleted it, or a button to delete it.
    if (file.deleted) {
      rowClass = "deleted";
      deleted = `deleted by ${file.deleted_by}`;
    } else {
      deleted = h(
        "button.ghost.small",
        {
          onclick: async () => {
            if (confirm("Delete this file for everyone?")) {
              await this.net.request(
                "admin.media.delete",
                { hash: file.hash },
              );
              this.admin();
            }
          },
        },
        "Delete",
      );
    }

    return h(
      "tr",
      { class: rowClass },
      h("td.small", {}, file.hash.slice(0, 12)),
      h("td", {}, file.mime),
      h("td", {}, bytes(file.size_bytes)),
      h("td", {}, file.uploaded_by || ""),
      h("td", {}, deleted),
    );
  }
}

async function fetchJSON(url, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * One section of the Admin page: a heading, then its body.
 *
 * @param {string} title the section's heading
 * @param {...*} body what goes under the heading
 * @returns {HTMLElement} the section
 */
function adminSection(title, ...body) {
  return h("section.admin-section", {}, h("h3", {}, title), body);
}

function fmt(v) {
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
}

const app = new App();
window.dionysus = app;
app.start();
