// The client shell: a connection, a file cache, text, and the screens. It runs no game code: everything game-
// specific arrives as data (layouts, templates, controls, text keys) and is drawn by the generic renderer.
import { FileCache } from "./cache.js";
import { CodeError, TARGET_CHARS, decode } from "./handshake.js";
import { Net } from "./net.js";
import { ReplayScreen } from "./replay.js";
import { TableScreen } from "./table.js";
import { Text } from "./text.js";
import { bytes, clear, dialog, fmtTime, h, toast } from "./ui.js";

const TOKEN = "dionysus.session";               // one session per server: dionysus.session.<server_id>
const KEY = "dionysus.redial";                  // a reconnect key and the details to re-dial, per server: dionysus.redial.<server_id>
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
    // carry on numbering actions where the last connection stopped: the server answers a client_seq it has seen with
    // that action's ack (a retry), so a new connection must not reuse one
    if (this.net) net.clientSeq = Math.max(net.clientSeq, this.net.clientSeq);
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
    this.bots = games.bots;
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
      h("div", {}, h("h3", {}, t.name), h("p.muted", {}, `${this.gameName(t.game_id)} · ${played.length} match${played.length === 1 ? "" : "es"} · ${fmtTime(t.created_at)}${t.archived ? " · archived" : ""}`)),
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

  /** Open a match's replay. opts: { view: "own" | "released", seat, timeline, atSeq (the event to open at) }. */
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
      h("h3", {}, g.name), h("p.muted", {}, `${players} · ${g.archetype.replace("_", " ")} · v${g.version}`),
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
      h("div", {}, h("h3", {}, t.name), h("p.muted", {}, `${t.game_name} · ${status} · ${seated}/${t.seats.length} seated`),
        h("div.seat-dots", {}, t.seats.map((x) => h("span", { class: x.occupied ? "dot on" : "dot", title: x.name || `seat ${x.seat_id} (empty)` })))),
      h("div.actions", {},
        mine ? h("button.primary", { onclick: () => this.openTable(t.table_id, { view: "both" }) }, "Rejoin") :
          t.seats.some((x) => !x.occupied) ? h("button.primary", { onclick: () => this.openTable(t.table_id, { seat: t.seats.find((x) => !x.occupied).seat_id, view: "both" }) }, "Take a seat") : null,
        h("button", { onclick: () => this.openTable(t.table_id, { view: "table" }) }, "Table view")));
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
          h("select", { dataset: { seat: i + 2 + (gm.checked ? 1 : 0) } }, h("option", { value: "" }, "a person"), this.bots.map((b) => h("option", { value: b }, `bot: ${b}`))))));
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

  async upload(file, opts) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
    const r = await this.net.request("uploads.begin", { name: file.name, mime: file.type || undefined, size: buf.length, sha256: sha, ...opts });
    const id = Uint8Array.from(r.upload_id.match(/../g).map((x) => parseInt(x, 16)));
    for (let off = 0; off < buf.length; off += 16384) {
      const chunk = buf.subarray(off, off + 16384);
      const frame = new Uint8Array(25 + chunk.length);
      frame[0] = r.frame_type;
      frame.set(id, 1);
      new DataView(frame.buffer).setBigUint64(17, BigInt(off));
      frame.set(chunk, 25);
      this.net.sendBinary(frame);
      while (this.net.bufferedAmount > 1 << 20) await new Promise((res) => setTimeout(res, 20));
    }
    return this.net.request("uploads.finish", { upload_id: r.upload_id, asset_key: file.name.replace(/\.[^.]+$/, "") });
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
        h("p.muted", {}, `Send this to the player, privately: a chat they trust, or show them the QR code. It works once, for ${Math.round(created.ttl_seconds / 60)} minutes.`),
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
        h("table.stats", {}, h("tbody", {}, rows.map((s) => h("tr", {}, h("th", {}, s.name), h("td", {}, s.bucket ? `[${s.bucket}]` : ""), h("td.num", {}, fmt(s.value)), h("td.muted.small", {}, `${s.samples} samples`))))))) :
        h("p.muted", {}, "None yet."),
      r.recent.length ? [h("h3", {}, "Recent matches"), h("ul.recent", {}, r.recent.map((m) => h("li", {}, `${m.table} (${this.gameName(m.game_id)}) · ${m.competitive?.rank ? `placed ${m.competitive.rank}` : "unranked"} · ${fmtTime(m.ended_at)} `,
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
          h("td.num", {}, r.text), h("td.muted", {}, r.track.replace(/_/g, " ")), h("td.num", {}, r.matches))))) : h("p.muted", {}, "No rated matches of this game yet."),
      game?.challenges?.length ? [h("h3", {}, "Challenges"), h("ul", {}, game.challenges.map((c) => h("li", {}, `${c.name}: ${Object.values(c.ratings)[0] ? Math.round(Object.values(c.ratings)[0].value) : "unrated"}`)))] : null,
      global.stats.length ? [h("h3", {}, "Across everyone who plays it"), h("table.stats", {}, h("tbody", {}, global.stats.map((s) =>
        h("tr", {}, h("th", {}, s.key.split(":")[1]), h("td", {}, s.bucket ? `[${s.bucket}]` : ""), h("td.num", {}, fmt(s.value)), h("td.muted", {}, s.holder ? `held by ${s.holder}` : "")))))] : null));
  }

  // ---------------------------------------------------------------- admin

  async admin() {
    const [plugins, alerts, accounts, ratings, autoplay, media] = await Promise.all(["admin.plugins.list", "admin.alerts", "admin.accounts.list",
      "admin.ratings.list", "admin.autoplay.status", "admin.media.list"].map((m) => this.net.request(m)));
    const ended = await this.net.request("tables.list", { ended: true, include_autoplay: true, limit: 200 });
    const section = (title, ...body) => h("section.admin-section", {}, h("h3", {}, title), body);
    const gameSel = h("select", {}, this.games.map((g) => h("option", { value: g.game_id }, g.name)));
    const botSeats = h("div.row");
    const fillBots = () => {
      const g = this.games.find((x) => x.game_id === gameSel.value);
      const n = Math.max(2, g.min_players || 1);
      clear(botSeats, Array.from({ length: Math.min(n, g.max_players || n) }, (_, i) =>
        h("select", { dataset: { i } }, this.bots.map((b, j) => h("option", { value: b, selected: j === i % this.bots.length }, b)))));
    };
    gameSel.addEventListener("change", fillBots);
    fillBots();
    const count = h("input", { type: "number", value: 20, min: 1, max: 1000 });
    const newUser = h("input", { placeholder: "username" });
    const newPass = h("input", { type: "password", placeholder: "password" });
    this.shell("admin", h("div.admin", {},
      section("Plugins",
        h("button", { onclick: async () => { await this.net.request("admin.plugins.rescan"); toast("Rescanned."); this.admin(); } }, "Rescan plugins"),
        h("table.admin-table", {}, h("tbody", {}, plugins.plugins.map((p) => h("tr", { class: p.status }, h("td", {}, p.plugin_id), h("td", {}, p.kind), h("td", {}, p.version),
          h("td", {}, h("span.status", { class: p.status }, p.status)),
          h("td", {}, ["game", "mechanic", "theme"].includes(p.kind) && p.status !== "broken" ? h("button.ghost.small", { onclick: async () => {
            await this.net.request("admin.plugins.enable", { kind: p.kind, id: p.plugin_id, version: p.version, enabled: p.status !== "loaded" }); this.admin(); } }, p.status === "loaded" ? "Switch off" : "Switch on") : null),
          h("td.small", {}, p.problems.join("; "))))))),
      section("Runtime alerts", alerts.alerts.length ? h("ul.alerts", {}, alerts.alerts.slice(-50).reverse().map((a) => h("li", {}, h("b", {}, a.kind), ` ${a.detail}`))) : h("p.muted", {}, "None.")),
      section("Automatic play",
        h("p.muted", {}, "Seat only bots and let matches play out, to build a rating baseline. They count toward ratings like any match."),
        h("div.row", {}, gameSel, botSeats, h("label.field.inline", {}, h("span", {}, "matches"), count),
          h("button.primary", { onclick: async () => {
            const bots = Array.from(botSeats.querySelectorAll("select"), (s) => s.value);
            try { await this.net.request("admin.autoplay.start", { game_id: gameSel.value, bots, matches: Number(count.value) }); toast("Started."); this.admin(); } catch (e) { toast(e.message, "error"); }
          } }, "Start")),
        h("table.admin-table", {}, h("tbody", {}, autoplay.runs.map((r) => h("tr", {}, h("td", {}, `run ${r.run_id}`), h("td", {}, r.game_id), h("td", {}, r.status),
          h("td", {}, `${r.completed}/${r.requested}`), h("td.small.muted", {}, `seed ${r.seed}`),
          h("td", {}, r.status === "running" ? h("button.ghost.small", { onclick: async () => { await this.net.request("admin.autoplay.stop", { run_id: r.run_id }); this.admin(); } }, "Stop") : null)))))),
      section("Rating systems",
        h("p.muted", {}, "The only switch for ratings: which systems apply to which games. Enabling one rebuilds it over the whole history."),
        h("table.admin-table", {}, h("tbody", {}, this.games.flatMap((g) => ratings.systems.map((sys) => {
          const row = ratings.enabled.find((e) => e.game_id === g.game_id && e.system_id === sys.system_id);
          return h("tr", {}, h("td", {}, g.name), h("td", {}, sys.name), h("td", {}, row?.is_enabled ? "on" : "off"),
            h("td", {}, h("button.ghost.small", { onclick: async () => {
              await this.net.request(row?.is_enabled ? "admin.ratings.disable" : "admin.ratings.enable", { game_id: g.game_id, system_id: sys.system_id }); this.admin(); } }, row?.is_enabled ? "Switch off" : "Switch on (rebuild)")),
            h("td", {}, row?.is_enabled ? h("button.ghost.small", { onclick: async () => { const r = await this.net.request("admin.ratings.rebuild", { game_id: g.game_id, system_id: sys.system_id }); toast(`Rebuilt over ${r.rebuilt_matches} matches.`); } }, "Rebuild") : null));
        }))))),
      section("Accounts",
        h("div.row", {}, newUser, newPass, h("button", { onclick: async () => { try { await this.net.request("admin.accounts.create", { username: newUser.value, password: newPass.value }); this.admin(); } catch (e) { toast(e.message, "error"); } } }, "Create account")),
        h("table.admin-table", {}, h("tbody", {}, accounts.accounts.filter((a) => !a.is_bot).map((a) => h("tr", {}, h("td", {}, a.username), h("td", {}, a.display_name),
          h("td", {}, a.is_admin ? "admin" : ""), h("td", {}, a.bypass_limits ? "ignores limits" : ""),
          h("td", {}, h("button.ghost.small", { onclick: async () => { const p = prompt(`New password for ${a.username}?`); if (p) this.net.request("admin.accounts.set_password", { username: a.username, password: p }).then(() => toast("Set."), (e) => toast(e.message, "error")); } }, "Set password"),
            h("button.ghost.small", { onclick: async () => { await this.net.request("admin.accounts.set_limits", { username: a.username, bypass_limits: !a.bypass_limits }); this.admin(); } }, a.bypass_limits ? "Apply limits" : "Ignore limits"))))))),
      section("Ended tables",
        h("p.muted", {}, "Export an ended table's log to a replay bundle (kept on the server, and yours to download), then prune it from the database. Results, recorded stats and ratings stay; replays then load from the bundle and still follow the table's release rules. A pruned table is frozen: what is released stays as it was."),
        ended.tables.length ? h("table.admin-table", {}, h("tbody", {}, ended.tables.map((t) => h("tr", {},
          h("td", {}, t.name), h("td", {}, this.gameName(t.game_id)), h("td.small.muted", {}, `${t.matches.length} match(es)${t.autoplay ? " · autoplay" : ""}`),
          h("td", {}, t.archived ? "archived" : t.exported ? "exported" : ""),
          h("td", {},
            !t.archived ? h("button.ghost.small", { onclick: () => this.adminTable("admin.tables.export", t, "Exported.") }, t.exported ? "Export again" : "Export") : null,
            t.exported ? h("button.ghost.small", { onclick: () => this.downloadBundle(t) }, "Download") : null,
            t.exported && !t.archived ? h("button.ghost.small", { onclick: async () => { if (confirm(`Remove the log of "${t.name}" from the database? It stays in its bundle.`)) this.adminTable("admin.tables.prune", t, "Pruned."); } }, "Prune") : null)))))
          : h("p.muted", {}, "No ended tables.")),
      section("Uploaded media",
        h("p.muted", {}, "You can see who uploaded any file, and delete any file. Deletion keeps a tombstone."),
        media.media.length ? h("table.admin-table", {}, h("tbody", {}, media.media.map((f) => h("tr", { class: f.deleted ? "deleted" : "" }, h("td.small", {}, f.hash.slice(0, 12)), h("td", {}, f.mime), h("td", {}, bytes(f.size_bytes)),
          h("td", {}, f.uploaded_by || ""), h("td", {}, f.deleted ? `deleted by ${f.deleted_by}` : h("button.ghost.small", { onclick: async () => { if (confirm("Delete this file for everyone?")) { await this.net.request("admin.media.delete", { hash: f.hash }); this.admin(); } } }, "Delete")))))) : h("p.muted", {}, "No uploads."))));
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

function fmt(v) {
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
}

const app = new App();
window.dionysus = app;
app.start();
