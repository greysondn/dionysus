// A table: the connection gate, the snapshot and its patches, and the three views (table, hand, both).
import { GameLook, refString } from "./layout.js";
import { Projector } from "./projection.js";
import { openDisclosures } from "./disclosures.js";
import { SceneView } from "./scene.js";
import { bytes, clear, dialog, h, s, schemaForm, toast } from "./ui.js";

export const apply = (state, patch) => {
  for (const op of patch) {
    const parts = op.path.split("/");
    let node = state;
    for (const p of parts.slice(0, -1)) {
      if (Array.isArray(node)) node = node[Number(p)];
      else node = node[p] ??= {};
    }
    const key = parts[parts.length - 1];
    if (op.op === "set") {
      if (!("value" in op)) { if (!Array.isArray(node)) delete node[key]; }
      else if (Array.isArray(node)) node[Number(key)] = op.value;
      else node[key] = op.value;
    } else if (op.op === "add") {
      const list = Array.isArray(node) ? node[Number(key)] : (node[key] ??= []);
      list.splice(op.index ?? list.length, 0, op.value);
    } else if (op.op === "remove") {
      const list = Array.isArray(node) ? node[Number(key)] : node[key];
      list.splice(op.index ?? list.length - 1, 1);
    } else if (op.op === "inc") {
      node[key] = (node[key] || 0) + op.by;
    }
  }
};

export class TableScreen {
  constructor(app, tableId, opts) {
    this.app = app;
    this.net = app.net;
    this.text = app.text;
    this.id = tableId;
    this.opts = opts;
    this.look = new GameLook(app.cache, app.text);
    this.look.resolveRemote = (ref) => this.remoteAsset(ref);
    this.sceneView = new SceneView(this, this.look);
    this.projector = new Projector(this);
    this.state = null;
    this.seats = [];
    this.controls = [];
    this.lastSeq = 0;
    this.log = [];
    this.votes = new Map();
    this.view = opts.view || "both";
    this.showGrid = true;
    this.penColor = "#ffd166";
    this.personalMarks = [];
    this.el = h("div.table-screen");
    this.listeners = [];
    this.attach(app.net);
  }

  /** Listen on a connection: the first one, or a new one after the old dropped (the table's state is kept). */
  attach(net) {
    this.detach();
    this.net = net;
    for (const type of ["client_manifest", "fetch_list", "snapshot", "event", "controls", "lobby", "vote_open", "vote_closed",
                        "ephemeral", "notice", "transfer_status", "keys"]) {
      const fn = (ev) => {
        if (ev.detail.table_id && ev.detail.table_id !== this.id) return;
        Promise.resolve(this.on(type, ev.detail)).catch((e) => { console.error(`handling ${type}`, e); toast(`Something went wrong showing the table: ${e.message}`, "error"); });
      };
      this.net.addEventListener(type, fn);
      this.listeners.push([type, fn]);
    }
  }

  detach() {
    for (const [t, fn] of this.listeners) this.net.removeEventListener(t, fn);
    this.listeners = [];
  }

  destroy() {
    this.detach();
    this.projector.leave();
  }

  get seat() { return this.snap?.seat_id ?? null; }
  isGM() { return this.seats.find((x) => x.seat_id === this.seat)?.role === "gm"; }
  seatName(n) {
    const seat = this.seats.find((x) => x.seat_id === Number(n));
    return seat?.account_name || seat?.label || `Seat ${n}`;
  }

  async start() {
    this.gate = h("div.gate", {}, h("h2", {}, "Joining the table…"), h("p.muted", {}, "Checking which files you already have."));
    this.el.replaceChildren(this.gate);
    const res = await this.net.request("tables.join", { table_id: this.id, seat: this.opts.seat, view: this.opts.view });
    this.view = res.view;
    for (const d of res.disclosures || []) toast(this.text.t(d.text), "warn", 9000);
  }

  // ---------------------------------------------------------------- messages from the server

  async on(type, msg) {
    if (type === "client_manifest") return this.onManifest(msg);
    if (type === "fetch_list") return this.onFetch(msg);
    if (type === "transfer_status") return this.onTransfer(msg);
    if (type === "snapshot") return this.onSnapshot(msg);
    if (type === "event") return this.onEvent(msg);
    if (type === "keys") { this.app.cache.setKeys(msg.keys); return; }
    if (type === "controls") { this.controls = msg.controls; this.renderControls(); this.renderHand(); this.renderScene(); return; }
    if (type === "lobby") { this.seats = msg.seats; this.odds = msg.odds; this.status = msg.status; this.renderSeats(); this.renderLobby(); return; }
    if (type === "vote_open") return this.onVote(msg);
    if (type === "vote_closed") { this.votes.get(msg.vote_id)?.close(); this.votes.delete(msg.vote_id); return; }
    if (type === "ephemeral") return this.sceneView.ping(msg);
    if (type === "notice" && msg.code === "tell_admin") toast(this.text.t(msg.text), "warn", 10000);
  }

  async onManifest(m) {
    this.manifest = m;
    if (m.disclosures?.length) await this.app.showDisclosures(m.disclosures);
    const have = await this.app.cache.inventory();
    this.app.cache.pinned = new Set(m.files.map((f) => f.hash));
    this.net.send({ type: "cache_report", table_id: this.id, have });
  }

  async onFetch(f) {
    const total = f.total_bytes;
    let got = 0;
    const bar = h("progress", { max: total || 1, value: 0 });
    const info = h("p.muted", {}, total ? `${bytes(total)} to download${f.rate_bps ? ` at up to ${bytes(f.rate_bps)}/s` : ""}.` : "Everything is already cached.");
    this.rate = h("p.muted.rate");
    clear(this.gate, h("h2", {}, "Fetching the game"), info, bar, this.rate);
    try {
      await Promise.all(f.missing.map((file) => this.app.cache.download(file, (n) => { got += n; bar.value = got; })));
    } catch (e) {
      clear(this.gate, h("h2", {}, "The download failed"), h("p", {}, e.message), h("button", { onclick: () => this.app.openTable(this.id, this.opts) }, "Try again"));
      return;
    }
    if (!this.state) {
      this.net.send({ type: "ready", table_id: this.id });
      return;
    }
    // back after a dropped connection, with the state we had: the server sends only what we missed (or, if it no
    // longer holds that, a snapshot)
    this.net.send({ type: "ready", table_id: this.id, have_seq: this.lastSeq });
    this.layout();
  }

  onTransfer(t) {
    if (this.rate) this.rate.textContent = `${bytes(t.remaining_bytes)} left · ${t.rate_bps ? `${bytes(t.rate_bps)}/s` : "unthrottled"}${t.eta_seconds ? ` · about ${t.eta_seconds}s` : ""}${t.boosted ? " · boosted" : ""}`;
  }

  async onSnapshot(snap) {
    this.snap = snap;
    this.state = snap.state;
    this.seats = snap.seats;
    this.controls = snap.controls;
    this.odds = snap.odds;
    this.lastSeq = snap.as_of_seq;
    this.scene = snap.scene;
    this.display = snap.display || {};
    this.status = snap.table?.status;
    this.app.cache.setKeys(snap.keys);
    this.text.seatName = (n) => this.seatName(n);
    if (!this.lookLoaded) {
      try {
        await this.look.load(this.manifest);
        this.lookLoaded = true;
        this.text.setLayers([{ name: "game", strings: this.look.strings }]);
      } catch (e) {
        toast(`The game's files could not be opened: ${e.message}`, "error", 10000);
      }
    }
    if (this.seat != null && this.feature("marks")) this.net.request("marks.list", { table_id: this.id }).then((r) => { this.personalMarks = r.marks; this.renderScene(); }).catch(() => {});
    this.log = (this.state.messages || []).map((m) => ({ kind: "message", msg: m }));
    for (const v of snap.votes || []) this.onVote(v);
    this.layout();
  }

  onEvent(ev) {
    if (!this.state) return;
    if (ev.prev_seq !== this.lastSeq) {
      this.net.send({ type: "resync", table_id: this.id });        // a gap: the client never reconciles, it resyncs
      return;
    }
    this.lastSeq = ev.seq;
    if (ev.keys) this.app.cache.setKeys(ev.keys);
    const before = this.state.match?.status;
    const scenes = this.state.me?.scene;
    apply(this.state, ev.patch || []);
    for (const op of ev.patch || []) {
      if (op.path === "messages" && op.op === "add") this.log.push({ kind: "message", msg: op.value });
      if (op.path.startsWith("messages") && op.op === "set" && Array.isArray(op.value)) this.log = op.value.map((m) => ({ kind: "message", msg: m }));
    }
    if (ev.announce) {
      const line = this.text.t(ev.announce.text);
      this.log.push({ kind: "announce", text: line, seq: ev.seq, type: ev.event_type });
      if (ev.event_type?.startsWith("vote.") || ev.event_type?.startsWith("match.") || ev.event_type === "core.rejected") toast(line);
    }
    if (ev.cues?.length) this.playCues(ev.cues);
    if (this.state.me?.scene !== scenes) this.app.openTable(this.id, { ...this.opts, view: this.view });
    if ((ev.patch || []).some((op) => op.path.startsWith("settings/features."))) this.layout();   // a panel came or went
    else this.renderAll();
    if (before !== "finished" && this.state.match?.status === "finished") this.showResults();
  }

  onVote(v) {
    if (this.votes.has(v.vote_id)) return;
    const body = h("div", {}, h("p.vote-question", {}, this.text.t(v.question)),
      h("p.muted", {}, v.mode === "unanimous" ? "This needs everyone to agree." : "A majority of the votes cast decides."),
      h("p.muted", {}, "Ballots are sealed: no one learns how you voted, and only pass or fail is announced."));
    const actions = [["Yes", "yes", "primary"], ["No", "no"]];
    if (v.null_allowed) actions.push(["Abstain", "null", "ghost"]);
    let done = false;
    const prom = dialog("A vote", body, actions);
    this.votes.set(v.vote_id, { close: () => { done = true; document.querySelectorAll("dialog[open]").forEach((d) => d.close()); } });
    prom.then((choice) => { if (choice && !done) this.net.send({ type: "ballot", vote_id: v.vote_id, choice }); });
  }

  /** A declared table feature (spec section 5.1): present, or optional and switched on in the lobby. The client draws
   * nothing for a feature the table does not have. */
  feature(name) {
    const declared = this.snap?.game?.feature_states?.[name];
    return declared === "present" || (declared === "optional" && this.state?.settings?.[`features.${name}`] !== false);
  }

  // ---------------------------------------------------------------- acting

  async act(type, params = {}) {
    const ack = await this.net.action(this.id, type, params);
    if (ack.outcome === "rejected") toast(ack.reason || "That was refused.", "warn");
    return ack;
  }

  ephemeral(scene, x, y) {
    if (!this.feature("marks")) return;
    this.net.send({ type: "ephemeral", table_id: this.id, kind: "ping", scene, x, y });
  }

  async commitMark(shape, scene) {
    if (this.markAudience === "self") {
      const r = await this.net.request("marks.put", { table_id: this.id, scene, layer: "annotations", shape });
      this.personalMarks.push({ id: r.id, scene, shape });
    } else {
      await this.act("mark.add", { shape, scene, audience: this.markAudience || "all" });
    }
  }

  async remoteAsset(ref) {
    try {
      const r = await this.net.request("assets.key", { table_id: this.id, asset_ref: ref });
      this.app.cache.setKeys({ [r.hash]: r.key });
      if (!(await this.app.cache.inventory()).includes(r.hash)) await this.app.cache.download(r);
      return { hash: r.hash, mime: r.mime };
    } catch {
      return null;
    }
  }

  // Cues never block play: a missing file is skipped, and a viewer can turn them off.
  async playCues(cues) {
    if (localStorage.getItem("dionysus.cues") === "off") return;
    for (const fire of cues) {
      const cue = (this.look.decl.cues || []).find((c) => c.cue_id === fire.cue_id);
      const slot = cue && (this.look.decl.slots || []).find((sl) => sl.key === cue.slot);
      const ref = refString(slot?.default_asset);
      if (!ref) continue;
      const asset = this.look.assets.get(ref);
      try {
        const url = await this.look.urlFor(ref);
        if (!url) continue;
        if ((asset?.mime || "").startsWith("audio/") || slot.kind === "audio") {
          const audio = new Audio(url);
          audio.volume = Number(localStorage.getItem(`dionysus.volume.${cue.channel || "effects"}`) ?? 0.8);
          audio.play().catch(() => toast("Tap anywhere to let the table play sound.", "info"));
        } else {
          this.sceneView.flash(url, fire.anchor_ref);
        }
      } catch { /* presentation never blocks play */ }
    }
  }

  menu(x, y, items) {
    document.querySelector(".context-menu")?.remove();
    if (!items.length) return;
    const m = h("div.context-menu", { style: { left: `${x}px`, top: `${y}px` } },
      items.map(([label, fn]) => h("button", { onclick: () => { m.remove(); fn(); } }, label)));
    document.body.append(m);
    setTimeout(() => addEventListener("pointerdown", (e) => { if (!m.contains(e.target)) m.remove(); }, { once: true }), 0);
  }

  async speakAs(entity) {
    const input = h("input", { type: "text", placeholder: "What do they say?" });
    const name = h("input", { type: "text", placeholder: "Name (optional)" });
    const ok = await dialog("Speak as a character", h("div", {}, name, input), [["Say it", true, "primary"], ["Cancel", false]]);
    if (ok && input.value.trim()) this.act("msg.send", { kind: "say", privacy: "scene", content: input.value, as_entity: entity, name: name.value || undefined });
  }

  // ---------------------------------------------------------------- layout

  layout() {
    const projecting = this.projecting;
    this.header = h("header.table-head");
    this.seatsEl = h("div.seat-strip");
    this.lobbyEl = h("section.lobby-panel");
    this.controlsEl = h("div.controls");
    this.handEl = h("section.hand-panel");
    this.placesEl = h("section.places-panel");
    this.stateEl = h("section.state-panel");
    this.logEl = h("div.log");
    this.chatEl = this.feature("messages") ? h("section.chat-panel", {}, h("h3", {}, "Table talk"), this.logEl, this.composer())
      : h("section.chat-panel", {}, h("h3", {}, "Table log"), this.logEl);
    const main = h("main.table-main", { class: `view-${this.view}` });
    const side = h("aside.table-side");
    if (this.view === "table") {
      main.append(this.scene ? this.sceneView.el : this.stateEl);
      if (this.scene) side.append(this.stateEl);
      side.append(this.placesEl, this.chatEl);
    } else if (this.view === "hand") {
      main.append(this.lobbyEl, this.controlsEl, this.handEl, this.stateEl, this.placesEl);
      side.append(this.chatEl);
    } else {
      main.append(this.lobbyEl);
      if (this.scene) main.append(this.sceneView.el);
      else main.append(this.stateEl);
      main.append(this.controlsEl, this.handEl);
      if (this.scene) side.append(this.stateEl);
      side.append(this.placesEl, this.chatEl);
    }
    clear(this.el, this.header, this.seatsEl, h("div.table-body", {}, main, side));
    this.renderAll();
    if (projecting) this.enterProjection();
  }

  renderAll() {
    if (!this.state) return;
    this.renderHeader();
    this.renderSeats();
    this.renderLobby();
    this.renderControls();
    this.renderHand();
    this.renderPlaces();
    this.renderState();
    this.renderLog();
    this.renderScene();
  }

  renderScene() {
    if (!this.scene || !this.state) return;
    this.sceneView.setScene(this.scene, this.display);
    this.sceneView.render(this.state);
    if (this.projecting) this.projector.layout();
  }

  renderHeader() {
    const m = this.state.match || {};
    const running = m.status === "running" || m.status === "ready_to_end";
    const g = this.snap.game;
    const status = !m.status ? "In the lobby" : m.status === "running" ? `Match ${m.number} in play` :
      m.status === "ready_to_end" ? `Match ${m.number} is ready to end` : m.status === "finished" ? `Match ${m.number} finished` : `Match ${m.number} abandoned`;
    const viewBtn = (v, label) => h("button", { class: this.view === v ? "seg on" : "seg", onclick: () => this.app.openTable(this.id, { ...this.opts, view: v, seat: v === "table" ? undefined : this.opts.seat }) }, label);
    const tools = [];
    if (running && this.seat != null) {
      if (this.feature("undo")) {
        tools.push(h("button.ghost", { onclick: () => this.act("undo.request"), title: "Undo the last action (by the table's undo rule)" }, "Undo"));
        tools.push(h("button.ghost", { onclick: () => this.act("redo.request") }, "Redo"));
      }
      tools.push(h("button.ghost", { onclick: () => this.act("match.end") }, m.status === "ready_to_end" ? "End match" : "Call match"));
      tools.push(h("button.ghost", { onclick: () => this.act("match.abandon") }, "Abandon"));
    }
    if (this.scene) {
      tools.push(h("button.ghost", { onclick: () => { this.showGrid = !this.showGrid; this.renderScene(); }, title: "Show or hide the grid" }, "Grid"));
      if (this.seat != null && this.feature("marks")) tools.push(h("button.ghost", { class: this.sceneView.tool === "pen" ? "ghost on" : "ghost", onclick: () => { this.sceneView.tool = this.sceneView.tool === "pen" ? "hand" : "pen"; this.renderHeader(); }, title: "Draw on the board" }, "Pen"));
    }
    if (this.view === "table" && this.scene) tools.push(h("button.ghost", { onclick: () => this.enterProjection() }, "Project"));
    tools.push(h("button.ghost", { onclick: () => this.openSettings() }, "Settings"));
    if (this.seat != null && this.feature("journal")) tools.push(h("button.ghost", { onclick: () => this.openJournal() }, "Journal"));
    if (this.isGM()) tools.push(h("button.ghost", { onclick: () => this.openGMTools() }, "GM"));
    if (m.number) tools.push(h("button.ghost", { onclick: () => this.showResults() }, "Results"));
    tools.push(h("button.ghost", { onclick: () => this.app.showDisclosures(null) }, "Disclosures"));
    clear(this.header,
      h("div.title", {}, h("button.back", { onclick: () => this.app.go("lobby"), title: "Back to the tables" }, "←"),
        h("div", {}, h("h1", {}, this.snap.table?.name || g.name), h("p.muted", {}, `${g.name} · ${status}${this.seat != null ? ` · you are ${this.seatName(this.seat)}` : " · table view"}`))),
      h("div.segmented", { role: "group", "aria-label": "View" }, viewBtn("table", "Table"), viewBtn("hand", "Hand"), viewBtn("both", "Both")),
      h("div.tools", {}, tools));
  }

  renderSeats() {
    if (!this.seatsEl) return;
    const turn = this.findTurnSeat();
    clear(this.seatsEl, this.seats.map((seat) => {
      const ratings = Object.entries(seat.ratings || {});
      return h("div.seat-card", { class: [seat.seat_id === this.seat ? "me" : "", seat.seat_id === turn ? "turn" : "", seat.account_name ? "" : "vacant"].join(" ") },
        h("div.seat-name", {}, seat.account_name || "Empty seat", seat.bot_id ? h("span.badge", {}, "bot") : null, seat.role === "gm" ? h("span.badge.gm", {}, "GM") : null),
        h("div.seat-meta", {}, `Seat ${seat.seat_id}${seat.team ? ` · ${seat.team}` : ""}`,
          seat.account_name && !seat.bot_id ? h("span", { class: seat.connected ? "dot on" : "dot", title: seat.connected ? "connected" : "away" }) : null),
        ratings.length ? h("div.seat-rating", { title: ratings.map(([k, v]) => `${k}: ${v.text}`).join("\n") }, ratings[0][1].text) : null,
        !this.state?.match?.status || this.state.match.status === "finished" || this.state.match.status === "abandoned"
          ? h("div.seat-ready", { class: seat.ready ? "yes" : "" }, seat.account_name ? (seat.ready ? "Ready" : "Not ready") : "") : null);
    }));
  }

  findTurnSeat() {
    for (const m of Object.values(this.state?.mech || {})) {
      const t = m?.turn;
      if (t && typeof t.seat === "number") return t.seat;
    }
    return null;
  }

  renderLobby() {
    if (!this.lobbyEl || !this.state) return;
    const m = this.state.match || {};
    const inLobby = !m.status || m.status === "finished" || m.status === "abandoned";
    if (!inLobby || this.view === "table") {
      this.lobbyEl.hidden = true;
      return;
    }
    this.lobbyEl.hidden = false;
    const me = this.seats.find((x) => x.seat_id === this.seat);
    const vacant = this.seats.filter((x) => !x.account_name);
    const manager = this.app.account.is_admin || this.snap.table?.created_by === this.app.account.id || this.isGM();
    const odds = (this.odds || [])[0];
    clear(this.lobbyEl,
      h("h2", {}, m.status === "finished" ? "Play again?" : "Getting ready"),
      h("p.muted", {}, "The match starts the moment every seated player is ready. Changing a setting clears everyone's ready."),
      me ? h("div.row", {},
        h("button", { class: me.ready ? "" : "primary", onclick: () => this.net.request("tables.ready", { table_id: this.id, ready: !me.ready }) }, me.ready ? "I'm not ready" : "I'm ready"),
        this.snap.state.settings["start.mode"] === "gm" && this.isGM() ? h("button.primary", { onclick: () => this.net.request("tables.start", { table_id: this.id }).catch((e) => toast(e.message, "warn")) }, "Start the match") : null,
        h("button.ghost", { onclick: () => this.leaveSeat() }, "Leave my seat")) : null,
      this.variantSection(),
      !me && vacant.length ? h("div.row", {}, vacant.map((v) => h("button.primary", { onclick: () => this.app.openTable(this.id, { seat: v.seat_id, view: "both" }) }, `Take seat ${v.seat_id}`))) : null,
      manager && vacant.length ? h("div.row", {}, h("span.muted", {}, "Seat a bot:"), vacant.map((v) => this.botPicker(v.seat_id))) : null,
      manager ? h("div.row", {}, h("button.ghost", { onclick: () => this.net.request("tables.open_seat", { table_id: this.id, role: "player" }).catch((e) => toast(e.message, "warn")) }, "Open another seat"),
        h("button.ghost", { onclick: () => this.net.request("tables.open_seat", { table_id: this.id, role: "gm", label: "GM" }).catch((e) => toast(e.message, "warn")) }, "Add a GM seat")) : null,
      manager ? h("div.row", {}, this.seats.filter((x) => x.account_name && x.seat_id !== this.seat).map((x) =>
        h("button.ghost.small", { onclick: () => this.net.request("tables.vacate", { table_id: this.id, seat: x.seat_id }).catch((e) => toast(e.message, "warn")) }, `Empty seat ${x.seat_id}`))) : null,
      odds && Object.keys(odds.win_probabilities || {}).length ? h("div.odds", {}, h("h3", {}, "The odds"),
        h("p.muted", {}, `Balance ${Math.round((odds.balance ?? 0) * 100)}% (an even match-up is 100%).`),
        h("ul", {}, Object.entries(odds.win_probabilities).map(([side, p]) => h("li", {}, `${this.sideName(side)}: ${Math.round(p * 100)}% to win`)))) : null);
  }

  /** House rules (spec section 5.2): each variant is a lobby setting, variants.<key>, and its texts are the game's. */
  variantSection() {
    const variants = this.snap.game.variant_decls || [];
    if (!variants.length) return null;
    return h("div.variants", {}, h("h3", {}, "House rules"),
      variants.map((v) => {
        const chosen = this.state.settings?.[`variants.${v.key}`] ?? v.default;
        const select = h("select", { disabled: this.seat == null, "aria-label": this.text.t({ key: v.desc }) },
          v.options.map((o) => h("option", { value: o.key, selected: o.key === chosen }, this.text.t({ key: o.desc }))));
        select.addEventListener("change", () => this.act("settings.change", { key: `variants.${v.key}`, value: select.value }));
        return h("label.field.inline", {}, h("span", {}, this.text.t({ key: v.desc })), select);
      }));
  }

  sideName(side) {
    return side.startsWith("seat") ? this.seatName(Number(side.slice(4))) : side;
  }

  botPicker(seat) {
    const select = h("select", {}, h("option", { value: "" }, `Seat ${seat}…`), (this.app.bots || []).map((b) => h("option", { value: b }, b)));
    select.addEventListener("change", () => select.value && this.net.request("tables.seat_bot", { table_id: this.id, seat, bot_id: select.value }).catch((e) => toast(e.message, "warn")));
    return select;
  }

  async leaveSeat() {
    const ok = await dialog("Leave your seat?", h("p", {}, this.text.t("disclosure.seat_inheritance")), [["Leave", true, "danger"], ["Stay", false]]);
    if (!ok) return;
    await this.net.request("tables.leave", { table_id: this.id, vacate: true });
    this.app.openTable(this.id, { view: "table" });
  }

  renderControls() {
    if (!this.controlsEl) return;
    const buttons = this.controls.filter((c) => !c.interactive);
    const flows = buttons.filter((c) => c.action_type === "flow.step");
    const plain = buttons.filter((c) => c.action_type !== "flow.step");
    if (!buttons.length) {
      clear(this.controlsEl, this.seat != null && this.state.match?.status === "running" ? h("p.muted.waiting", {}, "Waiting for another player…") : null);
      return;
    }
    clear(this.controlsEl,
      plain.map((c) => h("button", { class: c.confirm ? "ghost" : plain.filter((x) => !x.confirm).length <= 3 ? "primary big" : "", disabled: c.enabled === false,
        onclick: () => this.runControl(c) }, this.text.t(c.label))),
      flows.map((c) => h("button.flow", { onclick: () => this.runFlow(c) }, this.text.t(c.label))));
  }

  async runControl(c) {
    const needs = c.params_schema?.required?.filter((k) => !(k in (c.params || {}))) || [];
    if (c.confirm) {
      const ok = await dialog(this.text.t(c.label), h("p", {}, "Are you sure?"), [["Yes", true, "danger"], ["No", false]]);
      if (!ok) return;
    }
    if (needs.length) {
      const form = schemaForm(c.params_schema, c.params, (k) => this.text.t(k));
      const ok = await dialog(this.text.t(c.label), form, [["Do it", true, "primary"], ["Cancel", false]]);
      if (!ok) return;
      return this.act(c.action_type, { ...c.params, ...form.values() });
    }
    return this.act(c.action_type, c.params);
  }

  async runFlow(c) {
    const f = c.flow || {};
    if (f.flow_id === "proposal" && f.kind === "review") return this.reviewProposal(c);
    const body = h("div.flow-step", {},
      f.owner != null ? h("p.muted", {}, `For ${typeof f.owner === "number" ? this.seatName(f.owner) : f.owner}${f.target != null ? `, with ${this.seatName(f.target)}` : ""}`) : null,
      f.params && Object.keys(f.params).length ? h("pre.params", {}, JSON.stringify(f.params, null, 1)) : null,
      Object.keys(f.submissions || {}).length ? h("details", {}, h("summary", {}, "What has been submitted"), h("pre", {}, JSON.stringify(f.submissions, null, 1))) : null,
      Object.keys(f.bids || {}).length ? h("p", {}, `Bids so far: ${Object.entries(f.bids).map(([s2, b]) => `${this.seatName(s2)} ${b}`).join(", ")}`) : null);
    const form = schemaForm(c.params_schema, f.prefill || {}, (k) => this.text.t(k));
    body.append(form);
    const ok = await dialog(this.text.t(c.label), body, [["Submit", true, "primary"], ["Not now", false]]);
    if (ok) this.act("flow.step", { ...c.params, submission: form.values() });
  }

  /** An AI's proposed move, for its supervisor: approve it, deny it, or change it before it is carried out. */
  async reviewProposal(c) {
    const f = c.flow;
    const proposed = f.params?.action || {};
    const who = f.params?.entity || String(f.owner || "").replace(/^ai:/, "");
    const edit = h("textarea.code", { rows: 3, spellcheck: "false" }, JSON.stringify(proposed));
    const body = h("div.flow-step", {},
      h("p", {}, h("b", {}, who), ` (played by ${String(f.owner || "").replace(/^ai:/, "")}) wants to:`),
      h("p.proposal", {}, describeAction(this.text, proposed, (n) => this.seatName(n))),
      h("details", {}, h("summary", {}, "Change it before it happens"),
        h("p.muted.small", {}, "The action the AI will take instead, as JSON (its type and params)."), edit));
    const choice = await dialog("The AI's move", body, [["Approve", "approved", "primary"], ["Change it", "edited"], ["Deny", "denied", "danger"], ["Later", null]]);
    if (!choice) return;
    const submission = { decision: choice };
    if (choice === "edited") {
      try {
        submission.edit = JSON.parse(edit.value);
      } catch {
        return toast("That change is not valid JSON.", "warn");
      }
    }
    return this.act("flow.step", { ...c.params, submission });
  }

  myPlaces() {
    return Object.entries(this.state.places || {}).filter(([pid]) => this.seat != null && pid.endsWith(`.${this.seat}`));
  }

  renderHand() {
    if (!this.handEl) return;
    if (this.view === "table" || this.seat == null) { this.handEl.hidden = true; return; }
    const mine = this.myPlaces().filter(([, c]) => Array.isArray(c));
    if (!mine.length) { this.handEl.hidden = true; return; }
    this.handEl.hidden = false;
    const canPlay = this.controls.some((c) => c.action_type === "tabletop.play");
    clear(this.handEl, mine.map(([pid, ids]) => {
      const decl = (this.look.decl.places || []).find((p) => pid.startsWith(`${p.place_id}.`));
      const sorted = this.sortHand(ids, decl);
      return h("div.hand", {},
        h("div.hand-head", {}, h("h3", {}, decl?.name || pid), h("span.muted", {}, `${ids.length}`),
          decl?.order_by?.length ? h("button.ghost.small", { onclick: () => { this.handSorted = !this.handSorted; this.renderHand(); }, title: "Your arrangement is yours alone, and never logged" }, this.handSorted ? "As dealt" : "Sort") : null),
        h("div.hand-cards", {}, sorted.map((id) => {
          const ent = this.state.entities?.[id];
          if (!ent) return null;
          const { node, w, h: hh } = this.look.drawEntity(ent);
          const svg = s("svg", { viewBox: `0 0 ${w} ${hh}`, class: "card-svg" }, node);
          const card = h("div.hand-card", { draggable: canPlay ? "true" : "false", title: canPlay ? "Drag onto the table (hold Shift for face down), or onto a pile" : "" }, svg);
          card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/x-dionysus-token", id));
          card.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const piles = Object.keys(this.state.places || {}).filter((p) => !p.includes("."));
            this.menu(e.clientX, e.clientY, canPlay ? piles.map((p) => [`Play to ${p}`, () => this.act("tabletop.play", { token: id, to: p })]) : []);
          });
          return card;
        })));
    }));
  }

  sortHand(ids, decl) {
    if (!this.handSorted || !decl?.order_by?.length) return ids;
    const props = (id) => this.look.tokens.get(this.state.entities?.[id]?.kind)?.properties || {};
    return [...ids].sort((a, b) => {
      for (const key of decl.order_by) {
        const va = props(a)[key.property], vb = props(b)[key.property];
        let c = 0;
        if (key.style === "custom") c = key.custom_order.indexOf(va) - key.custom_order.indexOf(vb);
        else if (key.style === "alphabetical") c = String(va).localeCompare(String(vb));
        else c = (va ?? 0) - (vb ?? 0);
        if (key.direction === "desc") c = -c;
        if (c) return c;
      }
      return 0;
    });
  }

  renderPlaces() {
    if (!this.placesEl) return;
    const onScene = new Set((this.scene?.graph?.nodes || []).map((n) => n.place_id).filter(Boolean));
    const rows = Object.entries(this.state.places || {}).filter(([pid]) => !onScene.has(pid) && !(this.seat != null && pid.endsWith(`.${this.seat}`) && this.view !== "table"));
    if (!rows.length) { this.placesEl.hidden = true; return; }
    this.placesEl.hidden = false;
    clear(this.placesEl, h("h3", {}, "On the table"), h("ul.place-list", {}, rows.map(([pid, c]) => {
      const [base, owner] = pid.split(".");
      const decl = (this.look.decl.places || []).find((p) => p.place_id === base);
      const who = owner ? ` · ${this.seatName(owner)}` : "";
      const count = Array.isArray(c) ? c.length : c?.count ?? 0;
      const faces = Array.isArray(c) ? c.map((id) => this.state.entities?.[id]).filter((e) => e && !e.hidden) : [];
      return h("li", {}, h("span", {}, `${decl?.name || base}${who}`), h("span.muted", {}, `${count}`),
        faces.length ? h("div.mini-cards", {}, faces.slice(-8).map((ent) => {
          const { node, w, h: hh } = this.look.drawEntity(ent);
          return s("svg", { viewBox: `0 0 ${w} ${hh}`, class: "mini-card" }, node);
        })) : null);
    })));
  }

  renderState() {
    if (!this.stateEl) return;
    const mech = this.state.mech || {};
    const ids = Object.keys(mech);
    const show = ids.filter((id) => mech[id] && Object.keys(mech[id]).length && !(id === "tabletop.free" && Object.keys(mech[id]).every((k) => ["z", "conceded"].includes(k))));
    const sheets = this.renderSheets();
    if (!show.length && !sheets) { this.stateEl.hidden = true; return; }
    this.stateEl.hidden = false;
    clear(this.stateEl, show.map((id) => h("div.mech", {}, h("h3", {}, this.text.has(`${id}.title`) ? this.text.t(`${id}.title`) : id), this.renderValue(mech[id], id))), sheets);
  }

  /** Every entity with stats, as the server computed them: base values, and derived stats and modifiers' effects
   * with their breakdowns (hover a value to see where it comes from). */
  renderSheets() {
    const decls = Object.fromEntries((this.look.decl.stats || []).map((d) => [d.key, d]));
    const rows = Object.entries(this.state.entities || {}).filter(([, e]) => e && !e.hidden && (e.stats || e.derived));
    if (!rows.length) return null;
    return h("div.mech.sheets", {}, h("h3", {}, "Characters"), rows.map(([id, e]) => {
      const keys = [...new Set([...Object.keys(e.stats || {}), ...Object.keys(e.derived || {})])];
      return h("div.sheet", {}, h("h4", {}, e.name || id),
        h("dl.kv", {}, keys.map((k) => {
          const d = e.derived?.[k];
          const value = d ? d.value : e.stats[k];
          return [h("dt", {}, decls[k]?.name || k.replace(/_/g, " ")),
            h("dd", { class: d ? "derived" : "", title: d ? d.breakdown : "" }, String(value), d && d.breakdown !== `${value} = ${value}` ? h("small.muted.breakdown", {}, ` ${d.breakdown.split(" = ").slice(0, -1).join(" = ")}`) : null)];
        })));
    }));
  }

  renderValue(v, key) {
    const seatKeys = (o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length && Object.keys(o).every((k) => /^\d+$/.test(k) && this.seats.some((x) => String(x.seat_id) === k));
    if (seatKeys(v)) {
      const turn = this.findTurnSeat();
      const entries = Object.entries(v).sort((a, b) => (typeof b[1] === "number" && typeof a[1] === "number" ? b[1] - a[1] : 0));
      return h("table.scoreboard", {}, h("tbody", {}, entries.map(([k, x]) =>
        h("tr", { class: Number(k) === turn ? "turn" : Number(k) === this.seat ? "me" : "" }, h("th", {}, this.seatName(k)), h("td", {}, this.renderValue(x))))));
    }
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "number") && /order|seats/.test(key || "")) return h("span", {}, v.map((n) => this.seatName(n)).join(" → "));
      return h("span", {}, v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", "));
    }
    if (v && typeof v === "object") {
      return h("dl.kv", {}, Object.entries(v).map(([k, x]) => [h("dt", {}, k.replace(/_/g, " ")),
        h("dd", { class: k === "pot" || k === "score" ? "big-number" : "" }, k === "seat" && typeof x === "number" ? this.seatName(x) : this.renderValue(x, k))]));
    }
    return h("span", { class: typeof v === "number" ? "num" : "" }, String(v));
  }

  composer() {
    const kind = h("select", { "aria-label": "Kind" }, ["say", "ooc", "emote", "whisper", "shout", "description", "flavor"].map((k) => h("option", { value: k }, k)));
    const privacy = h("select", { "aria-label": "Who hears it" }, [["all", "everyone"], ["scene", "this scene"], ["party", "my party"], ["named", "chosen seats"], ["gm", "the GM"], ["self", "only me"]]
      .map(([v, l]) => h("option", { value: v }, l)));
    const to = h("input", { type: "text", placeholder: "seats, e.g. 2,3", class: "to", hidden: true });
    privacy.addEventListener("change", () => { to.hidden = privacy.value !== "named"; });
    kind.addEventListener("change", () => { if (kind.value === "whisper") { privacy.value = "named"; to.hidden = false; } });
    const input = h("input", { type: "text", placeholder: this.seat == null ? "The table view cannot speak" : "Say something…", disabled: this.seat == null, maxlength: 4000 });
    const send = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      const params = { kind: kind.value, privacy: privacy.value, content: input.value };
      if (privacy.value === "named") params.to = to.value.split(/[,\s]+/).filter(Boolean).map(Number);
      const ack = await this.act("msg.send", params);
      if (ack.outcome === "accepted") input.value = "";
    };
    return h("form.composer", { onsubmit: send }, h("div.row", {}, kind, privacy, to), h("div.row", {}, input, h("button", { type: "submit", disabled: this.seat == null }, "Send")));
  }

  renderLog() {
    if (!this.logEl) return;
    const atBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
    clear(this.logEl, this.log.slice(-200).map((item) => {
      if (item.kind === "announce") return h("div.log-line.announce", {}, item.text);
      const m = item.msg;
      const who = m.speaker?.kind === "npc" ? (m.speaker.name || "Someone") : m.speaker?.kind === "narrator" ? "" : this.seatName(m.speaker?.seat_id);
      const priv = m.privacy !== "all" ? h("span.priv", {}, m.privacy === "named" ? `to ${(m.audience || []).filter((x) => x !== m.speaker?.seat_id).map((x) => this.seatName(x)).join(", ")}` : m.privacy) : null;
      if (m.kind === "emote") return h("div.log-line.emote", {}, `${who} ${m.content}`, priv);
      if (m.kind === "description" || m.kind === "flavor") return h("div.log-line.narration", {}, m.content || this.text.t(m.text), priv);
      return h("div.log-line", { class: m.kind }, h("b", {}, who), m.kind === "shout" ? " shouts: " : m.kind === "ooc" ? " (ooc): " : ": ", m.content || this.text.t(m.text), priv);
    }));
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ---------------------------------------------------------------- dialogs

  async showResults(number) {
    let r;
    try {
      r = await this.net.request("results.match", { table_id: this.id, number });
    } catch (e) {
      return toast(e.message, "warn");
    }
    const sides = r.result?.competitive?.sides || r.result?.cooperative?.sides || [];
    const placing = (p) => p.competitive || p.cooperative || {};
    const parts = [...r.participants].sort((a, b) => (placing(a).rank ?? 99) - (placing(b).rank ?? 99));
    const body = h("div.results", {},
      !sides.length ? h("p.muted", {}, "No ranking was reported, so no rating changed.") : null,
      h("table.results-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Place"), h("th", {}, "Player"), h("th", {}, "Score"), h("th", {}, "Rating"))),
        h("tbody", {}, parts.map((p) => {
          const pl = placing(p);
          const rating = Object.values(p.ratings || {})[0];
          return h("tr", { class: pl.rank === 1 ? "winner" : "" }, h("td", {}, pl.rank ?? "–"), h("td", {}, p.account), h("td", {}, pl.score ?? pl.side_score ?? "–"), h("td", {}, rating?.text || "–"));
        }))),
      h("h3", {}, "Recorded stats"),
      h("div.stat-grid", {}, parts.map((p) => h("div", {}, h("h4", {}, p.account),
        h("ul", {}, p.stats.filter((x) => !x.bucket).map((x) => h("li", {}, `${x.name}: ${fmtNum(x.value)}`)),
          bucketed(p.stats))))),
      h("p.muted", {}, this.text.t("disclosure.public_ratings_stats")),
      h("div.row", {},
        h("button", { onclick: () => this.replay(r.number, "released") }, "Watch the replay"),
        this.seat != null ? h("button.ghost", { onclick: () => this.replay(r.number, "own") }, "Replay my view") : null,
        h("button.ghost", { onclick: () => openDisclosures(this.app, this.id, r.number, { seatName: (n) => this.seatName(n) }) }, "Hidden data")));
    dialog(`Match ${r.number} results`, body, [["Close", true]]);
  }

  replay(number, view) {
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    this.app.openReplay(this.id, number, { view });
  }

  async openSettings() {
    const r = await this.net.request("tables.settings", { table_id: this.id });
    const lobby = !this.state.match?.status || ["finished", "abandoned"].includes(this.state.match.status);
    const rows = r.settings.map((st) => {
      const locked = st.locked || ((st.mutability === "immutable" || st.lobby_only) && !lobby);
      let input;
      if (st.value_type === "bool") input = h("input", { type: "checkbox", checked: !!st.value, disabled: locked || this.seat == null });
      else if (st.choices) input = h("select", { disabled: locked || this.seat == null }, st.choices.map((c) => h("option", { value: c, selected: c === st.value }, c)));
      else if (["int", "float", "number"].includes(st.value_type)) input = h("input", { type: "number", value: st.value, disabled: locked || this.seat == null });
      else if (["list", "json"].includes(st.value_type)) input = h("textarea", { rows: 1, disabled: locked || this.seat == null }, JSON.stringify(st.value));
      else input = h("input", { type: "text", value: st.value ?? "", disabled: locked || this.seat == null });
      input.addEventListener("change", async () => {
        let value = st.value_type === "bool" ? input.checked : ["int", "float", "number"].includes(st.value_type) ? Number(input.value) :
          ["list", "json"].includes(st.value_type) ? JSON.parse(input.value) : input.value;
        const ack = await this.act("settings.change", { key: st.key, value });
        if (ack.outcome === "accepted") toast(lobby ? "Changed. Everyone's ready was cleared." : (st.change_mode === "rules" ? "Changed." : "Put to a vote."));
      });
      const name = st.desc ? this.text.t({ key: st.desc }) : st.key;
      return h("tr", { class: locked ? "locked" : "" }, h("th", {}, name, h("div.muted.small", {}, `${st.origin || ""}${st.mutability === "immutable" ? " · locks at start" : ""}${st.lobby_only ? " · chosen in the lobby" : ""}${!lobby && st.change_mode !== "rules" ? ` · changes by ${st.change_mode}` : ""}`)), h("td", {}, input));
    });
    const prefs = this.view === "table" ? this.displayPrefs() : null;
    dialog("Table settings", h("div.settings", {}, prefs, h("table.settings-table", {}, h("tbody", {}, rows))), [["Close", true]]);
  }

  displayPrefs() {
    const hide = h("input", { type: "checkbox", checked: !!this.display.hide_outside_safe_zone });
    hide.addEventListener("change", () => { this.display.hide_outside_safe_zone = hide.checked; this.saveDisplay(); this.renderScene(); });
    const color = h("input", { type: "color", value: this.display.tabletop?.color || this.scene?.tabletop?.color || "#000000" });
    color.addEventListener("change", () => { this.display.tabletop = { ...(this.display.tabletop || {}), color: color.value, fit: "tile" }; this.saveDisplay(); this.renderScene(); });
    return h("div.display-prefs", {}, h("h3", {}, "This display"),
      h("label.field.inline", {}, hide, h("span", {}, "Hide everything outside the safe zone (for projecting)")),
      h("label.field.inline", {}, color, h("span", {}, "Tabletop color")),
      h("p.muted", {}, "Display preferences are yours: never logged, saved with your account."));
  }

  saveDisplay() {
    const tv = { ...this.display };
    this.net.request("prefs.set", { table_view: tv }).catch((e) => toast(e.message, "warn"));
  }

  enterProjection() {
    if (!this.scene) return;
    this.projecting = true;
    this.display.projection = { ...(this.display.projection || {}), enabled: true };
    this.app.firstProjection = !this.display.projection.corners?.length;
    this.renderScene();
    this.projector.enter(this.sceneView.el);
  }

  leaveProjection() {
    this.projecting = false;
    this.projector.leave();
    this.layout();
  }

  async openJournal() {
    const r = await this.net.request("journal.list", { table_id: this.id });
    const list = h("div.journal-list", {}, r.entries.map((e) => h("article.journal-entry", {},
      h("header", {}, h("b", {}, `${this.seatName(e.seat)}`), h("span.muted", {}, ` · ${e.visibility}${e.written_by ? ` · by ${e.written_by}` : ""}`)),
      h("p", {}, e.body),
      (e.attachments || []).length ? h("p.muted", {}, `${e.attachments.length} attachment(s)`) : null,
      e.seat === this.seat ? h("button.ghost.small", { onclick: async () => { await this.net.request("journal.delete", { table_id: this.id, id: e.id }); this.openJournal(); } }, "Delete") : null)));
    const body = h("textarea", { rows: 4, placeholder: "A note for your seat's journal…" });
    const vis = h("select", {}, [["self", "only me"], ["gm", "me and the GM"], ["table", "the whole table"], ["named", "chosen seats"], ["party", "my party"]].map(([v, l]) => h("option", { value: v }, l)));
    const ok = await dialog("Journal", h("div", {}, h("p.muted", {}, "Your notes belong to your seat and pass to whoever sits here next. You choose who sees each one."), list, body, h("label.field.inline", {}, h("span", {}, "Who sees it"), vis)),
      [["Add the note", true, "primary"], ["Close", false]]);
    if (ok && body.value.trim()) {
      await this.net.request("journal.put", { table_id: this.id, body: body.value, visibility: vis.value });
      this.openJournal();
    }
  }

  /** Who controls what (spec section 14): an AI behavior, the GM, or a seat, and whether the AI needs approval. */
  controlSection() {
    const behaviors = this.snap.game.ai_behaviors || [];
    const control = this.state.control || {};
    const kinds = [...new Set(Object.values(this.state.entities || {}).map((e) => e?.kind).filter(Boolean))];
    if (!behaviors.length && !Object.keys(control).length) return null;
    const who = (value) => h("select", { "aria-label": "Controller" },
      behaviors.map((b) => h("option", { value: `ai:${b.behavior_id}`, selected: value === `ai:${b.behavior_id}` }, `AI: ${b.name}`)),
      h("option", { value: "gm", selected: value === "gm" }, "The GM"),
      this.seats.filter((s) => s.role === "player").map((s) => h("option", { value: `seat:${s.seat_id}`, selected: value === `seat:${s.seat_id}` }, this.seatName(s.seat_id))));
    const approval = (value) => h("select", { "aria-label": "Approval" },
      h("option", { value: "auto", selected: value !== "required" }, "acts on its own"), h("option", { value: "required", selected: value === "required" }, "the GM approves each move"));
    const row = (scope, c) => {
      const ctl = who(c.controller), appr = approval(c.approval);
      return h("div.control-row", {}, h("b.scope", {}, scope), ctl, appr,
        h("span", {}, h("button.small", { onclick: () => this.act("control.set", { scope, controller: ctl.value, approval: appr.value, supervisor: c.supervisor || "gm" }) }, "Set"),
          h("button.ghost.small", { onclick: () => this.act("control.set", { scope }) }, "Clear")));
    };
    const scope = h("input", { type: "text", placeholder: "an entity id, or kind:<kind>", list: "control-scopes" });
    const newWho = who(), newApproval = approval();
    const blank = h("div.control-row", {},
      scope, h("datalist", { id: "control-scopes" },
        [...Object.keys(this.state.entities || {}), ...kinds.map((k) => `kind:${k}`)].map((v) => h("option", { value: v }))),
      newWho, newApproval,
      h("span", {}, h("button.small", { onclick: () => scope.value.trim() && this.act("control.set", { scope: scope.value.trim(), controller: newWho.value, approval: newApproval.value }) }, "Add")));
    return [h("h3", {}, "Control"),
      h("p.muted", {}, "Who plays each character or piece: an AI, you, or a player. An AI acts whenever the rules give it a move; with approval, each move waits for you."),
      h("div.control-list", {}, Object.entries(control).map(([s, c]) => row(s, c)), blank)];
  }

  /** Modifiers (spec section 19.1): bonuses and penalties on an entity's stat, from a source, for a while. A secret
   * one changes the stat only for those who may see it. */
  modifierSection() {
    const decls = this.look.decl.stats || [];
    const ents = Object.entries(this.state.entities || {}).filter(([, e]) => e && !e.hidden && (e.stats || e.derived));
    if (!ents.length) return null;
    const mods = Object.entries(this.state.modifiers || {});
    const entity = h("select", { "aria-label": "Entity" }, ents.map(([id, e]) => h("option", { value: id }, e.name || id)));
    const stat = h("select", { "aria-label": "Stat" }, decls.map((d) => h("option", { value: d.key }, d.name || d.key)));
    const op = h("select", { "aria-label": "Operation" }, [["add", "add"], ["multiply", "multiply by"], ["set", "set to"], ["cap_max", "at most"], ["cap_min", "at least"]]
      .map(([v, l]) => h("option", { value: v }, l)));
    const value = h("input", { type: "number", value: 1, step: "any", "aria-label": "Value", class: "short" });
    const label = h("input", { type: "text", placeholder: "what it is (a blessing)", "aria-label": "Label" });
    const secret = h("input", { type: "checkbox" });
    const name = (id) => this.state.entities?.[id]?.name || id;
    return [h("h3", {}, "Modifiers"),
      h("p.muted", {}, "A bonus or penalty on a stat. A secret one changes the stat only for you; the players see neither it nor its effect."),
      mods.length ? h("div.control-list", {}, mods.map(([mid, m]) => h("div.control-row", {},
        h("b.scope", {}, m.label || m.source), h("span", {}, `${name(m.entity)} · ${m.stat} ${m.op === "add" && m.value >= 0 ? "+" : ""}${m.op === "add" ? m.value : `${m.op} ${m.value}`}`),
        m.audience && m.audience !== "all" ? h("span.badge", {}, "secret") : null,
        m.duration?.kind && m.duration.kind !== "permanent" ? h("span.muted.small", {}, m.duration.kind === "until_clock" ? `until ${m.duration.clock_key} ${m.duration.until}` : m.duration.kind.replace("_", " ")) : null,
        h("button.ghost.small", { onclick: () => this.act("modifier.remove", { modifier: mid }) }, "Remove")))) : null,
      h("div.control-row", {}, entity, stat, op, value, label, h("label.field.inline", {}, secret, h("span", {}, "secret")),
        h("button.small", { onclick: () => this.act("modifier.add", { entity: entity.value, stat: stat.value, op: op.value, value: Number(value.value),
          label: label.value.trim() || undefined, source: label.value.trim() || "gm", audience: secret.checked ? "gm" : "all" }) }, "Add"))];
  }

  async openGMTools() {
    const assets = this.feature("media") || this.feature("handouts") ? (await this.net.request("assets.list", { table_id: this.id })).assets : [];
    const file = h("input", { type: "file" });
    const pick = h("select", {}, assets.map((a) => h("option", { value: a.asset_ref }, `${a.name} (${a.pool})`)));
    const shows = Object.entries(this.state.stage || {});
    const media = this.feature("media"), handouts = this.feature("handouts");
    const body = h("div.gm-tools", {},
      media || handouts ? [h("h3", {}, "Media"),
        h("p.muted", {}, `Upload to this table's pool, then ${media && handouts ? "show it on the stage or hand it out" : media ? "show it on the stage" : "hand it out"}.`),
        h("div.row", {}, file, h("button", { onclick: async () => { if (file.files[0]) { await this.app.upload(file.files[0], { pool: "table", table_id: this.id }); toast("Uploaded."); document.querySelector("dialog[open]")?.close(); this.openGMTools(); } } }, "Upload")),
        assets.length ? h("div.row", {}, pick,
          media ? h("button", { onclick: () => this.act("media.show", { asset: pick.value, audience: "all" }) }, "Show to everyone") : null,
          handouts ? h("button", { onclick: () => this.act("handout.give", { asset: pick.value, audience: "all" }) }, "Hand out") : null,
          media ? h("button.ghost", { onclick: () => this.act("ambience.set", { channel: "music", asset: pick.value, loop: true }) }, "Play as music") : null) : h("p.muted", {}, "No media yet."),
        shows.length ? h("div.row", {}, shows.map(([id]) => h("button.ghost", { onclick: () => this.act("media.hide", { id }) }, `Hide shown item ${id}`))) : null] : null,
      this.feature("control") ? this.controlSection() : null,
      this.feature("modifiers") ? this.modifierSection() : null,
      this.feature("timelines") ? [h("h3", {}, "Timelines"),
        h("p.muted", {}, `This line: ${this.state.me?.timeline}. Fork a new line from now, or move seats between lines.`),
        h("div.row", {}, h("button.ghost", { onclick: async () => { const key = prompt("Name for the new line?"); if (key) this.act("timeline.fork", { key, from: this.state.me?.timeline }); } }, "Fork a line"))] : null,
      h("h3", {}, "Votes"),
      h("p.muted", {}, "Force an open vote closed (missing ballots count as abstentions); the log records that you did."),
      h("div.row", {}, [...this.votes.keys()].map((id) => h("button.ghost", { onclick: () => this.act("vote.force", { vote_id: id }) }, `Close vote ${id}`))));
    dialog("GM tools", body, [["Close", true]]);
  }
}

function describeAction(text, action, seatName) {
  const params = action.params || {};
  const label = text.has(`${action.type}`) ? text.t({ key: action.type, params }) : action.type;
  const parts = Object.entries(params).map(([k, v]) => `${k.replace(/_/g, " ")}: ${k === "target" || k === "seat" ? `${seatName(v)} (seat ${v})` : JSON.stringify(v)}`);
  return `${label}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function fmtNum(v) {
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
}

function bucketed(stats) {
  const byKey = {};
  for (const x of stats.filter((x) => x.bucket)) (byKey[x.name] ??= []).push(x);
  return Object.entries(byKey).map(([name, rows]) => {
    const max = Math.max(...rows.map((r) => r.value), 1);
    return h("li.bucketed", {}, h("div", {}, name), h("div.bars", {}, rows.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket), undefined, { numeric: true }))
      .map((r) => h("div.bar", { title: `${r.bucket}: ${r.value}` }, h("span", { style: { height: `${(r.value / max) * 100}%` } }), h("small", {}, r.bucket)))));
  });
}
