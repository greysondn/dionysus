// Projection mode (table view only): map the safe zone's four corners onto four points of the display, so the board
// lands on a physical table under a projector. Four independent corners need a perspective (projective) transform;
// three would only make parallelograms. Flips and rotation apply to the content BEFORE the corners, so the corners stay
// where the user dragged them. Corners are fractions of the viewport, so they survive a change of resolution.
// This is client-side rendering of display preferences only: no events, no server logic.
import { h } from "./ui.js";

const SIZE = 1000;                       // the safe zone is drawn at this many CSS px, then warped

export function squareToQuadrilateral(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  return { a: x1 - x0 + g * x1, b: x3 - x0 + hh * x3, c: x0, d: y1 - y0 + g * y1, e: y3 - y0 + hh * y3, f: y0, g, h: hh };
}

export function matrix3d(corners, w, hgt) {
  const px = corners.map(([fx, fy]) => [fx * w, fy * hgt]);
  const m = squareToQuadrilateral(px);
  const k = 1 / SIZE;
  return `matrix3d(${m.a * k},${m.d * k},0,${m.g * k},${m.b * k},${m.e * k},0,${m.h * k},0,0,1,0,${m.c},${m.f},0,1)`;
}

export function defaultCorners() {
  const vw = innerWidth, vh = innerHeight, side = Math.min(vw, vh) * 0.9;
  const x0 = (vw - side) / 2 / vw, y0 = (vh - side) / 2 / vh, x1 = x0 + side / vw, y1 = y0 + side / vh;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export class Projector {
  constructor(app) {
    this.app = app;
    this.el = h("div.projector", { tabindex: "0" });
    this.stage = h("div.projector-stage");
    this.inner = h("div.projector-inner");
    this.stage.append(this.inner);
    this.el.append(this.stage);
    this.handles = [];
    this.calibrating = false;
    // the calibration controls: every key has a button, so a mouse or a touch screen is enough
    const btn = (label, key, title) => h("button", { type: "button", title, onclick: () => { this.command(key); this.el.focus(); } }, label);
    this.toggles = {
      h: btn("Mirror", "h", "Mirror left to right, for rear projection (H)"),
      v: btn("Flip", "v", "Flip upside down, for a ceiling mount (V)"),
      g: btn("Focus image", "g", "Show a pattern in the middle to focus the projector (G)"),
    };
    this.rotation = h("span.muted");
    this.help = h("div.projector-help", {},
      h("p", {}, "Drag the four corners onto the corners of your table."),
      h("div.projector-buttons", {},
        btn("Fullscreen", "f", "Fullscreen on and off (F)"), this.toggles.h, this.toggles.v,
        btn("Rotate 90°", "r", "Rotate a quarter turn, for a portrait mount (R)"), this.rotation, this.toggles.g,
        btn("Reset corners", "reset", "Put the corners back to a centered square")),
      h("div.projector-buttons", {},
        btn("Done", "c", "Hide these controls (C). Move the mouse to bring back a button for them"),
        btn("Leave projection", "escape", "Back to the table view (Esc)")),
      h("p.muted", {}, "Keys: ", h("kbd", {}, "C"), " controls · ", h("kbd", {}, "F"), " fullscreen · ", h("kbd", {}, "H"), " mirror · ",
        h("kbd", {}, "V"), " flip · ", h("kbd", {}, "R"), " rotate · ", h("kbd", {}, "G"), " focus · ", h("kbd", {}, "Esc"), " leave. ",
        "Calibration is saved with your display preferences."));
    this.el.append(this.help);
    // with the controls hidden, moving the pointer shows one small button for a while
    this.reveal = h("button.projector-reveal", { type: "button", onclick: () => { this.setCalibrating(true); this.el.focus(); } }, "Projection controls");
    this.el.append(this.reveal);
    this.el.addEventListener("pointermove", () => this.peek());
    ["tl", "tr", "br", "bl"].forEach((name, i) => {
      const hd = h("div.corner-handle", { title: name, dataset: { i } });
      hd.addEventListener("pointerdown", (e) => this.grab(e, i));
      this.handles.push(hd);
      this.el.append(hd);
    });
    this.el.addEventListener("keydown", (e) => this.key(e));
    addEventListener("resize", () => this.layout());
  }

  get preferences() {
    const tv = this.app.display || {};
    tv.projection = tv.projection || { enabled: true, corners: defaultCorners(), show_focus: false, flip_horizontal: false, flip_vertical: false, rotation_degrees: 0 };
    if (!tv.projection.corners?.length) tv.projection.corners = defaultCorners();
    this.app.display = tv;
    return tv.projection;
  }

  /** Project an element: the scene (its safe zone fills the square), or for a game without one, a board the table
   * screen builds to fill the square. */
  enter(contentEl) {
    this.contentEl = contentEl;
    this.inner.replaceChildren(contentEl);
    document.body.append(this.el);
    this.el.focus();
    this.setCalibrating(!this.preferences.corners || this.preferences.corners.length !== 4 || this.app.firstProjection);
    this.layout();
  }

  leave() {
    this.el.remove();
    clearTimeout(this.peekTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  setCalibrating(on) {
    this.calibrating = on;
    this.el.classList.toggle("calibrating", on);
    this.el.classList.remove("peek");
  }

  peek() {
    if (this.calibrating) return;
    this.el.classList.add("peek");
    clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => this.el.classList.remove("peek"), 2500);
  }

  layout() {
    const p = this.preferences;
    if (!this.contentEl) return;
    const zone = this.app.scene?.safe_zone;
    const svg = zone && this.contentEl.querySelector("svg.scene");
    if (svg) svg.setAttribute("viewBox", `${zone.x} ${zone.y} ${zone.side} ${zone.side}`);
    Object.assign(this.inner.style, { width: `${SIZE}px`, height: `${SIZE}px`,
      transform: `translate(${SIZE / 2}px,${SIZE / 2}px) rotate(${p.rotation_degrees || 0}deg) scale(${p.flip_horizontal ? -1 : 1},${p.flip_vertical ? -1 : 1}) translate(${-SIZE / 2}px,${-SIZE / 2}px)` });
    Object.assign(this.stage.style, { width: `${SIZE}px`, height: `${SIZE}px`, transform: matrix3d(p.corners, innerWidth, innerHeight) });
    p.corners.forEach(([fx, fy], i) => Object.assign(this.handles[i].style, { left: `${fx * innerWidth}px`, top: `${fy * innerHeight}px` }));
    this.toggles.h.classList.toggle("on", !!p.flip_horizontal);
    this.toggles.v.classList.toggle("on", !!p.flip_vertical);
    this.toggles.g.classList.toggle("on", !!p.show_focus);
    this.rotation.textContent = `${p.rotation_degrees || 0}°`;
  }

  grab(e, i) {
    e.preventDefault();
    const hd = this.handles[i];
    hd.setPointerCapture(e.pointerId);
    const move = (ev) => {
      this.preferences.corners[i] = [Math.min(1, Math.max(0, ev.clientX / innerWidth)), Math.min(1, Math.max(0, ev.clientY / innerHeight))];
      this.layout();
    };
    const up = () => {
      hd.removeEventListener("pointermove", move);
      hd.removeEventListener("pointerup", up);
      this.save();
    };
    hd.addEventListener("pointermove", move);
    hd.addEventListener("pointerup", up);
  }

  key(e) {
    if (e.target.closest?.("button") && (e.key === "Enter" || e.key === " ")) return;
    if (this.command(e.key.toLowerCase())) e.preventDefault();
  }

  /** One calibration command, from a key or a button. Returns whether it was one. */
  command(k) {
    const p = this.preferences;
    if (k === "escape") { this.app.leaveProjection(); return true; }
    if (k === "c") this.setCalibrating(!this.calibrating);
    else if (k === "f") (document.fullscreenElement ? document.exitFullscreen() : this.el.requestFullscreen()).catch(() => {});
    else if (k === "h") p.flip_horizontal = !p.flip_horizontal;
    else if (k === "v") p.flip_vertical = !p.flip_vertical;
    else if (k === "r") p.rotation_degrees = ((p.rotation_degrees || 0) + 90) % 360;
    else if (k === "g") { p.show_focus = !p.show_focus; this.app.renderScene(); }
    else if (k === "reset") p.corners = defaultCorners();
    else return false;
    this.layout();
    this.save();
    return true;
  }

  save() {
    this.app.saveDisplay();
  }
}
