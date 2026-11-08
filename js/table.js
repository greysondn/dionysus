// A table: the connection gate, the snapshot and its patches, and the three views (table, hand, both).
import { animationOf } from "./animation.js";
import { GameLook, referenceString } from "./layout.js";
import { Projector } from "./projection.js";
import { openDisclosures } from "./disclosures.js";
import { exportsFor, openExport } from "./export.js";
import { handDropPlace, newArrivals } from "./hand.js";
import { openNotation } from "./notation.js";
import { matSeats } from "./placemats.js";
import {
  mayEdit,
  seatValue,
  sheetRows,
  shownIn,
  signed,
  valueDeclarations,
  valueTextKey,
} from "./seatvalues.js";
import { openLook } from "./look.js";
import { ViewerPreferences } from "./preferences.js";
import { SIDE_TURNS, SIDES, sideFor } from "./facing.js";
import { myPending, othersPending } from "./pending.js";
import {
  cameToMe,
  chime,
  chimeIsOn,
  keepsTurn,
  setChime,
  turnSeat,
} from "./turn.js";
import { channelVolume, focusStar, playMedia, SceneView } from "./scene.js";
import { apply } from "./patch.js";
import { bytes, clear, dialog, h, s, schemaForm, toast } from "./ui.js";

/** How long a card that just came into the viewer's hand stays marked. */
const NEW_CARD_MS = 10000;

/** Where this browser keeps whether the header is tucked away. */
const TUCKED_KEY = "dionysus.headerTucked";

export class TableScreen {
  constructor(app, tableId, opts) {
    this.app = app;
    this.net = app.net;
    this.text = app.text;
    this.id = tableId;
    this.opts = opts;
    this.look = new GameLook(app.cache, app.text);
    this.look.resolveRemote = (reference) => this.remoteAsset(reference);
    this.viewerPreferences = new ViewerPreferences(app.net, tableId);     // every viewer choice at this table, in one place
    this.viewerPreferences.addEventListener("change", (e) => this.onPreferencesChange(e.detail.what));
    this.sceneView = new SceneView(this, this.look);
    this.projector = new Projector(this);
    this.state = null;
    this.seats = [];
    this.controls = [];
    this.lastSequence = 0;
    this.log = [];
    this.votes = new Map();
    this.view = opts.view || "both";
    this.showGrid = true;
    this.penColor = "#ffd166";
    this.personalMarks = [];
    this.cueQueue = [];              // visual cues waiting their turn, for this viewer only
    this.cueNow = null;
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
    if (type === "lobby") {
      const ended = msg.status === "ended" && this.status !== "ended";
      this.seats = msg.seats; this.odds = msg.odds; this.status = msg.status;
      this.renderSeats(); this.renderLobby();
      if (ended) { this.renderHeader(); toast("This table has ended."); }
      return;
    }
    if (type === "vote_open") return this.onVote(msg);
    if (type === "vote_closed") { this.votes.get(msg.vote_id)?.close(); this.votes.delete(msg.vote_id); return; }
    if (type === "ephemeral") return this.sceneView.ping(msg);
    if (type === "notice" && msg.code === "tell_admin") toast(this.text.t(msg.text), "warn", 10000);
  }

  async onManifest(m) {
    // a manifest with other files while we play (the table chose an expansion in the lobby): the look is loaded again
    const files = (x) => JSON.stringify((x?.files || []).map((f) => f.hash).sort());
    if (this.state && files(m) !== files(this.manifest)) this.lookLoaded = false;
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
    if (!this.state || !this.lookLoaded) {        // a snapshot loads the look (again, if the game's files changed)
      this.net.send({ type: "ready", table_id: this.id });
      return;
    }
    // back after a dropped connection, with the state we had: the server sends only what we missed (or, if it no
    // longer holds that, a snapshot)
    this.net.send({ type: "ready", table_id: this.id, have_sequence: this.lastSequence });
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
    this.lastSequence = snap.as_of_sequence;
    this.scene = snap.scene;
    this.display = snap.display || {};
    this.status = snap.table?.status;
    this.app.cache.setKeys(snap.keys);
    this.text.seatName = (n) => this.seatName(n);
    if (!this.lookLoaded) {
      try {
        await this.look.load(this.manifest);
        this.lookLoaded = true;
        this.setTextLayers();
        this.loadViewerPreferences().catch(() => {});
      } catch (e) {
        toast(`The game's files could not be opened: ${e.message}`, "error", 10000);
      }
    }
    if (this.seat != null && this.feature("marks")) this.net.request("marks.list", { table_id: this.id }).then((r) => { this.personalMarks = r.marks; this.renderScene(); }).catch(() => {});
    this.log = (this.state.messages || []).map((m) => ({ kind: "message", msg: m }));
    for (const v of snap.votes || []) this.onVote(v);
    this.layout();
  }

  /**
   * Take one event from the server: apply it when it follows the last one,
   * or ask for a fresh snapshot when there is a gap.
   *
   * Before the first snapshot there is nothing to apply it to, and it is
   * dropped.
   *
   * @param {object} ev the event message
   */
  onEvent(ev) {
    if (this.state != null) {
      // A gap: the client never reconciles, it resyncs.
      if (ev.previous_sequence !== this.lastSequence) {
        this.net.send({ type: "resync", table_id: this.id });
      } else {
        this.applyEvent(ev);
      }
    }
  }

  /**
   * Apply an event that follows the last one: its patch, its log lines and
   * cues, and whatever has to be redrawn for it.
   *
   * @param {object} ev the event message
   */
  applyEvent(ev) {
    const patch = ev.patch || [];
    const before = this.state.match?.status;
    const scenes = this.state.me?.scene;
    const handBefore = this.handIds();
    const turnBefore = turnSeat(this.state);

    // Take its place in the sequence, and any keys it carries.
    this.lastSequence = ev.sequence;
    if (ev.keys != null) {
      this.app.cache.setKeys(ev.keys);
    }

    // Apply the patch, and keep the chat log in step with it.
    apply(this.state, patch);
    for (const op of patch) {
      this.logMessages(op);
    }

    // Mark the cards that just came into the viewer's hand, and tell
    // them when the turn has just come to them.
    this.markArrivals(newArrivals(handBefore, this.handIds()));
    this.noticeTurn(turnBefore);

    // Log its announcement, and toast the ones everyone must see.
    if (ev.announce != null) {
      this.logAnnouncement(ev);
    }

    // Play its cues.
    if ((ev.cues != null) && (ev.cues.length > 0)) {
      this.playCues(ev.cues);
    }

    // Follow the table's flavor and slot settings.
    if (patchTouches(patch, "settings/flavor.theme")) {
      this.refreshLook();
    }
    if (patchTouches(patch, "settings/slot.")) {
      this.look.view.settings = this.state.settings;
    }

    // Reopen on a new scene; lay out again when a panel came or went, or
    // else just redraw.
    if (this.state.me?.scene !== scenes) {
      this.app.openTable(this.id, { ...this.opts, view: this.view });
    }
    if (patchTouches(patch, "settings/features.")) {
      this.layout();
    } else {
      this.renderAll();
    }

    // Show the results when the match has just finished.
    if (
      (before !== "finished") &&
      (this.state.match?.status === "finished")
    ) {
      this.showResults();
    }
  }

  /**
   * Keep the chat log in step with one patch operation: a message added,
   * or the messages replaced.
   *
   * @param {object} op the patch operation
   */
  logMessages(op) {
    if ((op.path === "messages") && (op.op === "add")) {
      this.log.push({ kind: "message", msg: op.value });
    }
    if (
      (op.path.startsWith("messages")) &&
      (op.op === "set") &&
      (Array.isArray(op.value))
    ) {
      this.log = op.value.map((msg) => ({ kind: "message", msg: msg }));
    }
  }

  /**
   * Log an event's announcement, and toast it when it is a vote, a match
   * change or a refusal.
   *
   * @param {object} ev the event message, with an announcement
   */
  logAnnouncement(ev) {
    const line = this.text.t(ev.announce.text);

    // Log it.
    this.log.push({
      kind: "announce",
      text: line,
      sequence: ev.sequence,
      type: ev.event_type,
    });

    // Toast the ones everyone must see.
    if (
      (ev.event_type?.startsWith("vote.")) ||
      (ev.event_type?.startsWith("match.")) ||
      (ev.event_type === "core.rejected")
    ) {
      toast(line);
    }
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

  async remoteAsset(reference) {
    try {
      const r = await this.net.request("assets.key", { table_id: this.id, asset_reference: reference });
      this.app.cache.setKeys({ [r.hash]: r.key });
      if (!(await this.app.cache.inventory()).includes(r.hash)) await this.app.cache.download(r);
      return { hash: r.hash, mime: r.mime };
    } catch {
      return null;
    }
  }

  // Cues (spec 23.11) never block play: the state has already changed when they play, a missing file is skipped,
  // and a viewer can turn them off. Sounds play at once; pictures and videos queue, one at a time, with a skip.
  playCues(cues) {
    if (localStorage.getItem("dionysus.cues") === "off") return;
    for (const fire of cues) {
      const cue = (this.look.declaration.cues || []).find((c) => c.cue_id === fire.cue_id);
      const slot = cue && this.slot(cue.slot);
      const reference = slot ? this.look.slotReference(slot.key).reference : null;          // through the viewer's look (spec 23.11)
      if (!reference) continue;
      if ((this.look.assets.get(reference)?.mime || "").startsWith("audio/") || slot.kind === "audio") this.playSound(reference, cue.channel);
      else this.cueQueue.push({ cue, reference, anchorReference: fire.anchor_reference, sound: cue.sound && this.slot(cue.sound) ? this.look.slotReference(cue.sound).reference : null });
    }
    this.renderCueBar();
    this.nextCue();
  }

  slot(key) {
    return key ? (this.look.declaration.slots || []).find((sl) => sl.key === key) : null;
  }

  /** Play a sound; the element, so a skip can stop it, or null. */
  async playSound(reference, channel) {
    try {
      const url = await this.look.urlFor(reference);
      if (!url) return null;
      const audio = new Audio(url);
      audio.volume = channelVolume(channel);
      playMedia(audio);
      return audio;
    } catch { /* presentation never blocks play */ }
    return null;
  }

  /** Play the next visual cue. A picture or animation gets a fresh object URL each time, so an animation starts from
   * its first frame (a browser shares one animation among images with the same URL), and shows for the cue's
   * duration_ms, else one pass as the file times it, else 2.5 s. Its sound starts with it, and a skip stops both. */
  async nextCue() {
    if (this.cueNow || !this.cueQueue.length) return;
    const item = this.cueNow = this.cueQueue.shift();
    let fresh = null;
    try {
      const asset = await this.look.assetFor(item.reference);
      const url = asset && await this.look.urlFor(item.reference);
      const video = !!asset?.mime?.startsWith("video/");
      let duration = item.cue.duration_ms;
      if (url && !video) {
        const blob = await (await fetch(url)).blob();
        if (!duration) {
          const anim = animationOf(new Uint8Array(await blob.arrayBuffer()));
          duration = anim ? anim.ms * (anim.plays || 1) : 2500;
        }
        fresh = URL.createObjectURL(blob);
      }
      if (url && this.cueNow === item) {
        const play = this.sceneView.playCue({ url: fresh || url, video, duration, anchor: item.cue.anchor || "stage",
          reference: item.anchorReference, channel: item.cue.channel });
        const sound = item.sound ? this.playSound(item.sound, item.cue.channel) : null;
        item.stop = () => { play.stop(); sound?.then((a) => a?.pause()); };
        this.renderCueBar();
        await play.done;
      }
    } catch { /* a missing file skips the cue */ }
    if (fresh) URL.revokeObjectURL(fresh);
    if (this.cueNow === item) this.cueNow = null;
    this.renderCueBar();
    this.nextCue();
  }

  /** Skip the cue playing now, or it and every one waiting. A cue declared not skippable plays on. */
  skipCues(all) {
    if (all) this.cueQueue = this.cueQueue.filter((c) => c.cue.skippable === false);
    if (this.cueNow?.cue.skippable !== false) this.cueNow?.stop?.();
    this.renderCueBar();
  }

  renderCueBar() {
    this.cueBar ??= h("div.cue-bar");
    const skip = this.cueNow?.stop && this.cueNow.cue.skippable !== false;
    const waiting = this.cueQueue.filter((c) => c.cue.skippable !== false).length;
    clear(this.cueBar, skip ? h("button.small", { onclick: () => this.skipCues(false) }, "Skip") : null,
      waiting ? h("button.ghost.small", { onclick: () => this.skipCues(true) }, `Skip all (${waiting + (skip ? 1 : 0)})`) : null);
    if (skip || waiting) this.sceneView.el.append(this.cueBar);
    else this.cueBar.remove();
  }

  /** This viewer's sound: cues on or off, and a volume per channel. Kept in this browser, never sent. */
  openSound() {
    const on = h("input", { type: "checkbox", checked: localStorage.getItem("dionysus.cues") !== "off" });
    on.addEventListener("change", () => {
      localStorage.setItem("dionysus.cues", on.checked ? "on" : "off");
      if (!on.checked) { this.cueQueue = []; this.cueNow?.stop?.(); this.renderCueBar(); }
    });
    const sliders = ["effects", "music", "ambience"].map((ch) => {
      const r = h("input", { type: "range", min: 0, max: 1, step: 0.05, value: channelVolume(ch), "aria-label": `${ch} volume` });
      r.addEventListener("change", () => localStorage.setItem(`dionysus.volume.${ch}`, r.value));
      return h("label.field", {}, h("span", {}, ch[0].toUpperCase() + ch.slice(1)), r);
    });
    dialog("Sound", h("div.form", {}, h("label.field.inline", {}, on, h("span", {}, "Play the game's cues (sounds and videos as things happen)")),
      h("p.muted.small", {}, "Cues wait their turn and can be skipped. Media someone shows on the stage plays either way."), sliders), [["Close", true]]);
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

  /**
   * Build the table's page for the current view, and fill it.
   *
   * The table view is the scene with the table's own panels beside it.
   * The hand view is one player's part of the table in one column. The
   * combined view is the scene with the hand below it, and the controls
   * and the viewer's own seat values at the top of the side panel, so the
   * hand stays on screen however many controls a game has.
   */
  layout() {
    const projecting = this.projecting;
    const main = h("main.table-main", { class: `view-${this.view}` });
    const side = h("aside.table-side");
    let logTitle = "Table log";
    let fold = null;

    // Make the panels every view draws from.
    if (this.feature("messages")) {
      logTitle = "Table talk";
    }
    this.turnEl = null;
    this.header = h("header.table-head");
    this.seatsEl = h("div.seat-strip");
    this.lobbyEl = h("section.lobby-panel");
    this.controlsEl = h("div.controls");
    this.valuesEl = h("section.values-panel");
    this.handEl = h("section.hand-panel");
    this.placesEl = h("section.places-panel");
    this.stateEl = h("section.state-panel");
    this.logEl = h("div.log");
    if (this.feature("messages")) {
      this.chatEl = h(
        "section.chat-panel",
        {},
        h("h3", {}, logTitle),
        this.logEl,
        this.composer(),
      );
    } else {
      this.chatEl = h(
        "section.chat-panel",
        {},
        h("h3", {}, logTitle),
        this.logEl,
      );
    }

    // Lay them out for the view.
    switch (this.view) {
      case "table":
        if (this.scene != null) {
          main.append(this.sceneView.el);
          side.append(this.stateEl);
        } else {
          main.append(this.stateEl);
        }
        side.append(this.placesEl, this.chatEl);
        clear(
          this.el,
          this.header,
          this.seatsEl,
          h("div.table-body", {}, main, side),
        );
        break;
      case "hand":
        // One player's private info and controls (spec section 1): whose
        // turn it is, the controls, the hand, the scores and the seat's own
        // sheets. The table's piles and the board are the table view's;
        // talk is folded away.
        this.turnEl = h("p.turn-line");
        this.chatEl.querySelector("h3").remove();
        fold = h(
          "details.chat-fold",
          {},
          h("summary", {}, logTitle),
          this.chatEl,
        );
        main.append(
          this.lobbyEl,
          this.turnEl,
          this.controlsEl,
          this.valuesEl,
          this.handEl,
          this.stateEl,
          fold,
        );
        clear(this.el, this.header, h("div.table-body.hand-only", {}, main));
        break;
      default:
        main.append(this.lobbyEl);
        if (this.scene != null) {
          main.append(this.sceneView.el);
        } else {
          main.append(this.stateEl);
        }
        main.append(this.handEl);
        side.append(this.controlsEl, this.valuesEl);
        if (this.scene != null) {
          side.append(this.stateEl);
        }
        side.append(this.placesEl, this.chatEl);
        clear(
          this.el,
          this.header,
          this.seatsEl,
          h("div.table-body", {}, main, side),
        );
        break;
    }

    // Fill them, and go back to projecting where the old page was.
    this.renderAll();
    if ((this.view !== "hand") && (projecting)) {
      this.enterProjection();
    }
  }

  /**
   * Fill the turn line, which every view has (in the header, tucked or
   * not, and in the hand view): whose turn it is, and who is laying down
   * a play, hidden when there is neither. Where the game keeps a turn of
   * its own, the seat whose turn it is (and the GM) gets End turn, and a
   * seated viewer the chime switch. A viewer holding a play pending gets
   * Commit play and Cancel.
   */
  renderTurn() {
    let turn = null;
    let text = "";
    let endButton = null;
    let chimeButton = null;
    let mine = [];
    let others = [];
    let pendingText = "";
    let commitButton = null;
    let cancelButton = null;
    let noun = "";

    if ((this.turnEl != null) && (this.state != null)) {
      // Whose turn it is, while the match runs.
      turn = this.findTurnSeat();

      // Said for the viewer.
      if ((turn != null) && (turn === this.seat)) {
        text = "Your turn";
      } else if (turn != null) {
        text = `${this.seatName(turn)}'s turn`;
      } else {
        text = "";
      }

      // End turn, for whoever may pass it, and the chime switch.
      if (
        (turn != null) &&
        (keepsTurn(this.look.declaration)) &&
        ((turn === this.seat) || (this.isGM()))
      ) {
        endButton = h("button.small.end-turn", {
          onclick: () => this.act("turn.pass", {}),
          title: "Pass the turn to the next seat",
        }, "End turn");
      }
      if ((turn != null) && (this.seat != null)) {
        chimeButton = this.chimeButton();
      }

      // A play being laid down: the viewer's own, to commit or cancel,
      // and how many cards each other seat holds back.
      mine = myPending(this.state, this.seat);
      others = othersPending(this.state, this.seat);
      if (mine.length > 0) {
        commitButton = h("button.small.commit-play", {
          onclick: () => this.act("pending.commit", {}),
          title: "Show your pending cards to everyone, all at once",
        }, `Commit play (${mine.length})`);
        cancelButton = h("button.ghost.small.cancel-play", {
          onclick: () => this.act("pending.cancel", {}),
          title: "Take every pending card back into your hand",
        }, "Cancel");
      }
      for (const other of others) {
        pendingText += (
          ` · ${this.seatName(other.seat)} is laying down ` +
          `${other.count} card${(other.count === 1) ? "" : "s"}`
        );
      }

      this.turnEl.hidden = (
        (turn == null) &&
        (mine.length === 0) &&
        (others.length === 0)
      );
      this.turnEl.classList.toggle("mine", (turn === this.seat));
      clear(
        this.turnEl,
        h("span.turn-text", {}, text),
        endButton,
        chimeButton,
        h("span.pending-text", {}, pendingText),
        commitButton,
        cancelButton,
      );
    }
  }

  /**
   * The switch for the chime that sounds when the turn comes to the
   * viewer: off unless they turn it on, and kept in this browser.
   *
   * @returns {HTMLButtonElement} the switch
   */
  chimeButton() {
    const isOn = chimeIsOn();
    let label = "🔕";
    let title = "Chime when it becomes your turn (off)";

    // How it reads now.
    if (isOn) {
      label = "🔔";
      title = "Chime when it becomes your turn (on)";
    }

    return h("button.ghost.small.chime", {
      onclick: () => {
        setChime(!isOn);
        this.renderTurn();
      },
      title: title,
      "aria-pressed": String(isOn),
    }, label);
  }

  /**
   * Tell the viewer when the turn has just come to them: a toast, and
   * the chime if they turned it on.
   *
   * @param {number|null} before the turn's seat before the event
   */
  noticeTurn(before) {
    if (cameToMe(before, turnSeat(this.state), this.seat)) {
      toast("Your turn");
      if (chimeIsOn()) {
        chime();
      }
    }
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
    if (this.projecting && !this.scene && this.state) return this.renderBoard();
    if (!this.scene || !this.state) return;
    this.sceneView.setScene(this.scene, this.display, SIDE_TURNS[this.side()]);
    this.sceneView.render(this.state);
    if (this.projecting) this.projector.layout();
  }

  /** The side of the table this viewer sees the scene from: the one their seat sits on (the scene's seat_sides), or
   * one they chose for this table, kept in this browser only. Projection has no seat and keeps the projector's turn. */
  side() {
    if (this.projecting) return "south";
    return sideFor(this.scene?.seat_sides, this.seat, this.viewFrom());
  }

  viewFrom() {
    try { return localStorage.getItem(`dionysus.viewFrom.${this.id}`) || "seat"; } catch { return "seat"; }
  }

  setViewFrom(choice) {
    try {
      if (choice === "seat") localStorage.removeItem(`dionysus.viewFrom.${this.id}`);
      else localStorage.setItem(`dionysus.viewFrom.${this.id}`, choice);
    } catch { /* kept for this page only */ }
    this.renderScene();
  }

  /** "View from": my seat (its declared side), or any side of the table. */
  viewFromPicker() {
    const mine = sideFor(this.scene?.seat_sides, this.seat);
    const choice = this.viewFrom();
    const label = (side) => side[0].toUpperCase() + side.slice(1);
    const select = h("select", { "aria-label": "View from", title: "Which side of the table you see the board from (kept in this browser)" },
      h("option", { value: "seat", selected: choice === "seat" }, this.seat != null ? `My seat (${label(mine)})` : `Default (${label(mine)})`),
      SIDES.map((side) => h("option", { value: side, selected: choice === side }, label(side))));
    select.addEventListener("change", () => this.setViewFrom(select.value));
    return h("label.view-from", {}, h("span.muted", {}, "View from"), select);
  }

  /**
   * The table's header: its name and where the match stands, whose turn
   * it is, the view switch, and the tools.
   */
  renderHeader() {
    const game = this.snap.game;
    const isTucked = this.isTucked();
    let who = " · table view";
    let headerTurn = null;

    // Who the viewer is here.
    if (this.seat != null) {
      who = ` · you are ${this.seatName(this.seat)}`;
    }

    // The turn shows in the header in every view but the hand view, which
    // has its own line for it.
    if (this.view !== "hand") {
      this.turnEl = h("span.turn-line");
      headerTurn = this.turnEl;
    }

    // Tucked away into one slim row, or in full.
    if (isTucked) {
      this.renderTuckedHeader();
    } else {
      clear(
        this.header,
        h(
          "div.title",
          {},
          h(
            "button.back",
            {
              onclick: () => this.app.go("lobby"),
              title: "Back to the tables",
            },
            "←",
          ),
          h(
            "div",
            {},
            h("h1", {}, this.snap.table?.name || game.name),
            h("p.muted", {}, `${game.name} · ${this.matchStatus()}${who}`),
          ),
          headerTurn,
        ),
        this.viewSwitch(),
        this.tuckButton(),
        h("div.tools", {}, this.headerTools()),
      );
      this.renderTurn();
    }

    // The seat strip goes with it.
    this.header.classList.toggle("tucked", isTucked);
    if (this.seatsEl != null) {
      this.seatsEl.hidden = isTucked;
    }
  }

  /**
   * The header tucked away, in one slim row: the way back, the table's
   * name, where the match stands and whose turn it is, the view switch,
   * and the button that shows it all again.
   */
  renderTuckedHeader() {
    this.turnEl = h("span.turn-line");

    clear(
      this.header,
      h(
        "button.back",
        { onclick: () => this.app.go("lobby"), title: "Back to the tables" },
        "←",
      ),
      h(
        "div.tucked-title",
        {},
        h("h1", {}, this.snap.table?.name || this.snap.game.name),
        h("span.muted", {}, this.matchStatus()),
        this.turnEl,
      ),
      this.viewSwitch(),
      h("button.ghost.tuck", {
        onclick: () => this.setTucked(false),
        title: "Show the header, its tools and the seats again",
      }, "▾ Show"),
    );
    this.renderTurn();
  }

  /**
   * The button that tucks the header away, in the combined view only.
   *
   * @returns {HTMLButtonElement|null} the button, or null in other views
   */
  tuckButton() {
    let ret = null;

    if (this.view === "both") {
      ret = h("button.ghost.tuck", {
        onclick: () => this.setTucked(true),
        title: (
          "Tuck the header and the seats away, to give the board more" +
          " room (kept in this browser)"
        ),
      }, "▴ Tuck");
    }

    return ret;
  }

  /**
   * Whether the header is tucked away: only ever in the combined view,
   * and as the viewer left it last, in this browser.
   *
   * @returns {boolean} whether it is
   */
  isTucked() {
    let ret = false;

    // What this browser kept, read once.
    if (this.tucked == null) {
      this.tucked = storedTucked();
    }

    if (this.view === "both") {
      ret = this.tucked;
    }

    return ret;
  }

  /**
   * Tuck the header away or show it again, keep the choice in this
   * browser for every table, and redraw it.
   *
   * @param {boolean} isTucked whether to tuck it away
   */
  setTucked(isTucked) {
    this.tucked = isTucked;

    // Kept for next time, when the browser lets it be.
    try {
      if (isTucked) {
        localStorage.setItem(TUCKED_KEY, "1");
      } else {
        localStorage.removeItem(TUCKED_KEY);
      }
    } catch {
      // Storage is blocked: the choice holds for this page only.
    }

    this.renderHeader();
  }

  /**
   * Where the table and its match stand, in a few words.
   *
   * @returns {string} the status
   */
  matchStatus() {
    const match = this.state.match || {};
    let ret = "";

    if (this.status === "ended") {
      ret = "Table ended";
    } else if ((match.status == null) || (match.status === "")) {
      ret = "In the lobby";
    } else if (match.status === "running") {
      ret = `Match ${match.number} in play`;
    } else if (match.status === "ready_to_end") {
      ret = `Match ${match.number} is ready to end`;
    } else if (match.status === "finished") {
      ret = `Match ${match.number} finished`;
    } else {
      ret = `Match ${match.number} abandoned`;
    }

    return ret;
  }

  /**
   * The switch between the three views: table, hand and both.
   *
   * @returns {HTMLDivElement} the switch
   */
  viewSwitch() {
    return h(
      "div.segmented",
      { role: "group", "aria-label": "View" },
      this.viewButton("table", "Table"),
      this.viewButton("hand", "Hand"),
      this.viewButton("both", "Both"),
    );
  }

  /**
   * One button of the view switch, lit when it is the view showing.
   *
   * @param {string} view the view it opens
   * @param {string} label its text
   * @returns {HTMLButtonElement} the button
   */
  viewButton(view, label) {
    let classes = "seg";

    if (this.view === view) {
      classes = "seg on";
    }

    return h(
      "button",
      { class: classes, onclick: () => this.openView(view) },
      label,
    );
  }

  /**
   * Open this table again in another view. The table view takes no seat.
   *
   * @param {string} view the view to open
   */
  openView(view) {
    let seat = this.opts.seat;

    if (view === "table") {
      seat = undefined;
    }

    this.app.openTable(this.id, { ...this.opts, view: view, seat: seat });
  }

  /**
   * The header's tools, in order: the match's, the board's, the table's,
   * then those for the table as a whole and its record.
   *
   * @returns {Array<HTMLElement>} the tools
   */
  headerTools() {
    return [
      ...this.matchTools(),
      ...this.boardTools(),
      ...this.tableTools(),
      ...this.recordTools(),
    ];
  }

  /**
   * The match's tools, for a seated player while it is in play: undo and
   * redo (when the table has undo), call or end the match, and abandon
   * it.
   *
   * @returns {Array<HTMLElement>} the tools
   */
  matchTools() {
    const match = this.state.match || {};
    const isRunning = (
      (match.status === "running") ||
      (match.status === "ready_to_end")
    );
    const ret = [];
    let end = "Call match";

    if ((isRunning) && (this.seat != null)) {
      // Undo and redo, by the table's undo rule.
      if (this.feature("undo")) {
        ret.push(h("button.ghost", {
          onclick: () => this.act("undo.request"),
          title: "Undo the last action (by the table's undo rule)",
        }, "Undo"));
        ret.push(h(
          "button.ghost",
          { onclick: () => this.act("redo.request") },
          "Redo",
        ));
      }

      // Ending it: called, or ended once it is ready to.
      if (match.status === "ready_to_end") {
        end = "End match";
      }
      ret.push(h(
        "button.ghost",
        { onclick: () => this.act("match.end") },
        end,
      ));
      ret.push(h(
        "button.ghost",
        { onclick: () => this.act("match.abandon") },
        "Abandon",
      ));
    }

    return ret;
  }

  /**
   * The board's tools, where there is a board and it shows: the side to
   * view it from, the grid, and for a seat at a table with marks the pen.
   *
   * @returns {Array<HTMLElement>} the tools
   */
  boardTools() {
    const ret = [];
    let penClass = "ghost";

    if ((this.scene != null) && (this.view !== "hand")) {
      // Where it is seen from, and its grid.
      ret.push(this.viewFromPicker());
      ret.push(h("button.ghost", {
        onclick: () => this.toggleGrid(),
        title: "Show or hide the grid",
      }, "Grid"));

      // The pen, lit while it is in hand.
      if ((this.seat != null) && (this.feature("marks"))) {
        if (this.sceneView.tool === "pen") {
          penClass = "ghost on";
        }
        ret.push(h("button.ghost", {
          class: penClass,
          onclick: () => this.togglePen(),
          title: "Draw on the board",
        }, "Pen"));
      }
    }

    return ret;
  }

  /**
   * Show or hide the board's grid.
   */
  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.renderScene();
  }

  /**
   * Pick up the pen, or put it down for the hand.
   */
  togglePen() {
    if (this.sceneView.tool === "pen") {
      this.sceneView.tool = "hand";
    } else {
      this.sceneView.tool = "pen";
    }
    this.renderHeader();
  }

  /**
   * The table's own tools: projection (in the table view), settings,
   * sound (when there is any), the journal and the GM's tools.
   *
   * @returns {Array<HTMLElement>} the tools
   */
  tableTools() {
    const ret = [];

    // Projection, from the table view.
    if (this.view === "table") {
      ret.push(h("button.ghost", {
        onclick: () => this.enterProjection(),
        title: (
          "Project the board onto a real table: corners, mirror, flip," +
          " rotation, focus"
        ),
      }, "Project"));
    }

    // Settings, and sound when the game has cues or media.
    ret.push(h(
      "button.ghost",
      { onclick: () => this.openSettings() },
      "Settings",
    ));
    if (
      (this.look.declaration?.cues?.length > 0) ||
      (this.feature("media"))
    ) {
      ret.push(h("button.ghost", {
        onclick: () => this.openSound(),
        title: "Cues on or off, and volume",
      }, "Sound"));
    }

    // The journal, for a seat, and the GM's tools.
    if ((this.seat != null) && (this.feature("journal"))) {
      ret.push(h(
        "button.ghost",
        { onclick: () => this.openJournal() },
        "Journal",
      ));
    }
    if (this.isGM()) {
      ret.push(h(
        "button.ghost",
        { onclick: () => this.openGMTools() },
        "GM",
      ));
    }

    return ret;
  }

  /**
   * The tools for the table as a whole and its record: end it, its
   * notation, the viewer's look, the results and the disclosures.
   *
   * @returns {Array<HTMLElement>} the tools
   */
  recordTools() {
    const match = this.state.match || {};
    const ret = [];
    let look = "Look";

    // Ending the table, for a seat while it lasts.
    if ((this.seat != null) && (this.status !== "ended")) {
      ret.push(h("button.ghost", {
        onclick: () => this.endTable(),
        title: (
          "End this table for good (by the table's end rule, usually a" +
          " vote)"
        ),
      }, "End table"));
    }

    // The game as text, when it has a notation.
    if (this.snap.game.notations?.length > 0) {
      ret.push(h("button.ghost", {
        onclick: () => openNotation(this),
        title: "The game or the position as text: export it, or load one",
      }, "Notation"));
    }

    // The viewer's look, marked while a change is pending.
    if (this.hasLook()) {
      if (this.lookPending) {
        look = "Look…";
      }
      ret.push(h("button.ghost", {
        onclick: () => openLook(this),
        title: (
          "Your theme and the pictures and sounds you choose for this game"
        ),
      }, look));
    }

    // The results, once there has been a match, and the disclosures.
    if (match.number > 0) {
      ret.push(h(
        "button.ghost",
        { onclick: () => this.showResults() },
        "Results",
      ));
    }
    ret.push(h(
      "button.ghost",
      { onclick: () => this.app.showDisclosures(null) },
      "Disclosures",
    ));

    return ret;
  }

  /**
   * Draw the turn line and the seat strip: a card for each seat.
   */
  renderSeats() {
    let turn = null;

    this.renderTurn();
    if (this.seatsEl != null) {
      turn = this.findTurnSeat();
      clear(this.seatsEl, this.seats.map((seat) => this.seatCard(seat, turn)));
    }
  }

  /**
   * One seat's card in the seat strip: its player and badges, its number
   * and team, whether they are connected, their rating, and, between
   * matches, whether they are ready.
   *
   * @param {object} seat the seat
   * @param {number|null} turn the seat whose turn it is, if any
   * @returns {HTMLElement} the card
   */
  seatCard(seat, turn) {
    const ratings = Object.entries(seat.ratings || {});
    const status = this.state?.match?.status;
    const isTaken = ((seat.account_name != null) && (seat.account_name !== ""));
    const isBot = ((seat.bot_id != null) && (seat.bot_id !== ""));
    const classes = [];
    let name = "Empty seat";
    let meta = `Seat ${seat.seat_id}`;
    let dot = null;
    let botBadge = null;
    let gmBadge = null;
    let turnBadge = null;
    let rating = null;
    let ready = null;
    let readyText = "";
    let readyClass = "";
    let values = null;

    // How the card is marked: the viewer's own, whose turn, or empty.
    if (seat.seat_id === this.seat) {
      classes.push("me");
    }
    if (seat.seat_id === turn) {
      classes.push("turn");
      turnBadge = h("span.badge.turn", {}, "▶︎ turn");
    }
    if (isTaken) {
      name = seat.account_name;
    } else {
      classes.push("vacant");
    }

    // Its badges: a bot, the GM.
    if (isBot) {
      botBadge = h("span.badge", {}, "bot");
    }
    if (seat.role === "gm") {
      gmBadge = h("span.badge.gm", {}, "GM");
    }

    // Its team, and whether a person sitting there is connected.
    if ((seat.team != null) && (seat.team !== "")) {
      meta += ` · ${seat.team}`;
    }
    if ((isTaken) && (!isBot)) {
      if (seat.connected) {
        dot = h("span", { class: "dot on", title: "connected" });
      } else {
        dot = h("span", { class: "dot", title: "away" });
      }
    }

    // The first rating, with every rating in its title.
    if (ratings.length > 0) {
      rating = h(
        "div.seat-rating",
        { title: ratings.map(([k, v]) => `${k}: ${v.text}`).join("\n") },
        ratings[0][1].text,
      );
    }

    // Between matches, whether they are ready.
    if (
      (status == null) ||
      (status === "") ||
      (status === "finished") ||
      (status === "abandoned")
    ) {
      if ((isTaken) && (seat.ready)) {
        readyText = "Ready";
      } else if (isTaken) {
        readyText = "Not ready";
      }
      if (seat.ready) {
        readyClass = "yes";
      }
      ready = h("div.seat-ready", { class: readyClass }, readyText);
    }

    // The seat values the game shows here.
    values = this.seatStripValues(seat.seat_id);

    return h(
      "div.seat-card",
      { class: classes.join(" ") },
      h("div.seat-name", {}, turnBadge, name, botBadge, gmBadge),
      h("div.seat-meta", {}, meta, dot),
      values,
      rating,
      ready,
    );
  }

  /**
   * The seat whose turn it is while the match runs: the core turn, or
   * else the first mechanic's that keeps a turn as {seat}.
   *
   * @returns {number|null} the seat, or null when it is no one's
   */
  findTurnSeat() {
    return turnSeat(this.state);
  }

  renderLobby() {
    if (!this.lobbyEl || !this.state) return;
    const m = this.state.match || {};
    const inLobby = !m.status || m.status === "finished" || m.status === "abandoned";
    if (!inLobby || this.view === "table" || this.status === "ended") {
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
      this.expansionSection(),
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
    const variants = this.snap.game.variant_declarations || [];
    if (!variants.length) return null;
    return h("div.variants", {}, h("h3", {}, "House rules"),
      variants.map((v) => {
        const chosen = this.state.settings?.[`variants.${v.key}`] ?? v.default;
        const select = h("select", { disabled: this.seat == null, "aria-label": this.text.t({ key: v.description }) },
          v.options.map((o) => h("option", { value: o.key, selected: o.key === chosen }, this.text.t({ key: o.description }))));
        select.addEventListener("change", () => this.act("settings.change", { key: `variants.${v.key}`, value: select.value }));
        return h("label.field.inline", {}, h("span", {}, this.text.t({ key: v.description })), select);
      }));
  }

  /** Expansions (spec section 5.3): each one offered is a lobby setting, expansions.<id>, whose value is the version
   * it pins, or "off". Its text is its own, sent with it, since the game's strings have it only once it is on. */
  expansionSection() {
    const offered = this.snap.game.expansion_declarations || [];
    if (!offered.length) return null;
    const names = Object.fromEntries(offered.map((x) => [x.expansion_id, x.name]));
    return h("div.variants", {}, h("h3", {}, "Expansions"),
      offered.map((x) => {
        const chosen = this.state.settings?.[`expansions.${x.expansion_id}`] ?? "off";
        const on = h("input", { type: "checkbox", checked: chosen !== "off", disabled: this.seat == null });
        on.addEventListener("change", async () => {
          const ack = await this.act("settings.change", { key: `expansions.${x.expansion_id}`, value: on.checked ? x.versions[x.versions.length - 1] : "off" });
          if (ack?.outcome !== "accepted") on.checked = !on.checked;
        });
        const notes = [chosen !== "off" ? `version ${chosen}` : null, x.rated === "apart" ? "rated as a game of its own" : null,
          x.needs.length ? `needs ${x.needs.map((n) => names[n] || n).join(", ")}` : null].filter(Boolean).join(" · ");
        return h("label.field.inline", {}, on, h("span", {}, `${x.name}: ${x.description_text || this.text.t({ key: x.description })}`),
          notes ? h("span.muted.small", {}, ` (${notes})`) : null);
      }));
  }

  sideName(side) {
    return side.startsWith("seat") ? this.seatName(Number(side.slice(4))) : side;
  }

  botPicker(seat) {
    const select = h("select", {}, h("option", { value: "" }, `Seat ${seat}…`), (this.snap.game.bots || []).map((b) => h("option", { value: b }, b)));
    select.addEventListener("change", () => select.value && this.net.request("tables.seat_bot", { table_id: this.id, seat, bot_id: select.value }).catch((e) => toast(e.message, "warn")));
    return select;
  }

  async endTable() {
    const ok = await dialog("End this table?", h("p", {}, "The table ends for good, and any match in play is abandoned. Unless the table's GM decides, everyone seated votes on it."),
      [["Propose ending it", true, "danger"], ["Keep playing", false]]);
    if (ok) this.act("table.end");
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

  /**
   * The viewer's own places: those of their seat (<place>.<seat>) not
   * drawn on the scene (a placemat's places are on the scene, not in the
   * hand).
   *
   * @returns {Array<[string, Array|object]>} each place's id and what the
   *   viewer sees of it
   */
  myPlaces() {
    const ret = [];
    const onScene = this.scenePlaces();

    for (const [pid, contents] of Object.entries(this.state.places || {})) {
      if (
        (this.seat != null) &&
        (pid.endsWith(`.${this.seat}`)) &&
        (!onScene.has(pid))
      ) {
        ret.push([pid, contents]);
      }
    }

    return ret;
  }

  /**
   * The places drawn on the scene: those on its graph's nodes, and each
   * drawn placemat's places for its seat.
   *
   * @returns {Set<string>} their ids
   */
  scenePlaces() {
    const nodes = this.scene?.graph?.nodes || [];
    const places = this.state.places || {};
    const ret = new Set(nodes.map((n) => n.place_id).filter(Boolean));

    for (const mat of this.scene?.placemats || []) {
      for (const seat of matSeats(mat, places)) {
        for (const place of mat.places || []) {
          ret.add(`${place.place_id}.${seat}`);
        }
      }
    }

    return ret;
  }

  /**
   * The hand panel: each of the viewer's own places that lists its
   * tokens, as a row of cards. The viewer's own seat values are drawn
   * along with it, in a panel of their own.
   *
   * Hidden in the table view, for a viewer with no seat, and when there
   * are no such places.
   */
  renderHand() {
    let mine = [];
    let canPlay = false;

    if (this.handEl != null) {
      // The places to show.
      if ((this.view !== "table") && (this.seat != null)) {
        mine = this.handPlaces();
      }

      // Hidden when there is nothing to show.
      if (mine.length === 0) {
        this.handEl.hidden = true;
      } else {
        this.handEl.hidden = false;
        canPlay = this.controls.some((control) => (
          control.action_type === "tabletop.play"
        ));
        clear(this.handEl, mine.map(([pid, ids]) => (
          this.handBlock(pid, ids, canPlay)
        )));
      }
    }

    this.renderValues();
  }

  /**
   * The values panel: the viewer's own seat values, with the controls to
   * change them. It sits above the hand in the hand view, and at the top
   * of the side panel in the combined view.
   *
   * Hidden in the table view, for a viewer with no seat, and when the
   * game shows no values there.
   */
  renderValues() {
    let values = null;

    if (this.valuesEl != null) {
      // The viewer's own seat values.
      if ((this.view !== "table") && (this.seat != null)) {
        values = this.handValues();
      }

      // Hidden when there is nothing to show.
      if (values == null) {
        this.valuesEl.hidden = true;
      } else {
        this.valuesEl.hidden = false;
        clear(this.valuesEl, values);
      }
    }
  }

  /**
   * The seat values the game shows beside a seat's name, as small chips:
   * "Phase 3", "Score 45". A value that keeps a history opens the score
   * sheet when clicked.
   *
   * @param {number} seat the seat
   * @returns {HTMLElement|null} the row of chips, or null when there are
   *   none the viewer sees
   */
  seatStripValues(seat) {
    const declarations = valueDeclarations(this.look?.declaration);
    const chips = [];
    let ret = null;
    let value;
    let text = "";

    for (const declaration of shownIn(declarations, "seat_strip")) {
      value = seatValue(this.state, declaration.key, seat);
      if (value != null) {
        text = `${this.text.t(declaration.name)} ${value}`;
        if (declaration.history === true) {
          chips.push(h("button.seat-value.ghost", {
            type: "button",
            title: "Open the score sheet",
            onclick: () => this.openSheet(declaration),
          }, text));
        } else {
          chips.push(h("span.seat-value", {}, text));
        }
      }
    }
    if (chips.length > 0) {
      ret = h("div.seat-values", {}, chips);
    }

    return ret;
  }

  /**
   * The viewer's own seat values, for the values panel: each with what its
   * value stands for (phase 3: "1 set of 4 + 1 run of 4") and, where they
   * may edit it, the controls to change it.
   *
   * @returns {HTMLElement|null} the row, or null when the game shows none
   *   here
   */
  handValues() {
    const declarations = valueDeclarations(this.look?.declaration);
    const rows = [];
    let ret = null;
    let value;
    let textKey = null;
    let meaning = null;

    for (const declaration of shownIn(declarations, "hand")) {
      value = seatValue(this.state, declaration.key, this.seat);
      if (value != null) {
        // What the value stands for, when its texts say.
        textKey = valueTextKey(declaration, value);
        meaning = null;
        if (textKey != null) {
          meaning = h("span.hand-value-text", {}, this.text.t(textKey));
        }
        rows.push(h(
          "div.hand-value",
          {},
          h("span.hand-value-name", {}, this.text.t(declaration.name)),
          h("strong.hand-value-number", {}, String(value)),
          meaning,
          this.valueEditors(declaration, value),
        ));
      }
    }
    if (rows.length > 0) {
      ret = h("div.hand-values", {}, rows);
    }

    return ret;
  }

  /**
   * The controls that edit one of the viewer's own seat values, when they
   * may: - and + for a number (and Add for one that keeps a history), a
   * list for a choice, and Edit for text. A value that keeps a history
   * also opens its score sheet.
   *
   * @param {object} declaration the value's declaration
   * @param {*} value its value now
   * @returns {Array<HTMLElement>} the controls
   */
  valueEditors(declaration, value) {
    const ret = [];
    const key = declaration.key;
    const seat = this.seat;
    let select = null;

    // The ones that change it, where the viewer may.
    if (mayEdit(declaration, this.seat, this.seat, this.isGM())) {
      switch (declaration.type) {
        case "int":
          ret.push(h("button.ghost.value-step", {
            type: "button",
            title: "One less",
            onclick: () => this.act("value.add", { key, seat, amount: -1 }),
          }, "−"));
          ret.push(h("button.ghost.value-step", {
            type: "button",
            title: "One more",
            onclick: () => this.act("value.add", { key, seat, amount: 1 }),
          }, "+"));
          if (declaration.history === true) {
            ret.push(h("button.ghost", {
              type: "button",
              onclick: () => this.addToValue(declaration),
            }, "Add…"));
          }
          break;
        case "enum":
          select = h("select", {
            onchange: () => this.act("value.set", {
              key,
              seat,
              value: select.value,
            }),
          }, declaration.options.map((option) => h(
            "option",
            { value: option, selected: option === value },
            this.optionLabel(declaration, option),
          )));
          ret.push(select);
          break;
        case "text":
          ret.push(h("button.ghost", {
            type: "button",
            onclick: () => this.editText(declaration, value),
          }, "Edit…"));
          break;
        default:
          break;
      }
    }

    // The score sheet, for anyone.
    if (declaration.history === true) {
      ret.push(h("button.ghost", {
        type: "button",
        onclick: () => this.openSheet(declaration),
      }, "Sheet"));
    }

    return ret;
  }

  /**
   * How a choice's option reads: the string its texts map it to, or the
   * option itself.
   *
   * @param {object} declaration the value's declaration
   * @param {string} option the option
   * @returns {string} its label
   */
  optionLabel(declaration, option) {
    const textKey = valueTextKey(declaration, option);
    let ret = option;

    if (textKey != null) {
      ret = this.text.t(textKey);
    }

    return ret;
  }

  /**
   * Ask how much to add to one of the viewer's own numbers (a hand's
   * score, say), with a note for its history, and add it.
   *
   * @param {object} declaration the value's declaration
   */
  async addToValue(declaration) {
    const amount = h("input", { type: "number", step: "1", value: "0" });
    const note = h("input", {
      type: "text",
      maxlength: "80",
      placeholder: "Hand 3",
    });
    const name = this.text.t(declaration.name);
    const params = { key: declaration.key, seat: this.seat, amount: 0 };
    let isOk = false;

    // Ask.
    isOk = await dialog(
      `Add to ${name}`,
      h(
        "div.form",
        {},
        h(
          "label.field",
          {},
          h("span", {}, "How much (it may be less than 0)"),
          amount,
        ),
        h("label.field", {}, h("span", {}, "Note (optional)"), note),
      ),
      [["Add", true, "primary"], ["Cancel", false]],
    );

    // Add it, when it is a whole number.
    params.amount = Number(amount.value);
    if ((isOk === true) && (Number.isInteger(params.amount))) {
      if (note.value.trim() !== "") {
        params.note = note.value.trim();
      }
      await this.act("value.add", params);
    }
  }

  /**
   * Ask for the new text of one of the viewer's own text values, and set
   * it.
   *
   * @param {object} declaration the value's declaration
   * @param {string} value its text now
   */
  async editText(declaration, value) {
    const input = h("input", { type: "text", maxlength: "200", value });
    const name = this.text.t(declaration.name);
    let isOk = false;

    isOk = await dialog(
      name,
      h("div.form", {}, h("label.field", {}, h("span", {}, name), input)),
      [["Save", true, "primary"], ["Cancel", false]],
    );
    if (isOk === true) {
      await this.act("value.set", {
        key: declaration.key,
        seat: this.seat,
        value: input.value,
      });
    }
  }

  /**
   * Show the score sheet of a value that keeps a history: each change, in
   * order, for each seat the viewer sees, and the totals.
   *
   * @param {object} declaration the value's declaration
   */
  openSheet(declaration) {
    const bySeat = this.state?.value_history?.[declaration.key] || {};
    const seats = Object.keys(bySeat).map(Number).sort((a, b) => a - b);
    const rows = sheetRows(bySeat, seats);
    const head = [h("th", {}, "#")];
    const foot = [h("th", {}, "Total")];
    let total;

    // A column for each seat, its total at the foot.
    for (const seat of seats) {
      head.push(h("th", {}, this.seatName(seat)));
      total = seatValue(this.state, declaration.key, seat);
      if (total == null) {
        total = "";
      }
      foot.push(h("th", {}, String(total)));
    }

    dialog(
      this.text.t(declaration.name),
      h(
        "table.score-sheet",
        {},
        h("thead", {}, h("tr", {}, head)),
        h("tbody", {}, rows.map((row, i) => h(
          "tr",
          {},
          h("td", {}, String(i + 1)),
          row.map((entry) => this.sheetCell(entry)),
        ))),
        h("tfoot", {}, h("tr", {}, foot)),
      ),
      [["Close", true]],
    );
  }

  /**
   * One cell of the score sheet: the change and its note, with the total
   * in its title.
   *
   * @param {object|null} entry the history entry, or null for a blank
   * @returns {HTMLElement} the cell
   */
  sheetCell(entry) {
    let ret = h("td", {});
    let note = null;

    if (entry != null) {
      if (entry.note != null) {
        note = h("span.muted", {}, ` ${entry.note}`);
      }
      ret = h(
        "td",
        { title: `Total ${entry.total}` },
        signed(entry.change),
        note,
      );
    }

    return ret;
  }

  /**
   * The viewer's own places that list their tokens: the ones the hand
   * panel shows.
   *
   * @returns {Array<[string, Array<string>]>} each place's id and its
   *   token ids
   */
  handPlaces() {
    const ret = [];

    for (const [pid, contents] of this.myPlaces()) {
      if (Array.isArray(contents)) {
        ret.push([pid, contents]);
      }
    }

    return ret;
  }

  /**
   * The token ids in the viewer's hand: every place the hand panel shows.
   *
   * @returns {Array<string>} the ids
   */
  handIds() {
    const ret = [];

    for (const [, ids] of this.handPlaces()) {
      ret.push(...ids);
    }

    return ret;
  }

  /**
   * Mark the cards that just came into the viewer's hand, for a while.
   * New arrivals replace the cards marked before, and start the time
   * again.
   *
   * Only the viewer's own hand is ever marked: the hand panel shows only
   * their seat's places, and no one else's view lists those tokens.
   *
   * @param {Array<string>} arrivals the ids that came in (none leaves the
   *   marks as they are)
   */
  markArrivals(arrivals) {
    if (arrivals.length > 0) {
      this.newCards = new Set(arrivals);
      clearTimeout(this.newCardsTimer);
      this.newCardsTimer = setTimeout(() => this.clearNewCards(), NEW_CARD_MS);
    }
  }

  /**
   * Take the mark off the cards that came into the hand, and redraw it.
   */
  clearNewCards() {
    this.newCards = new Set();
    this.newCardsTimer = null;
    this.renderHand();
  }

  /**
   * Whether a card is marked as just come into the viewer's hand.
   *
   * @param {string} id the token's id
   * @returns {boolean} whether it is marked
   */
  isNewCard(id) {
    return ((this.newCards != null) && (this.newCards.has(id)));
  }

  /**
   * One place in the hand panel: its name, its count, the sort button
   * when it declares an order, and its cards.
   *
   * @param {string} pid the place's id
   * @param {Array<string>} ids its token ids
   * @param {boolean} canPlay whether the viewer can play cards out of it
   * @returns {HTMLDivElement} the place's block
   */
  handBlock(pid, ids, canPlay) {
    const declaration = (this.look.declaration.places || [])
      .find((place) => pid.startsWith(`${place.place_id}.`));
    const sorted = this.sortHand(ids, declaration);
    let name = pid;
    let sortButton = null;

    // Its name: the declared one, or else its id.
    if ((declaration?.name != null) && (declaration.name !== "")) {
      name = declaration.name;
    }

    // The sort button, when it declares an order.
    if (
      (declaration?.order_by != null) &&
      (declaration.order_by.length > 0)
    ) {
      sortButton = this.sortButton(declaration);
    }

    return h(
      "div.hand",
      { "data-place": pid },
      h(
        "div.hand-head",
        {},
        h("h3", {}, name),
        h("span.muted", {}, `${ids.length}`),
        sortButton,
      ),
      h("div.hand-cards", {}, sorted.map((id) => (
        this.handCard(id, canPlay)
      ))),
    );
  }

  /**
   * A hand's sort button: it says the order the hand is in now, and a
   * click switches to the other one.
   *
   * @param {object} declaration the place's declaration, with an order
   * @returns {HTMLButtonElement} the button
   */
  sortButton(declaration) {
    const keys = declaration.order_by.map((key) => key.property).join(", ");
    const note = "Your arrangement is yours alone, and never logged.";
    let label = "Order: as dealt ▸";
    let title = `Click to sort by ${keys}. ${note}`;

    // Name the order it is in now.
    if (this.handSorted === true) {
      label = "Order: sorted ▸";
      title = `Sorted by ${keys}. Click to show as dealt. ${note}`;
    }

    return h(
      "button.ghost.small.hand-order",
      { onclick: () => this.toggleHandSort(), title: title },
      label,
    );
  }

  /**
   * Switch the hand between sorted and as dealt, and redraw it.
   */
  toggleHandSort() {
    this.handSorted = !this.handSorted;
    this.renderHand();
  }

  /**
   * One card in the hand panel, which can be dragged out or played from
   * its menu when the viewer can play.
   *
   * @param {string} id the token's id
   * @param {boolean} canPlay whether the viewer can play it
   * @returns {HTMLDivElement|null} the card, or null when the token is not
   *   in the state
   */
  handCard(id, canPlay) {
    const entity = this.state.entities?.[id];
    let ret = null;
    let drawn = null;
    let svg = null;
    let draggable = "false";
    let title = "";
    let classes = "div.hand-card";

    if (entity != null) {
      // Draw it.
      drawn = this.look.drawEntity(entity);
      svg = s(
        "svg",
        { viewBox: `0 0 ${drawn.w} ${drawn.h}`, class: "card-svg" },
        drawn.node,
      );

      // It can be dragged when the viewer can play.
      if (canPlay) {
        draggable = "true";
        title = (
          "Drag onto the table (hold Shift for face down), or onto a pile"
        );
      }
      // Marked when it just came into the hand.
      if (this.isNewCard(id)) {
        classes = "div.hand-card.new";
      }
      ret = h(classes, { draggable: draggable, title: title }, svg);

      // Dragging carries the token; its menu plays it to a pile.
      ret.addEventListener("dragstart", (e) => (
        e.dataTransfer.setData("text/x-dionysus-token", id)
      ));
      ret.addEventListener("contextmenu", (e) => (
        this.handCardMenu(e, id, canPlay)
      ));
    }

    return ret;
  }

  /**
   * A hand card's menu: play it to each pile, when the viewer can play.
   *
   * @param {MouseEvent} e the contextmenu event
   * @param {string} id the token's id
   * @param {boolean} canPlay whether the viewer can play it
   */
  handCardMenu(e, id, canPlay) {
    const piles = Object.keys(this.state.places || {})
      .filter((place) => (!place.includes(".")));
    let items = [];

    // The menu's entries.
    e.preventDefault();
    if (canPlay) {
      items = piles.map((pile) => [
        `Play to ${pile}`,
        () => this.act("tabletop.play", { token: id, to: pile }),
      ]);
    }

    this.menu(e.clientX, e.clientY, items);
  }

  /**
   * The place in the viewer's hand that a card let go at a pointer event
   * goes into, or null when the pointer isn't over the hand panel (or
   * the panel isn't showing).
   *
   * @param {MouseEvent} e the pointer event
   * @returns {string|null} the hand place, or null
   */
  handDropAt(e) {
    const shown = [];
    let under = null;
    let block = null;
    let ret = null;

    // What is under the pointer in the hand panel, if anything.
    if ((this.handEl != null) && (!this.handEl.hidden)) {
      under = document.elementsFromPoint(e.clientX, e.clientY)
        .find((el) => this.handEl.contains(el));
    }

    // The place it was let go over, or else the first.
    if (under != null) {
      block = under.closest(".hand[data-place]");
      for (const [pid] of this.handPlaces()) {
        shown.push(pid);
      }
      ret = handDropPlace(shown, block?.dataset.place);
    }

    return ret;
  }

  /**
   * While a card is dragged off the board: light the hand panel up as a
   * place to drop it, more so while the pointer is over it, and carry a
   * picture of the card at the pointer once it has left the board (the
   * board clips the card itself).
   *
   * @param {PointerEvent} e the move
   * @param {object|undefined} ent the dragged token's entity
   */
  dragFromBoard(e, ent) {
    const board = this.sceneView.el.getBoundingClientRect();
    const isOver = (this.handDropAt(e) != null);
    const isOutside = (
      (e.clientX < board.left) ||
      (e.clientX > board.right) ||
      (e.clientY < board.top) ||
      (e.clientY > board.bottom)
    );

    // Light the hand panel up.
    if ((this.handEl != null) && (!this.handEl.hidden)) {
      this.handEl.classList.add("drop-ready");
      this.handEl.classList.toggle("drop-over", isOver);
    }

    // The card's picture, at the pointer while it is off the board.
    if ((this.dragGhost == null) && (ent != null)) {
      this.dragGhost = this.ghostOf(ent);
      document.body.append(this.dragGhost);
    }
    if (this.dragGhost != null) {
      this.dragGhost.hidden = !isOutside;
      this.dragGhost.style.left = `${e.clientX}px`;
      this.dragGhost.style.top = `${e.clientY}px`;
    }
  }

  /**
   * A drag off the board is over: the hand panel goes back to normal, and
   * the card's picture goes away.
   */
  endDragFromBoard() {
    this.handEl?.classList.remove("drop-ready", "drop-over");
    this.dragGhost?.remove();
    this.dragGhost = null;
  }

  /**
   * The picture of a card carried at the pointer while it is dragged off
   * the board, drawn as the hand panel draws its cards.
   *
   * @param {object} ent the card's entity
   * @returns {HTMLDivElement} the picture, hidden until it leaves the
   *   board
   */
  ghostOf(ent) {
    const drawn = this.look.drawEntity(ent);

    return h(
      "div.drag-ghost",
      { hidden: true },
      s(
        "svg",
        { viewBox: `0 0 ${drawn.w} ${drawn.h}`, class: "card-svg" },
        drawn.node,
      ),
    );
  }

  /**
   * A hand's tokens in the order to show them: sorted by the place's
   * declared order when the viewer asked for that, or else as dealt.
   *
   * @param {Array<string>} ids the place's token ids
   * @param {object|undefined} declaration the place's declaration
   * @returns {Array<string>} the ids in the order to show them
   */
  sortHand(ids, declaration) {
    let ret = ids;

    if (
      (this.handSorted === true) &&
      (declaration?.order_by != null) &&
      (declaration.order_by.length > 0)
    ) {
      ret = [...ids].sort((a, b) => (
        this.compareHandTokens(a, b, declaration.order_by)
      ));
    }

    return ret;
  }

  /**
   * Compare two tokens by a place's declared order: by each key in turn,
   * until one tells them apart.
   *
   * @param {string} a one token's id
   * @param {string} b the other token's id
   * @param {Array<object>} orderBy the place's order_by keys
   * @returns {number} below 0 when a comes first, above 0 when b does,
   *   and 0 when no key tells them apart
   */
  compareHandTokens(a, b, orderBy) {
    const propsA = this.tokenProperties(a);
    const propsB = this.tokenProperties(b);
    let ret = 0;
    let i = 0;
    let valueA = null;
    let valueB = null;

    // Each key in turn, until one tells them apart. (A numeric key over
    // values that are not numbers gives NaN, which tells nothing apart.)
    while (((ret === 0) || (Number.isNaN(ret))) && (i < orderBy.length)) {
      valueA = propsA[orderBy[i].property];
      valueB = propsB[orderBy[i].property];
      switch (orderBy[i].style) {
        case "custom":
          ret = (
            orderBy[i].custom_order.indexOf(valueA) -
            orderBy[i].custom_order.indexOf(valueB)
          );
          break;
        case "alphabetical":
          ret = String(valueA).localeCompare(String(valueB));
          break;
        default:
          ret = (valueA ?? 0) - (valueB ?? 0);
          break;
      }
      if (orderBy[i].direction === "descending") {
        ret = -ret;
      }
      i += 1;
    }

    // Nothing told them apart.
    if (Number.isNaN(ret)) {
      ret = 0;
    }

    return ret;
  }

  /**
   * A token's declared properties.
   *
   * @param {string} id the token's id
   * @returns {object} its kind's properties, or an empty object
   */
  tokenProperties(id) {
    const kind = this.state.entities?.[id]?.kind;

    return this.look.tokens.get(kind)?.properties || {};
  }

  /**
   * The side panel's "On the table" list: every place not drawn on the
   * scene and not the viewer's own (those are in the hand), with its
   * count and its last few face-up tokens.
   */
  renderPlaces() {
    const onScene = this.scenePlaces();
    const rows = [];

    if (this.placesEl) {
      // The places to list.
      for (const [pid, contents] of Object.entries(this.state.places || {})) {
        if ((!onScene.has(pid)) && (!this.isMinePlace(pid))) {
          rows.push([pid, contents]);
        }
      }

      // Hidden when there are none.
      if (!rows.length) {
        this.placesEl.hidden = true;
      } else {
        this.placesEl.hidden = false;
        clear(
          this.placesEl,
          h("h3", {}, "On the table"),
          h("ul.place-list", {}, rows.map(([pid, contents]) => (
            this.placeRow(pid, contents)
          ))),
        );
      }
    }
  }

  /**
   * Whether a place is the viewer's own and shown in their hand: one of
   * their seat's places, while not in the table view.
   *
   * @param {string} pid the place's id
   * @returns {boolean} whether it is theirs
   */
  isMinePlace(pid) {
    return (
      (this.seat != null) &&
      (pid.endsWith(`.${this.seat}`)) &&
      (this.view !== "table")
    );
  }

  /**
   * One row of the "On the table" list.
   *
   * @param {string} pid the place's id
   * @param {Array|object} contents what the viewer sees of it: token ids,
   *   or only a count
   * @returns {HTMLLIElement} the row
   */
  placeRow(pid, contents) {
    const [base, owner] = pid.split(".");
    const declaration = (this.look.declaration.places || [])
      .find((p) => p.place_id === base);
    let who = "";
    let count = contents?.count ?? 0;
    let faces = [];
    let cards = null;

    // Whose it is, and how many it holds.
    if (owner) {
      who = ` · ${this.seatName(owner)}`;
    }
    if (Array.isArray(contents)) {
      count = contents.length;
      faces = contents.map((id) => this.state.entities?.[id])
        .filter((e) => ((e) && (!e.hidden)));
    }

    // Its last eight face-up tokens, small.
    if (faces.length) {
      cards = h("div.mini-cards", {}, faces.slice(-8).map((ent) => {
        const { node, w, h: hh } = this.look.drawEntity(ent);
        return s("svg", { viewBox: `0 0 ${w} ${hh}`, class: "mini-card" }, node);
      }));
    }

    return h(
      "li",
      {},
      h("span", {}, `${declaration?.name || base}${who}`),
      h("span.muted", {}, `${count}`),
      cards,
    );
  }

  renderState() {
    if (!this.stateEl) return;
    const mechanics = this.state.mechanics || {};
    const ids = Object.keys(mechanics);
    this.renderTurn();
    const show = ids.filter((id) => mechanics[id] && Object.keys(mechanics[id]).length && !(id === "tabletop.free" && Object.keys(mechanics[id]).every((k) => ["z", "conceded"].includes(k))));
    const sheets = this.renderSheets();
    if (!show.length && !sheets) { this.stateEl.hidden = true; return; }
    this.stateEl.hidden = false;
    clear(this.stateEl, show.map((id) => h("div.mechanic", {}, h("h3", {}, this.text.has(`${id}.title`) ? this.text.t(`${id}.title`) : id), this.renderValue(mechanics[id], id))), sheets);
  }

  /** Every entity with stats, as the server computed them: base values, and derived stats and modifiers' effects
   * with their breakdowns (hover a value to see where it comes from). Each offers its template's exports, a sheet
   * to print or save from this view (spec section 23.9), unless the table switched exports off. */
  renderSheets() {
    const declarations = Object.fromEntries((this.look.declaration.stats || []).map((d) => [d.key, d]));
    const mine = (e) => this.view !== "hand" || this.isGM() || [e.owner, e.controller].includes(this.seat);
    const rows = Object.entries(this.state.entities || {}).filter(([, e]) => e && !e.hidden && (e.stats || e.derived) && mine(e));
    if (!rows.length) return null;
    return h("div.mechanic.sheets", {}, h("h3", {}, "Characters"), rows.map(([id, e]) => {
      const keys = [...new Set([...Object.keys(e.stats || {}), ...Object.keys(e.derived || {})])];
      const exports = this.state.settings?.["export.enabled"] === false ? [] : exportsFor(this.look, e);
      return h("div.sheet", {}, h("h4", {}, e.name || id, exports.map((x) => h("button.ghost.small", { type: "button", onclick: () => openExport(this, id, x) },
        this.text.has(`export.${x.declaration.name}`) ? this.text.t(`export.${x.declaration.name}`) : x.declaration.name.replace(/_/g, " ")))),
        h("dl.kv", {}, keys.map((k) => {
          const d = e.derived?.[k];
          const value = d ? d.value : e.stats[k];
          return [h("dt", {}, declarations[k]?.name || k.replace(/_/g, " ")),
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
    return h("span", { class: typeof v === "number" ? "number" : "" }, String(v));
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
        h("ul", {}, p.stats.filter((x) => !x.bucket).map((x) => h("li", {}, `${x.name}: ${formatNumber(x.value)}`)),
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
      else if (st.choices) input = h("select", { disabled: locked || this.seat == null }, st.choices.map((c) => h("option", { value: c, selected: c === st.value }, c === "" ? "(the game's own)" : c)));
      else if (["int", "float", "number"].includes(st.value_type)) input = h("input", { type: "number", value: st.value, disabled: locked || this.seat == null });
      else if (["list", "json"].includes(st.value_type)) input = h("textarea", { rows: 1, disabled: locked || this.seat == null }, JSON.stringify(st.value));
      else input = h("input", { type: "text", value: st.value ?? "", disabled: locked || this.seat == null });
      input.addEventListener("change", async () => {
        let value = st.value_type === "bool" ? input.checked : ["int", "float", "number"].includes(st.value_type) ? Number(input.value) :
          ["list", "json"].includes(st.value_type) ? JSON.parse(input.value) : input.value;
        const ack = await this.act("settings.change", { key: st.key, value });
        if (ack.outcome === "accepted") toast(lobby ? "Changed. Everyone's ready was cleared." : (st.change_mode === "rules" ? "Changed." : "Put to a vote."));
      });
      const expansion = (this.snap.game.expansion_declarations || []).find((x) => `expansions.${x.expansion_id}` === st.key);
      const name = expansion ? expansion.name : st.description ? this.text.t({ key: st.description }) : st.key;
      return h("tr", { class: locked ? "locked" : "" }, h("th", {}, name, h("div.muted.small", {}, `${st.origin || ""}${st.mutability === "immutable" ? " · locks at start" : ""}${st.lobby_only ? " · chosen in the lobby" : ""}${!lobby && st.change_mode !== "rules" ? ` · changes by ${st.change_mode}` : ""}`)), h("td", {}, input));
    });
    const preferences = this.view === "table" ? this.displayPreferences() : null;
    dialog("Table settings", h("div.settings", {}, preferences, h("table.settings-table", {}, h("tbody", {}, rows))), [["Close", true]]);
  }

  displayPreferences() {
    const hide = h("input", { type: "checkbox", checked: !!this.display.hide_outside_safe_zone });
    hide.addEventListener("change", () => { this.display.hide_outside_safe_zone = hide.checked; this.saveDisplay(); this.renderScene(); });
    const color = h("input", { type: "color", value: this.display.tabletop?.color || this.scene?.tabletop?.color || "#000000" });
    color.addEventListener("change", () => { this.display.tabletop = { ...(this.display.tabletop || {}), color: color.value, fit: "tile" }; this.saveDisplay(); this.renderScene(); });
    return h("div.display-preferences", {}, h("h3", {}, "This display"),
      h("label.field.inline", {}, hide, h("span", {}, "Hide everything outside the safe zone (for projecting)")),
      h("label.field.inline", {}, color, h("span", {}, "Tabletop color")),
      h("p.muted", {}, "Display preferences are yours: never logged, saved with your account."));
  }

  saveDisplay() {
    this.viewerPreferences.display = this.display;
    this.viewerPreferences.saveDisplay().catch((e) => toast(e.message, "warn"));
  }

  // ---------------------------------------------------------------- the viewer's look (spec 23.5, 23.6, 23.10)

  setTextLayers() {
    this.text.setLayers([{ name: "flavor", strings: this.look.flavorStrings }, { name: "game", strings: this.look.strings }]);
  }

  /** Whether the Look panel has anything to offer: a slot this viewer may rebind, or a theme for the game. */
  hasLook() {
    return [...this.look.slots.values()].some((sl) => sl.scope !== "table" && sl.kind !== "text") || !!this.themesHere?.length;
  }

  async loadViewerPreferences() {
    await this.viewerPreferences.load(this.display);
    this.look.view = { ...this.look.view, peek: this.viewerPreferences.peek, settings: this.state?.settings || {} };
    this.themesHere = (await this.net.request("themes.list", { table_id: this.id }).catch(() => ({ themes: [] }))).themes;
    this.renderHeader();
    this.renderScene();
  }

  onPreferencesChange(what) {
    if (what === "peek") {
      this.look.view = { ...this.look.view, peek: this.viewerPreferences.peek };
      this.renderAll();
    } else {
      this.refreshLook();
    }
  }

  /**
   * After a theme, binding or flavor change: fetch what the new look needs in the background, then redraw with it.
   * Play goes on with the old look meanwhile; the gate is never involved.
   */
  async refreshLook() {
    const run = (this.lookRun = (this.lookRun || 0) + 1);
    let r;
    try {
      r = await this.net.request("themes.files", { table_id: this.id });
    } catch (e) {
      return toast(`The look could not be updated: ${e.message}`, "warn");
    }
    this.app.cache.setKeys(r.keys || {});
    const have = new Set(await this.app.cache.inventory());
    const missing = (r.files || []).filter((f) => !have.has(f.hash));
    if (missing.length) {
      this.lookPending = true;
      this.renderHeader();
      let left = missing.reduce((n, f) => n + f.size_bytes, 0);
      toast(`Updating the look… ${bytes(left)} to fetch`);
      try {
        await Promise.all(missing.map((f) => this.app.cache.download(f, (n) => { left -= n; })));
      } catch (e) {
        toast(`The look could not be fetched: ${e.message}`, "warn");
      }
      this.lookPending = false;
    }
    if (run !== this.lookRun) return;               // a later change is on its way
    for (const f of r.files || []) this.app.cache.pinned?.add(f.hash);
    await this.look.applyLook({ ...r.look, files: r.files });
    this.look.view.peek = this.viewerPreferences.peek;
    this.setTextLayers();
    this.renderAll();
    this.viewerPreferences.dispatchEvent(new CustomEvent("applied"));     // an open Look panel shows what is drawn now
  }

  enterProjection() {
    this.projecting = true;
    this.display.projection = { ...(this.display.projection || {}), enabled: true };
    this.app.firstProjection = !this.display.projection.corners?.length;
    // a game without a scene projects its public state, drawn large in the square the scene's safe zone would be
    this.boardEl = this.scene ? null : h("div.projection-board");
    this.renderScene();
    this.projector.enter(this.scene ? this.sceneView.el : this.boardEl);
  }

  renderBoard() {
    if (!this.boardEl) return;
    const pj = this.display.projection || {};
    const focus = pj.show_focus ? s("svg", { class: "projection-focus", viewBox: "0 0 100 100" },
      pj.focus_image ? this.look.image(pj.focus_image, 35, 35, 30, 30) : focusStar(50, 50, 15)) : null;
    clear(this.boardEl, h("h2", {}, this.snap.table?.name || this.snap.game.name), this.stateEl, focus);
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
    const declarations = this.look.declaration.stats || [];
    const ents = Object.entries(this.state.entities || {}).filter(([, e]) => e && !e.hidden && (e.stats || e.derived));
    if (!ents.length) return null;
    const mods = Object.entries(this.state.modifiers || {});
    const entity = h("select", { "aria-label": "Entity" }, ents.map(([id, e]) => h("option", { value: id }, e.name || id)));
    const stat = h("select", { "aria-label": "Stat" }, declarations.map((d) => h("option", { value: d.key }, d.name || d.key)));
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
    const pick = h("select", {}, assets.map((a) => h("option", { value: a.asset_reference }, `${a.name} (${a.pool})`)));
    const play = h("select", { "aria-label": "How a video plays", title: "How a shown video plays (a picture stays until hidden)" },
      [["once", "video plays once"], ["loop", "video loops"], ["hold", "video holds its last frame"]].map(([v, l]) => h("option", { value: v }, l)));
    const shows = Object.entries(this.state.stage || {});
    const media = this.feature("media"), handouts = this.feature("handouts");
    const body = h("div.gm-tools", {},
      media || handouts ? [h("h3", {}, "Media"),
        h("p.muted", {}, `Upload to this table's pool, then ${media && handouts ? "show it on the stage or hand it out" : media ? "show it on the stage" : "hand it out"}.`),
        h("div.row", {}, file, h("button", { onclick: async () => { if (file.files[0]) { await this.app.upload(file.files[0], { pool: "table", table_id: this.id }); toast("Uploaded."); document.querySelector("dialog[open]")?.close(); this.openGMTools(); } } }, "Upload")),
        assets.length ? h("div.row", {}, pick,
          media ? play : null,
          media ? h("button", { onclick: () => this.act("media.show", { asset: pick.value, audience: "all", play: play.value }) }, "Show to everyone") : null,
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

/**
 * Whether a patch touches any path under a prefix.
 *
 * @param {Array<object>} patch the patch's operations
 * @param {string} prefix the start of the paths to look for
 * @returns {boolean} whether any operation's path starts with it
 */
function patchTouches(patch, prefix) {
  return patch.some((op) => op.path.startsWith(prefix));
}

/**
 * Whether this browser kept the header tucked away last time.
 *
 * @returns {boolean} whether it did; not when storage is blocked
 */
function storedTucked() {
  let ret = false;

  try {
    ret = (localStorage.getItem(TUCKED_KEY) === "1");
  } catch {
    // Storage is blocked: shown.
    ret = false;
  }

  return ret;
}

function describeAction(text, action, seatName) {
  const params = action.params || {};
  const label = text.has(`${action.type}`) ? text.t({ key: action.type, params }) : action.type;
  const parts = Object.entries(params).map(([k, v]) => `${k.replace(/_/g, " ")}: ${k === "target" || k === "seat" ? `${seatName(v)} (seat ${v})` : JSON.stringify(v)}`);
  return `${label}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function formatNumber(v) {
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
