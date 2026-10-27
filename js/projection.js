// Projection mode (table view only): map the safe zone's four corners onto four points of the display, so the board
// lands on a physical table under a projector. Four independent corners need a perspective (projective) transform;
// three would only make parallelograms. Flips and rotation apply to the content BEFORE the corners, so the corners stay
// where the user dragged them. Corners are fractions of the viewport, so they survive a change of resolution.
// This is client-side rendering of display preferences only: no events, no server logic.
import { h } from "./ui.js";

const SIZE = 1000;                       // the safe zone is drawn at this many CSS px, then warped

export function squareToQuad(p) {
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
  const m = squareToQuad(px);
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
    this.help = h("div.projector-help", {},
      h("p", {}, "Drag the four corners onto the corners of your table."),
      h("p", {}, h("kbd", {}, "C"), " show or hide these controls · ", h("kbd", {}, "F"), " fullscreen · ",
        h("kbd", {}, "H"), " mirror · ", h("kbd", {}, "V"), " flip · ", h("kbd", {}, "R"), " rotate 90° · ",
        h("kbd", {}, "G"), " focus image · ", h("kbd", {}, "Esc"), " leave"),
      h("p.muted", {}, "Calibration is saved with your display preferences."));
    this.el.append(this.help);
    ["tl", "tr", "br", "bl"].forEach((name, i) => {
      const hd = h("div.corner-handle", { title: name, dataset: { i } });
      hd.addEventListener("pointerdown", (e) => this.grab(e, i));
      this.handles.push(hd);
      this.el.append(hd);
    });
    this.el.addEventListener("keydown", (e) => this.key(e));
    addEventListener("resize", () => this.layout());
  }

  get prefs() {
    const tv = this.app.display || {};
    tv.projection = tv.projection || { enabled: true, corners: defaultCorners(), show_focus: false, flip_horizontal: false, flip_vertical: false, rotation_deg: 0 };
    if (!tv.projection.corners?.length) tv.projection.corners = defaultCorners();
    this.app.display = tv;
    return tv.projection;
  }

  enter(sceneEl) {
    this.sceneEl = sceneEl;
    this.inner.replaceChildren(sceneEl);
    document.body.append(this.el);
    this.el.focus();
    this.setCalibrating(!this.prefs.corners || this.prefs.corners.length !== 4 || this.app.firstProjection);
    this.layout();
  }

  leave() {
    this.el.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  setCalibrating(on) {
    this.calibrating = on;
    this.el.classList.toggle("calibrating", on);
  }

  layout() {
    const p = this.prefs;
    const zone = this.app.scene?.safe_zone;
    if (!zone || !this.sceneEl) return;
    const svg = this.sceneEl.querySelector("svg");
    svg.setAttribute("viewBox", `${zone.x} ${zone.y} ${zone.side} ${zone.side}`);
    Object.assign(this.inner.style, { width: `${SIZE}px`, height: `${SIZE}px`,
      transform: `translate(${SIZE / 2}px,${SIZE / 2}px) rotate(${p.rotation_deg || 0}deg) scale(${p.flip_horizontal ? -1 : 1},${p.flip_vertical ? -1 : 1}) translate(${-SIZE / 2}px,${-SIZE / 2}px)` });
    Object.assign(this.stage.style, { width: `${SIZE}px`, height: `${SIZE}px`, transform: matrix3d(p.corners, innerWidth, innerHeight) });
    p.corners.forEach(([fx, fy], i) => Object.assign(this.handles[i].style, { left: `${fx * innerWidth}px`, top: `${fy * innerHeight}px` }));
  }

  grab(e, i) {
    e.preventDefault();
    const hd = this.handles[i];
    hd.setPointerCapture(e.pointerId);
    const move = (ev) => {
      this.prefs.corners[i] = [Math.min(1, Math.max(0, ev.clientX / innerWidth)), Math.min(1, Math.max(0, ev.clientY / innerHeight))];
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
    const p = this.prefs;
    const k = e.key.toLowerCase();
    if (k === "escape") return this.app.leaveProjection();
    if (k === "c") this.setCalibrating(!this.calibrating);
    else if (k === "f") (document.fullscreenElement ? document.exitFullscreen() : this.el.requestFullscreen()).catch(() => {});
    else if (k === "h") p.flip_horizontal = !p.flip_horizontal;
    else if (k === "v") p.flip_vertical = !p.flip_vertical;
    else if (k === "r") p.rotation_deg = ((p.rotation_deg || 0) + 90) % 360;
    else if (k === "g") { p.show_focus = !p.show_focus; this.app.renderScene(); }
    else return;
    this.layout();
    this.save();
  }

  save() {
    this.app.saveDisplay();
  }
}
