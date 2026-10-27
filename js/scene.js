// The scene: a virtual tabletop drawn in SVG. Outside the square safe zone is the tabletop (a color or a
// texture, pure black by default); inside it, the board's layers. The client never decides anything: dragging a
// token sends an action, and the token moves only when the server's patch says so.
import { refString } from "./layout.js";
import { h, s } from "./ui.js";

export class SceneView {
  constructor(app, look) {
    this.app = app;
    this.look = look;
    this.el = h("div.scene-wrap");
    this.svg = s("svg", { class: "scene", tabindex: "0" });
    this.el.append(this.svg);
    this.scene = null;
    this.prefs = {};
    this.tool = "hand";
    this.pings = [];
    this.svg.addEventListener("pointerdown", (e) => this.onDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onUp(e));
    this.svg.addEventListener("contextmenu", (e) => this.onContext(e));
    this.svg.addEventListener("dblclick", (e) => this.onDouble(e));
    this.svg.addEventListener("dragover", (e) => e.preventDefault());
    this.svg.addEventListener("drop", (e) => this.onDrop(e));
  }

  setScene(scene, prefs) {
    this.scene = scene;
    this.prefs = prefs || {};
  }

  pt(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  control(type) {
    return (this.app.controls || []).find((c) => c.action_type === type);
  }

  /** The control a drag of this token carries out: one the rules anchor on it and mark interactive (a creature's
   * move, whose params_schema asks for x and y), or else the free tabletop's move. */
  dragControl(id) {
    return (this.app.controls || []).find((c) => c.interactive && c.anchor === id) || this.control("tabletop.move");
  }

  render(tree) {
    const sc = this.scene;
    this.tree = tree;
    const svg = this.svg;
    svg.replaceChildren();
    if (!sc) return;
    const pad = 0;
    svg.setAttribute("viewBox", `${-pad} ${-pad} ${sc.width + 2 * pad} ${sc.height + 2 * pad}`);
    const zone = sc.safe_zone;
    const tabletop = this.prefs.tabletop || sc.tabletop || { color: "#000000" };
    const defs = s("defs");
    svg.append(defs);
    // the tabletop: everything outside the safe zone
    const big = 100000;
    if (tabletop.texture) {
      const id = "tabletop-tex";
      const pat = s("pattern", { id, patternUnits: "userSpaceOnUse", width: 256, height: 256 });
      pat.append(this.look.image(refString(tabletop.texture), 0, 0, 256, 256, tabletop.fit === "stretch" ? "stretch" : "cover"));
      defs.append(pat);
      svg.append(s("rect", { x: -big, y: -big, width: 2 * big, height: 2 * big, fill: `url(#${id})` }));
    } else {
      svg.append(s("rect", { x: -big, y: -big, width: 2 * big, height: 2 * big, fill: tabletop.color || "#000000" }));
    }
    const clipId = "safe-zone-clip";
    defs.append(s("clipPath", { id: clipId }, s("rect", { x: zone.x, y: zone.y, width: zone.side, height: zone.side })));
    const content = s("g", { class: "scene-content" });
    if (this.prefs.hide_outside_safe_zone) content.setAttribute("clip-path", `url(#${clipId})`);
    svg.append(content);
    const layers = [...(sc.layers?.length ? sc.layers : [{ key: "board", kind: "board", z: 0 }, { key: "tokens", kind: "tokens", z: 1 }, { key: "annotations", kind: "annotations", z: 2 }])]
      .sort((a, b) => a.z - b.z);
    for (const layer of layers) {
      const g = s("g", { class: `layer layer-${layer.kind}`, "data-layer": layer.key });
      content.append(g);
      if (layer.kind === "board") this.drawBoard(g);
      else if (layer.kind === "tokens") this.drawTokens(g, tree);
      else if (layer.kind === "annotations") this.drawMarks(g, tree);
      else if (layer.kind === "stage") this.drawStage(g, tree);
    }
    if (!layers.some((l) => l.kind === "stage")) this.drawStage(content, tree);
    this.pingLayer = s("g", { class: "pings" });
    content.append(this.pingLayer);
    if (this.prefs.show_safe_zone_outline !== false && !this.app.projecting) {
      svg.append(s("rect", { class: "safe-zone-outline", x: zone.x, y: zone.y, width: zone.side, height: zone.side }));
    }
    this.drawFocus(svg, zone);
  }

  drawBoard(g) {
    const sc = this.scene;
    if (sc.background) g.append(this.look.image(refString(sc.background), 0, 0, sc.width, sc.height, "stretch"));
    const grid = sc.grid || {};
    if (grid.kind === "square" && this.app.showGrid) {
      const size = grid.cell_size || 70;
      const lines = [];
      for (let x = 0; x <= sc.width; x += size) lines.push(`M${x},0V${sc.height}`);
      for (let y = 0; y <= sc.height; y += size) lines.push(`M0,${y}H${sc.width}`);
      g.append(s("path", { d: lines.join(""), class: "grid" }));
    } else if (grid.kind === "hex" && this.app.showGrid) {
      const size = grid.cell_size || 70, r = size / Math.sqrt(3);
      const cells = [];
      for (let row = -1; row * r * 1.5 < sc.height + r; row++) {
        for (let col = -1; col * size < sc.width + size; col++) {
          const cx = col * size + (row % 2 ? size / 2 : 0), cy = row * r * 1.5;
          const pts = [];
          for (let i = 0; i < 6; i++) {
            const a = Math.PI / 180 * (60 * i - 30);
            pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
          }
          cells.push(`M${pts.join("L")}Z`);
        }
      }
      g.append(s("path", { d: cells.join(""), class: "grid" }));
    }
    const graph = sc.graph;
    if (graph) {
      for (const e of graph.edges || []) {
        const a = graph.nodes.find((n) => n.node_id === e.a), b = graph.nodes.find((n) => n.node_id === e.b);
        if (a?.x != null && b?.x != null) g.append(s("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "graph-edge" }));
      }
      for (const n of graph.nodes || []) {
        if (n.region?.length) g.append(s("polygon", { points: n.region.map((p) => p.join(",")).join(" "), class: "graph-region" }));
        if (n.place_id) this.drawPlace(g, n);
      }
    }
  }

  drawPlace(g, n) {
    const tree = this.tree;
    const contents = tree?.places?.[n.place_id];
    const label = this.app.text.has(`place.${n.place_id}`) ? this.app.text.t(`place.${n.place_id}`) : (n.name || n.place_id);
    const cardW = 100, cardH = 140;
    const box = s("g", { class: "place", transform: `translate(${n.x - cardW / 2} ${n.y - cardH / 2})`, "data-place": n.place_id });
    box.append(s("rect", { class: "place-slot", width: cardW, height: cardH, rx: 10 }));
    let count = 0, top = null;
    if (Array.isArray(contents)) {
      count = contents.length;
      const id = contents[contents.length - 1];
      top = id ? tree.entities?.[id] : null;
    } else if (contents && typeof contents === "object") {
      count = contents.count ?? 0;
    }
    if (count) {
      const stackDepth = Math.min(4, Math.ceil(count / 10));
      for (let i = stackDepth; i > 0; i--) box.append(s("rect", { class: "place-stack", x: i * 1.5, y: -i * 1.5, width: cardW, height: cardH, rx: 10 }));
      if (top) {
        const { node, w, h: hh } = this.look.drawEntity(top);
        node.setAttribute("transform", `translate(${(cardW - w) / 2} ${(cardH - hh) / 2})`);
        box.append(node);
        box.dataset.token = contents[contents.length - 1];
      } else {
        const back = this.cardBack();
        if (back) box.append(back);
      }
    }
    box.append(s("text", { class: "place-label", x: cardW / 2, y: cardH + 22, "text-anchor": "middle" }, `${label}${count ? ` · ${count}` : ""}`));
    const draw = (this.app.controls || []).find((c) => c.anchor === `place:${n.place_id}` && c.action_type !== "tabletop.gather");
    if (draw) {
      box.classList.add("actionable");
      box.addEventListener("click", (e) => { if (this.tool === "hand" && !e.altKey) this.app.act(draw.action_type, draw.params); });
    }
    g.append(box);
  }

  cardBack() {
    const pile = (this.look.decl.piles || [])[0];
    const kind = pile && Object.keys(pile.contents || {})[0];
    const token = kind && this.look.tokens.get(kind);
    if (!token) return null;
    const back = this.look.sideOf(token, token.hidden_side || "back");
    const [w, hh] = this.look.sizeOfSide(back);
    const g = this.look.drawSide(back, {}, w, hh, token);
    g.setAttribute("transform", `translate(${(100 - w) / 2} ${(140 - hh) / 2})`);
    return g;
  }

  drawTokens(g, tree) {
    const here = this.scene.scene_key;
    const ents = Object.entries(tree?.entities || {}).filter(([, e]) => e && e.x != null && (e.scene == null || e.scene === here))
      .sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
    for (const [id, ent] of ents) {
      const { node, w, h: hh } = this.look.drawEntity(ent);
      const token = this.look.tokens.get(ent.kind);
      const ax = (token?.anchor_x ?? 0.5) * w, ay = (token?.anchor_y ?? 0.5) * hh;
      const wrap = s("g", { class: "token", "data-token": id,
        transform: `translate(${ent.x - ax} ${ent.y - ay}) rotate(${ent.rotation || 0} ${ax} ${ay})` });
      if (ent.owner === this.app.seat) wrap.classList.add("mine");
      if (ent.hidden && ent.owner === this.app.seat) wrap.classList.add("peek");
      wrap.append(node);
      wrap.append(s("rect", { class: "token-hit", width: w, height: hh, rx: 6 }));
      g.append(wrap);
    }
  }

  drawMarks(g, tree) {
    const here = this.scene.scene_key;
    const all = [...Object.values(tree?.marks || {}), ...(this.app.personalMarks || []).map((m) => ({ ...m, personal: true }))];
    for (const m of all) {
      if (m.scene && m.scene !== here) continue;
      const sh = m.shape || {};
      if (sh.type === "stroke" && sh.points?.length) {
        g.append(s("polyline", { class: `mark${m.personal ? " personal" : ""}`, points: sh.points.map((p) => p.join(",")).join(" "),
          stroke: sh.color || "#ffd166", "stroke-width": sh.width || 4 }));
      } else if (sh.type === "text") {
        g.append(s("text", { class: "mark-text", x: sh.x, y: sh.y, fill: sh.color || "#ffd166" }, sh.text));
      }
    }
    if (this.stroke) g.append(s("polyline", { class: "mark drawing", points: this.stroke.map((p) => p.join(",")).join(" "), stroke: this.app.penColor, "stroke-width": 4 }));
  }

  drawStage(g, tree) {
    const zone = this.scene.safe_zone;
    for (const [id, show] of Object.entries(tree?.stage || {})) {
      const w = show.w || zone.side * 0.6, hh = show.h || zone.side * 0.6;
      const x = show.x ?? zone.x + (zone.side - w) / 2, y = show.y ?? zone.y + (zone.side - hh) / 2;
      const frame = s("g", { class: "stage-item", "data-stage": id });
      frame.append(s("rect", { x: x - 8, y: y - 8, width: w + 16, height: hh + 16, rx: 12, class: "stage-frame" }));
      frame.append(this.look.image(show.asset, x, y, w, hh));
      g.append(frame);
    }
  }

  drawFocus(svg, zone) {
    const pj = this.prefs.projection;
    if (!pj?.show_focus) return;
    const size = zone.side * 0.3, x = zone.x + (zone.side - size) / 2, y = zone.y + (zone.side - size) / 2;
    if (pj.focus_image) {
      svg.append(this.look.image(pj.focus_image, x, y, size, size));
      return;
    }
    // the built-in focus pattern: a siemens star and fine lines, sharp only when the projector is focused
    const g = s("g", { class: "focus-pattern" });
    const cx = x + size / 2, cy = y + size / 2, r = size / 2;
    for (let i = 0; i < 36; i++) {
      const a1 = (i * 10) * Math.PI / 180, a2 = (i * 10 + 5) * Math.PI / 180;
      g.append(s("path", { d: `M${cx},${cy}L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}A${r},${r} 0 0 1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)}Z`, fill: "#fff" }));
    }
    g.append(s("circle", { cx, cy, r, fill: "none", stroke: "#fff", "stroke-width": 2 }));
    svg.append(g);
  }

  flash(url, anchor) {
    if (!this.pingLayer || !this.scene) return;
    const ent = anchor && this.tree?.entities?.[anchor];
    const zone = this.scene.safe_zone;
    const size = zone.side * 0.25;
    const x = ent?.x ?? zone.x + zone.side / 2, y = ent?.y ?? zone.y + zone.side / 2;
    const img = s("image", { href: url, x: x - size / 2, y: y - size / 2, width: size, height: size, class: "cue" });
    this.pingLayer.append(img);
    setTimeout(() => img.remove(), 2500);
  }

  ping(msg) {
    if (!this.pingLayer || msg.scene !== this.scene?.scene_key) return;
    const c = s("circle", { class: "ping", cx: msg.x, cy: msg.y, r: 10 });
    this.pingLayer.append(c);
    setTimeout(() => c.remove(), 1600);
  }

  // ---------------------------------------------------------------- interaction

  tokenAt(e) {
    return e.target.closest?.(".token")?.dataset.token;
  }

  onDown(e) {
    if (e.button !== 0 || this.app.view === "table") return;
    const p = this.pt(e);
    if (e.altKey) {
      this.app.ephemeral(this.scene.scene_key, p.x, p.y);
      return;
    }
    if (this.tool === "pen") {
      this.stroke = [[Math.round(p.x), Math.round(p.y)]];
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    const id = this.tokenAt(e);
    const control = id && this.dragControl(id);
    if (!control) return;
    const node = e.target.closest(".token");
    const ent = this.tree.entities[id];
    this.drag = { id, node, start: p, ent, control, moved: false, base: node.getAttribute("transform") };
    this.showReach(control, ent);
    this.svg.setPointerCapture(e.pointerId);
  }

  /** While dragging, outline how far the token may go, when its control says (speed in cells, and the cell size). */
  showReach(control, ent) {
    const hint = control.params_schema || {};
    if (!hint.speed || !hint.cell || !this.pingLayer) return;
    const c = hint.cell, col = Math.floor(ent.x / c), row = Math.floor(ent.y / c);
    const x = Math.max(0, (col - hint.speed) * c), y = Math.max(0, (row - hint.speed) * c);
    const x2 = Math.min(this.scene.width, (col + hint.speed + 1) * c), y2 = Math.min(this.scene.height, (row + hint.speed + 1) * c);
    this.reach = s("rect", { class: "reach", x, y, width: x2 - x, height: y2 - y });
    this.pingLayer.append(this.reach);
  }

  onMove(e) {
    const p = this.pt(e);
    if (this.stroke) {
      const last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) {
        this.stroke.push([Math.round(p.x), Math.round(p.y)]);
        this.render(this.tree);
      }
      return;
    }
    if (!this.drag) return;
    const dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
    if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
    this.drag.node.setAttribute("transform", `translate(${dx} ${dy}) ${this.drag.base}`);
    this.drag.node.classList.add("dragging");
  }

  async onUp(e) {
    if (this.stroke) {
      const points = this.stroke;
      this.stroke = null;
      if (points.length > 1) await this.app.commitMark({ type: "stroke", points, color: this.app.penColor, width: 4 }, this.scene.scene_key);
      this.render(this.tree);
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.reach?.remove();
    this.reach = null;
    if (!d.moved) {
      d.node.setAttribute("transform", d.base);
      return;
    }
    const p = this.pt(e);
    if (d.control.action_type !== "tabletop.move") {           // the rules' own move: it says where, and checks it
      const x = d.ent.x + (p.x - d.start.x), y = d.ent.y + (p.y - d.start.y);
      const ack = await this.app.act(d.control.action_type, { ...d.control.params, x: round(x), y: round(y) });
      if (ack.outcome !== "accepted") d.node.setAttribute("transform", d.base);
      return;
    }
    const placeEl = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest?.(".place"))?.closest(".place");
    if (placeEl && this.control("tabletop.take")) {
      const ack = await this.app.act("tabletop.take", { token: d.id, to: placeEl.dataset.place });
      if (ack.outcome !== "accepted") d.node.setAttribute("transform", d.base);
      return;
    }
    const x = d.ent.x + (p.x - d.start.x), y = d.ent.y + (p.y - d.start.y);
    const ack = await this.app.act("tabletop.move", { token: d.id, x: round(x), y: round(y), scene: this.scene.scene_key });
    if (ack.outcome !== "accepted") d.node.setAttribute("transform", d.base);
  }

  onDouble(e) {
    const id = this.tokenAt(e);
    if (!id || this.app.view === "table") return;
    const ent = this.tree.entities[id];
    const token = this.look.tokens.get(ent?.kind);
    if (token?.roll && this.control("tabletop.roll")) this.app.act("tabletop.roll", { token: id });
    else if (this.control("tabletop.flip")) this.app.act("tabletop.flip", { token: id });
  }

  onContext(e) {
    const id = this.tokenAt(e);
    if (!id || this.app.view === "table") return;
    e.preventDefault();
    const ent = this.tree.entities[id];
    const token = this.look.tokens.get(ent?.kind);
    const items = [];
    if (this.control("tabletop.flip") && (token?.sides?.length > 1 || ent.hidden)) items.push(["Flip", () => this.app.act("tabletop.flip", { token: id })]);
    if (this.control("tabletop.roll") && token?.roll) items.push(["Roll", () => this.app.act("tabletop.roll", { token: id })]);
    if (this.control("tabletop.rotate")) items.push(["Rotate 90°", () => this.app.act("tabletop.rotate", { token: id, rotation: (ent.rotation || 0) + 90 })]);
    if (this.control("tabletop.take")) items.push(["Take into my hand", () => this.app.act("tabletop.take", { token: id })]);
    if (this.app.isGM() && this.app.feature("messages")) items.push(["Speak as this…", () => this.app.speakAs(id)]);
    this.app.menu(e.clientX, e.clientY, items);
  }

  async onDrop(e) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/x-dionysus-token");
    if (!id) return;
    const p = this.pt(e);
    const placeEl = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest?.(".place"))?.closest(".place");
    if (placeEl) await this.app.act("tabletop.play", { token: id, to: placeEl.dataset.place, face_up: true });
    else await this.app.act("tabletop.play", { token: id, to: "table", x: round(p.x), y: round(p.y), face_up: !e.shiftKey, scene: this.scene.scene_key });
  }
}

const round = (v) => Math.round(v * 100) / 100;
