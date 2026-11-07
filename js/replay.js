// Replays: a match played back from the log, as one seat saw it ("own") or as anyone may see it now ("released"),
// drawn by the table's own renderer.
import { TableScreen } from "./table.js";
import { openDisclosures } from "./disclosures.js";
import { apply } from "./patch.js";
import { bytes, clear, dialog, h, toast } from "./ui.js";

const KEYFRAME_EVERY = 25;                 // a copy of the state every so many steps, so seeking stays quick
const SPEEDS = [0.5, 1, 2, 4, 8];

const clone = (x) => structuredClone(x);

export class ReplayScreen extends TableScreen {
  /** opts: { number, view: "own" | "released", seat, timeline } */
  constructor(app, tableId, opts) {
    super(app, tableId, opts);
    this.view = "both";                    // the layout (opts.view is which replay: "own" or "released")
    this.el.classList.add("replay");
    this.pos = 0;
    this.speed = Number(localStorage.getItem("dionysus.replaySpeed")) || 1;
    this.timer = null;
    this.onKey = (e) => {
      if (e.target.closest?.("input, textarea, select")) return;
      if (e.key === "ArrowRight") this.goTo(this.pos + 1, true);
      else if (e.key === "ArrowLeft") this.goTo(this.pos - 1);
      else if (e.key === " ") { e.preventDefault(); this.toggle(); }
    };
  }

  // a replay listens to nothing live: everything it shows came with replay.open
  attach(net) { this.net = net; }
  detach() {}

  destroy() {
    this.pause();
    removeEventListener("keydown", this.onKey);
    this.projector.leave();
  }

  get seat() { return this.rep?.seat_id ?? null; }
  isGM() { return false; }

  async start() {
    const info = h("p.muted", {}, "The server plays the log back from the start.");
    this.el.replaceChildren(h("div.gate", {}, h("h2", {}, "Loading the replay…"), info));
    const o = this.opts;
    const r = await this.net.request("replay.open", { table_id: this.id, number: o.number, view: o.view, seat: o.seat, timeline: o.timeline });
    this.rep = r;
    this.manifest = r.manifest;
    if (r.manifest.disclosures?.length) await this.app.showDisclosures(r.manifest.disclosures);
    const have = new Set(await this.app.cache.inventory());
    const missing = r.manifest.files.filter((f) => !have.has(f.hash));
    if (missing.length) {
      const total = missing.reduce((n, f) => n + f.size_bytes, 0);
      const bar = h("progress", { max: total || 1, value: 0 });
      clear(this.el.firstChild, h("h2", {}, "Fetching the game"), h("p.muted", {}, `${bytes(total)} to download.`), bar);
      let got = 0;
      await Promise.all(missing.map((f) => this.app.cache.download(f, (n) => { got += n; bar.value = got; })));
    }
    // the keys for every file the replay shows: the start's, and each step's as it came into view
    this.app.cache.setKeys(r.keys);
    for (const st of r.steps) if (st.keys) this.app.cache.setKeys(st.keys);
    this.snap = { game: r.game, table: r.table, seat_id: r.seat_id, state: null };
    this.seats = r.seats;
    this.scene = r.scene;
    this.display = {};
    this.controls = [];
    this.status = r.table.status;
    this.text.seatName = (n) => this.seatName(n);
    try {
      await this.look.load(this.manifest);
      this.lookLoaded = true;
      this.text.setLayers([{ name: "game", strings: this.look.strings }]);
    } catch (e) {
      toast(`The game's files could not be opened: ${e.message}`, "error", 10000);
    }
    this.keyframes = new Map([[0, clone(r.start)]]);
    this.state = clone(r.start);
    this.snap.state = this.state;
    addEventListener("keydown", this.onKey);
    this.layout();
    // back where we were (by event, since releasing data can add steps), or at the start
    this.goTo(o.atSequence ? this.steps.filter((st) => st.sequence <= o.atSequence).length : 0);
  }

  // ---------------------------------------------------------------- moving through the steps

  get steps() { return this.rep.steps; }

  /** Show the state after the first i steps. A single step forward plays its cues, as live play did. */
  goTo(i, cues = false) {
    i = Math.max(0, Math.min(this.steps.length, i));
    const one = cues && i === this.pos + 1;
    let k = i;
    while (!this.keyframes.has(k)) k--;
    const state = clone(this.keyframes.get(k));
    for (let j = k; j < i; j++) {
      apply(state, this.steps[j].patch || []);
      if ((j + 1) % KEYFRAME_EVERY === 0 && !this.keyframes.has(j + 1)) this.keyframes.set(j + 1, clone(state));
    }
    this.pos = i;
    this.state = state;
    this.snap.state = state;
    this.log = this.rebuildLog(i);
    this.renderAll();
    const step = this.steps[i - 1];
    if (one && step?.cues?.length) this.playCues(step.cues);
    if (i >= this.steps.length) this.pause();
  }

  /** The table talk and announcements as they stood after step i, in the order they happened. */
  rebuildLog(i) {
    const items = (this.state.messages || []).map((m) => ({ kind: "message", msg: m, sequence: m.sequence }));
    for (const st of this.steps.slice(0, i)) {
      if (st.announce) items.push({ kind: "announce", text: this.text.t(st.announce.text), sequence: st.sequence, type: st.event_type });
    }
    return items.sort((a, b) => a.sequence - b.sequence).slice(-200);
  }

  play() {
    if (this.timer) return;
    if (this.pos >= this.steps.length) this.goTo(0);
    const tick = () => {
      this.goTo(this.pos + 1, true);
      this.timer = this.pos < this.steps.length ? setTimeout(tick, 1000 / this.speed) : null;
      this.renderTransport();
    };
    this.timer = setTimeout(tick, 300);
    this.renderTransport();
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.renderTransport();
  }

  toggle() { this.timer ? this.pause() : this.play(); }

  // ---------------------------------------------------------------- drawing

  async act() { toast("This is a replay: nothing here changes the table.", "info"); return { outcome: "rejected" }; }
  composer() { return h("p.muted.small.replay-note", {}, "A replay: table talk is shown as it stood at this step."); }
  renderLobby() { if (this.lobbyEl) this.lobbyEl.hidden = true; }
  renderControls() { if (this.controlsEl) clear(this.controlsEl); }

  layout() {
    super.layout();
    this.transportEl = h("div.replay-bar");
    this.stepEl = h("section.step-panel");
    this.header.after(this.transportEl);
    this.el.querySelector(".table-side")?.prepend(this.stepEl);
    this.renderTransport();
    this.renderStep();
  }

  renderAll() {
    super.renderAll();
    this.renderTransport();
    this.renderStep();
  }

  renderHeader() {
    const r = this.rep;
    const who = r.view === "own" ? `your view as ${this.seatName(r.seat_id)}` : "what anyone may see now";
    const tools = [];
    tools.push(h("button.ghost", { onclick: () => this.switchView() }, r.view === "own" ? "What anyone may see" : "My own view"));
    if (r.view === "released" && r.timelines.length > 1) {
      const pick = h("select", { "aria-label": "Timeline", title: "Which line to follow" }, r.timelines.map((t) => h("option", { value: t, selected: t === r.timeline }, `line: ${t}`)));
      pick.addEventListener("change", () => this.app.openReplay(this.id, r.number, { view: "released", timeline: pick.value }));
      tools.push(pick);
    }
    tools.push(h("button.ghost", { onclick: () => openDisclosures(this.app, this.id, r.number,
      { seatName: (n) => this.seatName(n), after: () => this.app.openReplay(this.id, r.number, { ...this.opts, atSequence: this.steps[this.pos - 1]?.sequence }) }) }, "Hidden data"));
    if (r.journal?.length) tools.push(h("button.ghost", { onclick: () => this.showJournal() }, "Journal"));
    if (this.scene) tools.push(h("button.ghost", { onclick: () => { this.showGrid = !this.showGrid; this.renderScene(); }, title: "Show or hide the grid" }, "Grid"));
    clear(this.header,
      h("div.title", {}, h("button.back", { onclick: () => this.app.go("lobby"), title: "Back to the tables" }, "←"),
        h("div", {}, h("h1", {}, `${r.table.name || r.game.name} · replay of match ${r.number}`),
          h("p.muted", {}, `${r.game.name} · ${who}${r.timeline && r.timeline !== "main" ? ` · following line ${r.timeline}` : ""}`))),
      h("div.tools", {}, tools));
  }

  renderTransport() {
    if (!this.transportEl) return;
    const n = this.steps.length;
    const step = this.steps[this.pos - 1];
    const slider = h("input", { type: "range", min: 0, max: n, value: this.pos, "aria-label": "Position in the replay" });
    slider.addEventListener("input", () => { this.pause(); this.goTo(Number(slider.value)); });
    const speed = h("select", { "aria-label": "Speed" }, SPEEDS.map((x) => h("option", { value: x, selected: x === this.speed }, `${x}×`)));
    speed.addEventListener("change", () => { this.speed = Number(speed.value); localStorage.setItem("dionysus.replaySpeed", speed.value); });
    clear(this.transportEl,
      h("button.ghost", { onclick: () => { this.pause(); this.goTo(0); }, title: "To the start", "aria-label": "To the start" }, "⏮"),
      h("button.ghost", { onclick: () => { this.pause(); this.goTo(this.pos - 1); }, title: "One step back (←)", "aria-label": "One step back" }, "◀"),
      h("button.primary", { onclick: () => this.toggle(), title: "Play or pause (space)" }, this.timer ? "Pause" : "Play"),
      h("button.ghost", { onclick: () => { this.pause(); this.goTo(this.pos + 1, true); }, title: "One step forward (→)", "aria-label": "One step forward" }, "▶"),
      h("button.ghost", { onclick: () => { this.pause(); this.goTo(n); }, title: "To the end", "aria-label": "To the end" }, "⏭"),
      slider, speed,
      h("span.muted.small.where", {}, this.pos ? `Step ${this.pos} of ${n} · event ${step.sequence}` : `The start · ${n} steps`));
  }

  /** What happened at this step: the event, who did it, where its outcome came from, and what it was. */
  renderStep() {
    if (!this.stepEl) return;
    const st = this.steps[this.pos - 1];
    if (!st) {
      clear(this.stepEl, h("h3", {}, "This step"), h("p.muted", {}, `The table as match ${this.rep.number} began. Step forward to watch it.`));
      return;
    }
    const who = st.actor != null ? this.seatName(st.actor) : "the table";
    if (st.redacted) {
      clear(this.stepEl, h("h3", {}, "This step"), h("p", {}, `${who}: something this view may not show.`),
        h("p.muted.small", {}, "What it changed that this view may see is shown; the rest stays hidden until it is released."));
      return;
    }
    const json = (v) => h("pre.small", {}, JSON.stringify(v, null, 1));
    clear(this.stepEl, h("h3", {}, "This step"),
      h("p", {}, h("b", {}, st.event_type), ` by ${who}`, st.timeline && st.timeline !== "main" ? ` · line ${st.timeline}` : "",
        st.outcome === "rejected" ? h("span.badge", {}, "refused") : null),
      st.announce ? h("p.muted", {}, this.text.t(st.announce.text)) : null,
      st.reject_reason ? h("p.muted", {}, `Refused: ${st.reject_reason}`) : null,
      st.source ? h("p.small", {}, `Outcome from ${sourceText(st.source)}${st.source_by != null ? `, submitted by ${this.seatName(st.source_by)}` : ""}`) : null,
      st.result && Object.keys(st.result).length ? h("details", { open: true }, h("summary", {}, "Outcome"), json(st.result)) : null,
      st.did && Object.keys(st.did).length ? h("details", {}, h("summary", {}, "What was asked"), json(st.did)) : null);
  }

  switchView() {
    const r = this.rep;
    if (r.view === "own") return this.app.openReplay(this.id, r.number, { view: "released" });
    this.app.openReplay(this.id, r.number, { view: "own" });
  }

  showJournal() {
    dialog("Journal", h("div.journal-list", {}, this.rep.journal.map((e) => h("article.journal-entry", {},
      h("header", {}, h("b", {}, this.seatName(e.seat)), h("span.muted", {}, ` · ${e.visibility}${e.written_by ? ` · by ${e.written_by}` : ""}`)),
      h("p", {}, e.body)))), [["Close", true]]);
  }
}

function sourceText(source) {
  return { server_rng: "the server's dice", player_submitted: "a player's own dice", gm_entered: "the GM", ai: "an AI", imported: "an import" }[source] || source;
}
