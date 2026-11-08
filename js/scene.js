// The scene: a virtual tabletop drawn in SVG. Outside the square safe zone is the tabletop (a color or a
// texture, pure black by default); inside it, the board's layers. The client never decides anything: dragging a
// token sends an action, and the token moves only when the server's patch says so.
import { fanLayout, insertIndex, insertMarker, resolveLook } from "./fan.js";
import { toScene, turnBack, turnedBox, turnTransform } from "./facing.js";
import { takeIntoHand } from "./hand.js";
import { referenceString } from "./layout.js";
import {
  hintText,
  myPending,
  pendingEntity,
  pendingView,
} from "./pending.js";
import {
  fillText,
  matRotation,
  matSeats,
  readPath,
  seatPath,
} from "./placemats.js";
import { holeText, valueDeclarations } from "./seatvalues.js";
import { turnSeat } from "./turn.js";
import { h, s, toast } from "./ui.js";

/** px a fan's drop area reaches past each of its ends. */
const FAN_OVERHANG = 24;

/** A grid's cell size, in px, when it doesn't say. */
const DEFAULT_CELL_SIZE = 70;

/** The share of a cell left empty on each side of a token that fits its
 * cell, when neither the token nor the grid says. */
const DEFAULT_FIT_MARGIN = 0.1;

/** px between a placemat and the ring that lights it on its seat's turn. */
const TURN_RING_GAP = 8;

/** The hover hint on one of the viewer's own pending cards. */
const PENDING_HINT = (
  "Pending: only you see it until you commit the play." +
  " Drag it onto your hand, or right-click, to take it back."
);

/** This viewer's volume for a channel (ambience, music, effects), 0 to 1. */
export function channelVolume(channel) {
  return Number(localStorage.getItem(`dionysus.volume.${channel || "effects"}`) ?? 0.8);
}

/** Play audio or video with sound if the browser allows it. Until the viewer has tapped the page it does not, so a
 * video plays muted (which every browser allows) and gains its sound on the first tap; audio waits for the tap. */
export function playMedia(el) {
  el.muted = false;
  return el.play().catch(() => {
    toast("Tap anywhere to let the table play sound.", "info");
    addEventListener("pointerdown", () => { el.muted = false; if (el.paused && !el.ended && el.isConnected) el.play().catch(() => {}); }, { once: true, capture: true });
    if (el.tagName !== "VIDEO") return;
    el.muted = true;
    return el.play().catch(() => {});
  });
}

const labels = (v) => (typeof v === "string" ? [...v] : (v || []).map(String));

/** Where a cell name stands in a scene, as the plugin API's cell_point says: a square grid's <column><row> at its
 * center, or a graph node by its node_id (or the place on it, by place_id). */
export function cellPoint(sc, name) {
  const grid = sc?.grid || {};
  if (grid.kind === "square" && grid.columns && grid.rows) {
    const size = grid.cell_size || 70;
    const cols = labels(grid.columns), rows = labels(grid.rows);
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i < cols.length; i++) if (`${cols[i]}${rows[j]}` === name) return [(i + 0.5) * size, (j + 0.5) * size];
    }
  }
  const node = (sc?.graph?.nodes || []).find((n) => n.x != null && n.y != null && (String(n.node_id) === name || n.place_id === name));
  return node ? [node.x, node.y] : null;
}

/** The built-in focus pattern: a siemens star, sharp only when the projector is focused. */
export function focusStar(cx, cy, r) {
  const g = s("g", { class: "focus-pattern" });
  for (let i = 0; i < 36; i++) {
    const a1 = (i * 10) * Math.PI / 180, a2 = (i * 10 + 5) * Math.PI / 180;
    g.append(s("path", { d: `M${cx},${cy}L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}A${r},${r} 0 0 1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)}Z`, fill: "#fff" }));
  }
  g.append(s("circle", { cx, cy, r, fill: "none", stroke: "#fff", "stroke-width": 2 }));
  return g;
}

export class SceneView {
  /**
   * Make the scene's SVG and listen to the pointer on it.
   *
   * @param {object} app the table view this scene is part of
   * @param {object} look the game's look, which draws tokens and art
   */
  constructor(app, look) {
    // What it draws, and how.
    this.app = app;
    this.look = look;
    this.el = h("div.scene-wrap");
    this.svg = s("svg", { class: "scene", tabindex: "0" });
    this.el.append(this.svg);
    this.scene = null;
    this.preferences = {};
    this.tool = "hand";
    this.pings = [];

    // Kept across renders, so a playing video is moved, not restarted:
    // the cue playing now, and what is on the stage (stage id to
    // {key, node, gone}).
    this.cueLayer = s("g", { class: "cues" });
    this.cue = null;
    this.stageItems = new Map();

    // The pointer, and drops from the hand.
    this.svg.addEventListener("pointerdown", (e) => this.onDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onUp(e));
    this.svg.addEventListener("contextmenu", (e) => this.onContext(e));
    this.svg.addEventListener("dblclick", (e) => this.onDouble(e));
    this.svg.addEventListener("dragover", (e) => this.onDragOver(e));
    this.svg.addEventListener("dragleave", () => this.clearMarker());
    this.svg.addEventListener("drop", (e) => this.onDrop(e));

    // The fans drawn now, by place id: their look and layout, to find
    // where a drop lands in one; and the insert marker showing it.
    this.fans = new Map();
    this.marker = null;
  }

  /** The scene, this display's preferences, and how far the view turns (clockwise degrees: 0, 90, 180 or 270), so
   * the viewer's side of the table is at the bottom. */
  setScene(scene, preferences, turn = 0) {
    this.scene = scene;
    this.preferences = preferences || {};
    this.turn = turn;
  }

  /** A pointer's position in the scene's own frame, whatever the view's turn. */
  pt(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return this.turn ? toScene(p.x, p.y, this.scene.width, this.scene.height, this.turn) : { x: p.x, y: p.y };
  }

  /** The turn back, as an SVG rotate about (cx, cy), that keeps a drawing as upright as its reorient asks. */
  upright(cx, cy, reorient = 90) {
    const back = turnBack(this.turn || 0, reorient);
    return back ? ` rotate(${back} ${cx} ${cy})` : "";
  }

  /** How a token kind or a place turns back: its own reorient, or the game's. */
  reorientOf(declaration) {
    return declaration?.reorient ?? this.look.declaration?.reorient ?? 90;
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
    svg.setAttribute("viewBox", turnedBox(sc.width, sc.height, this.turn || 0).join(" "));
    const zone = sc.safe_zone;
    const tabletop = this.preferences.tabletop || sc.tabletop || { color: "#000000" };
    const defs = s("defs");
    svg.append(defs);
    // everything is drawn in the scene's own frame, turned about its center to the viewer's side of the table
    const turned = s("g", { class: "turned", transform: turnTransform(sc.width, sc.height, this.turn || 0) });
    svg.append(turned);
    // the tabletop: everything outside the safe zone
    const big = 100000;
    if (tabletop.texture) {
      const id = "tabletop-tex";
      const pat = s("pattern", { id, patternUnits: "userSpaceOnUse", width: 256, height: 256 });
      pat.append(this.look.image(referenceString(tabletop.texture), 0, 0, 256, 256, tabletop.fit === "stretch" ? "stretch" : "cover"));
      defs.append(pat);
      turned.append(s("rect", { x: -big, y: -big, width: 2 * big, height: 2 * big, fill: `url(#${id})` }));
    } else {
      turned.append(s("rect", { x: -big, y: -big, width: 2 * big, height: 2 * big, fill: tabletop.color || "#000000" }));
    }
    const clipId = "safe-zone-clip";
    defs.append(s("clipPath", { id: clipId }, s("rect", { x: zone.x, y: zone.y, width: zone.side, height: zone.side })));
    const content = s("g", { class: "scene-content" });
    if (this.preferences.hide_outside_safe_zone) content.setAttribute("clip-path", `url(#${clipId})`);
    turned.append(content);
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
    content.append(this.cueLayer);
    this.placeCue();
    if (this.preferences.show_safe_zone_outline !== false && !this.app.projecting) {
      turned.append(s("rect", { class: "safe-zone-outline", x: zone.x, y: zone.y, width: zone.side, height: zone.side }));
    }
    this.drawFocus(turned, zone);
  }

  /**
   * Draw the board layer: its background, its grid when the viewer shows
   * it, and its graph.
   *
   * @param {SVGGElement} g the layer's group
   */
  drawBoard(g) {
    const sc = this.scene;
    const declared = (this.look.declaration.scenes || [])
      .find((d) => d.scene_key === sc.scene_key);
    let grid = sc.grid;
    let bgSlot = sc.background_slot;
    let bg = referenceString(sc.background);

    // The background. A background slot resolves through the viewer's
    // look (spec 23.5), drawn in the scene's own box.
    if ((bgSlot == null) || (bgSlot === "")) {
      bgSlot = declared?.background_slot;
    }
    if (
      ((bgSlot != null) && (bgSlot !== "")) &&
      (this.look.slots.has(bgSlot))
    ) {
      bg = this.look.slotReference(bgSlot, sc.background).reference;
    }
    if ((bg != null) && (bg !== "")) {
      g.append(this.look.image(bg, 0, 0, sc.width, sc.height, "stretch"));
    }

    // The grid, when the viewer shows it.
    if (grid == null) {
      grid = {};
    }
    if ((grid.kind === "square") && (this.app.showGrid)) {
      g.append(this.squareGrid(grid));
    } else if ((grid.kind === "hex") && (this.app.showGrid)) {
      g.append(this.hexGrid(grid));
    }

    // The graph: its edges, its regions and its places.
    this.fans = new Map();
    this.marker = null;
    if (sc.graph) {
      this.drawGraph(g, sc.graph);
    }

    // The seats' placemats, and the board's own labels.
    this.drawPlacemats(g);
    for (const label of sc.labels || []) {
      this.drawLabel(g, label, null, true);
    }
  }

  /**
   * The lines of a square grid, over the whole scene.
   *
   * @param {object} grid the scene's grid
   * @returns {SVGPathElement} the grid's lines
   */
  squareGrid(grid) {
    const sc = this.scene;
    const size = grid.cell_size || 70;
    const lines = [];

    // Down the columns, then across the rows.
    for (let x = 0; x <= sc.width; x += size) {
      lines.push(`M${x},0V${sc.height}`);
    }
    for (let y = 0; y <= sc.height; y += size) {
      lines.push(`M0,${y}H${sc.width}`);
    }

    return s("path", { d: lines.join(""), class: "grid" });
  }

  /**
   * The outlines of a pointy-top hex grid, over the whole scene.
   *
   * @param {object} grid the scene's grid
   * @returns {SVGPathElement} the grid's cells
   */
  hexGrid(grid) {
    const sc = this.scene;
    const size = grid.cell_size || 70;
    const r = size / Math.sqrt(3);
    const cells = [];
    let cx = 0;
    let cy = 0;

    // One hexagon per cell, every other row moved half a cell across.
    for (let row = -1; row * r * 1.5 < sc.height + r; row++) {
      for (let col = -1; col * size < sc.width + size; col++) {
        cx = col * size;
        if ((row % 2) !== 0) {
          cx += size / 2;
        }
        cy = row * r * 1.5;
        cells.push(hexagon(cx, cy, r));
      }
    }

    return s("path", { d: cells.join(""), class: "grid" });
  }

  /**
   * Draw a board graph: its edges, its nodes' regions, and the places on
   * its nodes.
   *
   * @param {SVGGElement} g the layer's group
   * @param {object} graph the scene's graph
   */
  drawGraph(g, graph) {
    let a = null;
    let b = null;

    // The edges between nodes that have a position.
    for (const edge of graph.edges || []) {
      a = graph.nodes.find((n) => n.node_id === edge.a);
      b = graph.nodes.find((n) => n.node_id === edge.b);
      if ((a?.x != null) && (b?.x != null)) {
        g.append(s("line", {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "graph-edge",
        }));
      }
    }

    // Each node's region, and the place on it.
    for (const node of graph.nodes || []) {
      if (node.region?.length) {
        g.append(s("polygon", {
          points: node.region.map((p) => p.join(",")).join(" "),
          class: "graph-region",
        }));
      }
      if (node.place_id) {
        this.drawPlace(g, node);
      }
    }
  }

  /**
   * Draw the place on a graph node, as its look says, turned back for
   * the viewer as the place's reorient says.
   *
   * @param {SVGGElement} g the layer's group
   * @param {object} n the node the place is on
   */
  drawPlace(g, n) {
    const declaration = this.placeDeclaration(n.place_id);

    this.drawPlaceAt(g, {
      placeId: n.place_id,
      baseId: n.place_id,
      name: n.name || n.place_id,
      x: n.x,
      y: n.y,
      look: resolveLook(declaration?.look, n.look),
      reorient: this.reorientOf(declaration),
    });
  }

  /**
   * A place's declaration, by its id or, for a seat's place
   * (play_a.2), its base id.
   *
   * @param {string} placeId the place's id
   * @returns {object|undefined} the declaration
   */
  placeDeclaration(placeId) {
    const places = this.look.declaration.places || [];
    let ret = places.find((p) => p.place_id === placeId);
    let base = "";

    // A seat's place: its base id, before the seat number.
    if ((ret == null) && (placeId.includes("."))) {
      base = placeId.slice(0, placeId.lastIndexOf("."));
      ret = places.find((p) => p.place_id === base);
    }

    return ret;
  }

  /**
   * Draw a place at a point: fanned, when its look fans it and the
   * viewer sees its tokens, or else as a stack.
   *
   * @param {SVGGElement} g the group to draw into
   * @param {object} spec the place's id and base id, its name, its
   *   center (x, y), its resolved look, and its reorient (null: it does
   *   not turn back, as in a placemat)
   */
  drawPlaceAt(g, spec) {
    const contents = this.tree?.places?.[spec.placeId];
    const entries = myPending(this.tree, this.app.seat);
    const held = new Map();

    // A fan shows the viewer's own pending cards for it, faded, where
    // they will land.
    for (const entry of entries) {
      if (entry.to === spec.placeId) {
        held.set(entry.token, entry);
      }
    }

    if ((spec.look.mode !== "stack") && (Array.isArray(contents))) {
      this.drawFan(
        g,
        spec,
        pendingView(contents, entries, spec.placeId),
        held,
      );
    } else {
      this.drawStack(g, spec, contents);
    }
  }

  /**
   * A place's name, in the viewer's language when the game has it.
   *
   * @param {object} spec the place, as drawPlaceAt takes it
   * @returns {string} its name
   */
  placeName(spec) {
    let ret = spec.name;

    if (this.app.text.has(`place.${spec.baseId}`)) {
      ret = this.app.text.t(`place.${spec.baseId}`);
    }

    return ret;
  }

  /**
   * What a place says under itself, as its look's label says: its name
   * and count, its count, or nothing.
   *
   * @param {object} spec the place, as drawPlaceAt takes it
   * @param {number} count how many it holds
   * @returns {string} the caption
   */
  placeCaption(spec, count) {
    let ret = "";

    switch (spec.look.label) {
      case "none":
        ret = "";
        break;
      case "count":
        ret = `${count}`;
        break;
      default:
        ret = this.placeName(spec);
        if (count) {
          ret = `${ret} · ${count}`;
        }
    }

    return ret;
  }

  /**
   * The group a place is drawn in: its box's top-left corner at the
   * place's center less half the box, turned back about the box's
   * middle when the place turns back.
   *
   * @param {object} spec the place, as drawPlaceAt takes it
   * @param {number} width its box's width
   * @param {number} height its box's height
   * @returns {SVGGElement} the group
   */
  placeGroup(spec, width, height) {
    const corner = `translate(${spec.x - width / 2} ${spec.y - height / 2})`;
    let uprightTurn = "";

    if (spec.reorient != null) {
      uprightTurn = this.upright(width / 2, height / 2, spec.reorient);
    }

    return s("g", {
      class: "place",
      "data-place": spec.placeId,
      transform: `${corner}${uprightTurn}`,
    });
  }

  /**
   * Have a click on a place carry out the control anchored on it (a
   * draw), when there is one.
   *
   * @param {SVGGElement} box the place's group
   * @param {string} placeId the place's id
   */
  wirePlaceControl(box, placeId) {
    const draw = (this.app.controls || []).find((c) => (
      (c.anchor === `place:${placeId}`) &&
      (c.action_type !== "tabletop.gather")
    ));

    if (draw) {
      box.classList.add("actionable");
      box.addEventListener("click", (e) => this.onPlaceClick(e, draw));
    }
  }

  /**
   * Draw a place as a stack: one slot showing its top token (or a card
   * back, when only a count is seen), a stack edge for its depth, and
   * its caption under it.
   *
   * @param {SVGGElement} g the group to draw into
   * @param {object} spec the place, as drawPlaceAt takes it
   * @param {Array|object|undefined} contents what the viewer sees of it
   */
  drawStack(g, spec, contents) {
    const tree = this.tree;
    const [cardW, cardH] = spec.look.slot;
    const box = this.placeGroup(spec, cardW, cardH);
    let caption = "";
    let count = 0;
    let top = null;
    let id = null;
    let stackDepth = 0;
    let back = null;

    // The empty slot.
    box.append(s("rect", {
      class: "place-slot", width: cardW, height: cardH, rx: 10,
    }));

    // How many it holds, and its top token when the viewer sees it.
    if (Array.isArray(contents)) {
      count = contents.length;
      id = contents[contents.length - 1];
      if (id) {
        top = tree.entities?.[id];
      }
    } else if ((contents) && (typeof contents === "object")) {
      count = contents.count ?? 0;
    }

    // The stack's edge, then its top: a token, or a card back.
    if (count) {
      stackDepth = Math.min(4, Math.ceil(count / 10));
      for (let i = stackDepth; i > 0; i--) {
        box.append(s("rect", {
          class: "place-stack",
          x: i * 1.5,
          y: -i * 1.5,
          width: cardW,
          height: cardH,
          rx: 10,
        }));
      }
      if (top) {
        this.appendCentered(box, top, cardW, cardH);
        box.dataset.token = contents[contents.length - 1];
      } else {
        back = this.cardBack(cardW, cardH);
        if (back) {
          box.append(back);
        }
      }
    }

    // Its caption under it, and its control.
    caption = this.placeCaption(spec, count);
    if (caption !== "") {
      box.append(s("text", {
        class: "place-label",
        x: cardW / 2,
        y: cardH + 22,
        "text-anchor": "middle",
      }, caption));
    }
    this.wirePlaceControl(box, spec.placeId);

    g.append(box);
  }

  /**
   * Draw a place as a fan: each token in its slot, in the list's order,
   * drawn so the edge its look reveals shows. A fan reaches a little past
   * each end (FAN_OVERHANG), so a drop there lands at that end.
   *
   * @param {SVGGElement} g the group to draw into
   * @param {object} spec the place, as drawPlaceAt takes it
   * @param {string[]} ids the tokens it holds, in order, with the
   *   viewer's pending ones set in
   * @param {Map<string, object>} [held] the viewer's pending entries for
   *   it, by token: those cards are drawn faded
   */
  drawFan(g, spec, ids, held = new Map()) {
    const look = spec.look;
    const [slotW, slotH] = look.slot;
    const layout = fanLayout(look, ids.length);
    const box = this.placeGroup(spec, layout.box.w, layout.box.h);
    const first = fanLayout(look, 1).slots[0];
    const caption = this.placeCaption(spec, ids.length);
    const reach = this.fanReach(look, layout);
    const hint = this.takeHint(true);
    let ent = null;
    let card = null;

    // Where it may be dropped on, and its slot when it is empty.
    box.append(s("rect", { class: "place-hit", ...reach }));
    if (ids.length === 0) {
      box.append(s("rect", {
        class: "place-slot",
        x: first.x,
        y: first.y,
        width: slotW,
        height: slotH,
        rx: 10,
      }));
    }

    // Each token, in drawing order; a pending one faded, showing the
    // side it was played with.
    for (const i of layout.order) {
      ent = this.tree.entities?.[ids[i]];
      if (ent != null) {
        card = s("g", {
          class: "fan-card",
          "data-token": ids[i],
          "data-index": i,
          transform: `translate(${layout.slots[i].x} ${layout.slots[i].y})` +
            ` scale(${layout.scale})`,
        });
        if (held.has(ids[i])) {
          ent = pendingEntity(ent, held.get(ids[i]));
          card.classList.add("pending");
          card.dataset.pending = "1";
        }
        this.appendCentered(card, ent, slotW, slotH);
        card.append(s("rect", {
          class: "token-hit", width: slotW, height: slotH, rx: 6,
        }));
        if (held.has(ids[i])) {
          card.append(s("title", {}, PENDING_HINT));
        } else if (hint !== "") {
          card.append(s("title", {}, hint));
        }
        box.append(card);
      }
    }

    // Its caption under it, and its control.
    if (caption !== "") {
      box.append(s("text", {
        class: "place-label",
        x: layout.box.w / 2,
        y: reach.y + reach.height + 22,
        "text-anchor": "middle",
      }, caption));
    }
    this.wirePlaceControl(box, spec.placeId);

    this.fans.set(spec.placeId, { look, layout });
    g.append(box);
  }

  /**
   * The area a fan may be dropped on, in its own frame: its box and its
   * tokens, and FAN_OVERHANG past each end along it. (Not more: two fans
   * side by side in a placemat would catch each other's drops.)
   *
   * @param {object} look the fan's resolved look
   * @param {object} layout its layout
   * @returns {{x: number, y: number, width: number, height: number}}
   *   the area
   */
  fanReach(look, layout) {
    let x = -FAN_OVERHANG;
    let y = 0;
    let width = layout.box.w + 2 * FAN_OVERHANG;
    let height = layout.box.h;

    // A column reaches past its ends downward; a grid down its rows.
    if (look.mode === "column") {
      x = 0;
      y = -FAN_OVERHANG;
      width = layout.box.w;
      height = layout.box.h + 2 * FAN_OVERHANG;
    } else if (look.mode === "grid") {
      height = Math.max(
        layout.box.h,
        layout.cell.h + Math.floor(
          Math.max(0, layout.slots.length - 1) / Math.max(1, look.columns),
        ) * layout.rowStep,
      );
    }

    // Down to the lowest skewed token, or up to the highest.
    for (const slot of layout.slots) {
      if ((look.mode === "row") && (slot.y < y)) {
        height += y - slot.y;
        y = slot.y;
      } else if (
        (look.mode === "row") &&
        (slot.y + layout.cell.h > y + height)
      ) {
        height = slot.y + layout.cell.h - y;
      }
    }

    return { x, y, width, height };
  }

  /**
   * Draw each seat's placemat, for every placemat the scene declares.
   *
   * @param {SVGGElement} g the layer's group
   */
  drawPlacemats(g) {
    const places = this.tree?.places || {};

    for (const mat of this.scene.placemats || []) {
      for (const seat of matSeats(mat, places)) {
        this.drawPlacemat(g, mat, seat);
      }
    }
  }

  /**
   * Draw one seat's placemat: its frame, its places and its labels, at
   * its spot and turned to face its seat. Nothing in it turns back for
   * the viewer: it lies as its owner sees it.
   *
   * @param {SVGGElement} g the layer's group
   * @param {object} mat the placemat's declaration
   * @param {string} seat the seat it is for
   */
  drawPlacemat(g, mat, seat) {
    const spot = mat.spots[seat];
    const rotation = matRotation(spot, this.scene.seat_sides, seat);
    const group = s("g", {
      class: "placemat",
      "data-placemat": mat.placemat_id,
      "data-seat": seat,
      transform: `translate(${spot.x} ${spot.y}) rotate(${rotation})` +
        ` translate(${-mat.width / 2} ${-mat.height / 2})`,
    });
    let declaration = null;

    // Its own, when it is the viewer's, and lit while it is its seat's
    // turn.
    if (String(this.app.seat) === seat) {
      group.classList.add("mine");
    }
    if (String(turnSeat(this.tree)) === seat) {
      group.classList.add("turn");
    }

    // Its frame: a picture, a drawn box, or both.
    if (mat.asset) {
      group.append(this.look.image(
        referenceString(mat.asset), 0, 0, mat.width, mat.height, "stretch",
      ));
    }
    if (Object.keys(mat.frame || {}).length) {
      group.append(s("rect", frameAttributes(mat)));
    }

    // Its places, this seat's own.
    for (const place of mat.places || []) {
      declaration = this.placeDeclaration(place.place_id);
      this.drawPlaceAt(group, {
        placeId: `${place.place_id}.${seat}`,
        baseId: place.place_id,
        name: declaration?.name || place.place_id,
        x: place.x,
        y: place.y,
        look: resolveLook(declaration?.look, place.look),
        reorient: null,
      });
    }

    // Its labels, read for this seat.
    for (const label of mat.labels || []) {
      this.drawLabel(group, label, seat, false);
    }

    // The ring that lights it on its seat's turn, over everything in it.
    group.append(s("rect", {
      class: "placemat-turn",
      x: -TURN_RING_GAP,
      y: -TURN_RING_GAP,
      width: mat.width + (2 * TURN_RING_GAP),
      height: mat.height + (2 * TURN_RING_GAP),
      rx: TURN_RING_GAP,
    }));

    g.append(group);
  }

  /**
   * Draw a label, when its text can be filled (or it has a fallback).
   *
   * @param {SVGGElement} g the group to draw into
   * @param {object} label the label's declaration
   * @param {string|null} seat the placemat's seat, or null on the board
   * @param {boolean} turnsBack whether it turns back for the viewer (on
   *   the board), or lies as drawn (in a placemat)
   */
  drawLabel(g, label, seat, turnsBack) {
    const style = label.style || {};
    let text = this.labelText(label, seat);
    let transform = "";

    // Its fallback, when its text cannot be filled.
    if (text == null) {
      text = label.fallback ?? null;
    }

    // Its own rotation, then the turn back.
    if (label.rotation) {
      transform = `rotate(${label.rotation} ${label.x} ${label.y})`;
    }
    if (turnsBack) {
      transform += this.upright(label.x, label.y, this.reorientOf(label));
    }

    if ((text != null) && (text !== "")) {
      g.append(s("text", {
        class: "scene-label",
        x: label.x,
        y: label.y,
        "text-anchor": style.align || "start",
        style: labelStyle(style),
        transform: transform.trim() || null,
      }, text));
    }
  }

  /**
   * A label's text, its holes filled.
   *
   * @param {object} label the label's declaration
   * @param {string|null} seat the placemat's seat, or null on the board
   * @returns {string|null} the text, or null when it has none or a hole
   *   cannot be filled
   */
  labelText(label, seat) {
    let ret = null;
    let template = label.text;

    // Its text, or the game's string for its key.
    if ((template == null) && (label.text_key != null)) {
      template = this.app.text.raw(label.text_key);
    }

    if (template != null) {
      ret = fillText(template, (name) => this.labelHole(label, name, seat));
    }

    return ret;
  }

  /**
   * The text of one of a label's holes.
   *
   * @param {object} label the label's declaration
   * @param {string} name the hole's name
   * @param {string|null} seat the placemat's seat, or null on the board
   * @returns {string|null} its text, or null when it cannot be filled
   */
  labelHole(label, name, seat) {
    const bind = label.bind || {};
    let ret = null;
    let value = null;

    if ((name === "seat") && (seat != null)) {
      ret = String(seat);
    } else if ((name === "seat_name") && (seat != null)) {
      ret = this.app.seatName(seat);
    } else if (name.startsWith("count:")) {
      value = this.tree?.places?.[seatPath(name.slice(6), seat)];
      if (Array.isArray(value)) {
        ret = String(value.length);
      } else if (value?.count != null) {
        ret = String(value.count);
      }
    } else if (name.startsWith("hint:")) {
      // The hint the rules set for a place, or nothing.
      ret = hintText(this.tree, seatPath(name.slice(5), seat));
    } else if ((name.startsWith("value:")) || (name.startsWith("text:"))) {
      // A seat value, or the string its texts map it to.
      ret = holeText(
        this.tree || {},
        valueDeclarations(this.look.declaration),
        name,
        seat,
        (key) => this.app.text.t(key),
      );
    } else if (bind[name] != null) {
      value = readPath(this.tree || {}, seatPath(bind[name], seat));
      if ((typeof value === "string") || (typeof value === "number")) {
        ret = String(value);
      } else if ((value != null) && (typeof value.key === "string")) {
        ret = this.app.text.t(value);
      }
    } else {
      ret = null;
    }

    return ret;
  }

  /**
   * Draw a token centered in a box.
   *
   * @param {SVGGElement} box the group to draw into
   * @param {object} entity the token
   * @param {number} width the box's width
   * @param {number} height the box's height
   */
  appendCentered(box, entity, width, height) {
    const { node, w, h: hh } = this.look.drawEntity(entity);

    node.setAttribute(
      "transform",
      `translate(${(width - w) / 2} ${(height - hh) / 2})`,
    );
    box.append(node);
  }

  /**
   * Carry out a place's control when it is clicked with the hand tool
   * (Alt-click pings instead).
   *
   * @param {MouseEvent} e the click
   * @param {object} control the control anchored on the place
   */
  onPlaceClick(e, control) {
    if ((this.tool === "hand") && (!e.altKey)) {
      this.app.act(control.action_type, control.params);
    }
  }

  /**
   * The card back of the game's first pile, centered in a slot: what a
   * place shows when its viewer sees only a count.
   *
   * @param {number} width the slot's width
   * @param {number} height the slot's height
   * @returns {SVGGElement|null} the back, or null when there is none
   */
  cardBack(width = 100, height = 140) {
    const pile = (this.look.declaration.piles || [])[0];
    let ret = null;
    let kind = null;
    let token = null;
    let back = null;
    let w = 0;
    let hh = 0;

    // The first kind the first pile holds.
    if (pile) {
      kind = Object.keys(pile.contents || {})[0];
    }
    if (kind) {
      token = this.look.tokens.get(kind);
    }

    // Its hidden side, centered.
    if (token) {
      back = this.look.sideOf(token, token.hidden_side || "back");
      [w, hh] = this.look.sizeOfSide(back);
      ret = this.look.drawSide(back, {}, w, hh, token);
      ret.setAttribute(
        "transform",
        `translate(${(width - w) / 2} ${(height - hh) / 2})`,
      );
    }

    return ret;
  }

  /**
   * Draw the tokens on the table in this scene, lowest first.
   *
   * @param {SVGGElement} g the group to draw into
   * @param {object} tree the state
   */
  drawTokens(g, tree) {
    const here = this.scene.scene_key;
    const ents = [];

    // The tokens on the table (they have a position) in this scene, or
    // in no scene at all.
    for (const [id, ent] of Object.entries(tree?.entities || {})) {
      if (
        (ent != null) &&
        (ent.x != null) &&
        ((ent.scene == null) || (ent.scene === here))
      ) {
        ents.push([id, ent]);
      }
    }

    // Draw them in their order on the table.
    ents.sort((a, b) => (a[1].z || 0) - (b[1].z || 0));
    for (const [id, ent] of ents) {
      g.append(this.tokenNode(id, ent));
    }
  }

  /**
   * One token on the table: drawn at its position, turned back about its
   * anchor as its reorient asks, then turned by its own rotation on the
   * board. A token that fits its cell is drawn to fill it.
   *
   * @param {string} id the token's id
   * @param {object} ent the token's entity
   * @returns {SVGGElement} the token's group
   */
  tokenNode(id, ent) {
    const token = this.look.tokens.get(ent.kind);
    const grid = this.scene.grid || {};
    const back = turnBack(this.turn || 0, this.reorientOf(token));
    const rotation = back + (ent.rotation || 0);
    const hint = this.takeHint(false);
    let { node, w, h: hh } = this.look.drawEntity(ent);
    let margin = 0;
    let k = 0;
    let scaled = null;
    let ax = 0;
    let ay = 0;
    let ret = null;

    // Fill its cell less the margin on each side, keeping its aspect
    // ratio, when it fits its cell. This is drawing only.
    if (
      (token?.fit === "cell") &&
      (grid.kind != null) &&
      (grid.kind !== "") &&
      (grid.kind !== "none") &&
      (w > 0) &&
      (hh > 0)
    ) {
      margin = token.fit_margin ?? grid.fit_margin ?? DEFAULT_FIT_MARGIN;
      k = ((grid.cell_size || DEFAULT_CELL_SIZE) * (1 - 2 * margin)) /
        Math.max(w, hh);
      scaled = s("g", { transform: `scale(${k})` });
      scaled.append(node);
      node = scaled;
      w *= k;
      hh *= k;
    }

    // Its anchor, and its group, placed and turned.
    ax = (token?.anchor_x ?? 0.5) * w;
    ay = (token?.anchor_y ?? 0.5) * hh;
    ret = s("g", {
      class: "token",
      "data-token": id,
      transform: `translate(${ent.x - ax} ${ent.y - ay})` +
        ` rotate(${rotation} ${ax} ${ay})`,
    });

    // Marked when it is the viewer's, and when they may peek at it.
    if (ent.owner === this.app.seat) {
      ret.classList.add("mine");
    }
    if ((ent.hidden) && (ent.owner === this.app.seat)) {
      ret.classList.add("peek");
    }

    // The drawing, the area that catches the pointer, and the hint on
    // how to take it.
    ret.append(node);
    ret.append(s("rect", { class: "token-hit", width: w, height: hh, rx: 6 }));
    if (hint !== "") {
      ret.append(s("title", {}, hint));
    }

    return ret;
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
        g.append(s("text", { class: "mark-text", x: sh.x, y: sh.y, fill: sh.color || "#ffd166", transform: this.upright(sh.x, sh.y).trim() || null }, sh.text));
      }
    }
    if (this.stroke) g.append(s("polyline", { class: "mark drawing", points: this.stroke.map((p) => p.join(",")).join(" "), stroke: this.app.penColor, "stroke-width": 4 }));
  }

  /** What media.show put on the stage. A video plays as the show says: once and then gone (the default), on a loop,
   * or once holding its last frame. Each item is kept across renders so a video plays on rather than restarting. */
  drawStage(g, tree) {
    const zone = this.scene.safe_zone;
    const stage = tree?.stage || {};
    for (const id of this.stageItems.keys()) if (!stage[id]) this.stageItems.delete(id);
    for (const [id, show] of Object.entries(stage)) {
      const w = show.w || zone.side * 0.6, hh = show.h || zone.side * 0.6;
      const x = show.x ?? zone.x + (zone.side - w) / 2, y = show.y ?? zone.y + (zone.side - hh) / 2;
      const key = JSON.stringify([this.scene.scene_key, show.asset, show.play, x, y, w, hh]);
      let item = this.stageItems.get(id);
      if (item?.key !== key) {
        const frame = s("g", { class: "stage-item", "data-stage": id });
        frame.append(s("rect", { x: x - 8, y: y - 8, width: w + 16, height: hh + 16, rx: 12, class: "stage-frame" }));
        item = { key, node: frame, gone: false };
        this.stageItems.set(id, item);
        const known = this.look.assets.get(show.asset);
        if (known && !known.mime?.startsWith("video/")) frame.append(this.look.image(show.asset, x, y, w, hh));
        else {
          const it = item;
          this.look.assetFor(show.asset).then(async (a) => {
            if (!a?.mime?.startsWith("video/")) return frame.append(this.look.image(show.asset, x, y, w, hh));
            const url = await this.look.urlFor(show.asset);
            const end = () => { it.gone = true; frame.remove(); };
            frame.append(this.video(url, x, y, w, hh, { loop: show.play === "loop", onEnd: show.play === "hold" ? null : end }));
          }).catch(() => frame.append(this.look.image(show.asset, x, y, w, hh)));
        }
      }
      // always upright to the viewer, about its own middle
      const turn = this.upright(x + w / 2, y + hh / 2).trim();
      if (turn) item.node.setAttribute("transform", turn);
      else item.node.removeAttribute("transform");
      if (!item.gone) g.append(item.node);
    }
  }

  /** A video in the scene, fitted to the box and never catching the pointer. onEnd runs when it ends or fails. */
  video(url, x, y, w, hh, { loop = false, channel = "effects", onEnd = null } = {}) {
    const v = document.createElement("video");
    v.className = "scene-video";
    v.playsInline = true;
    v.loop = loop;
    v.volume = channelVolume(channel);
    if (onEnd) {
      v.addEventListener("ended", onEnd);
      v.addEventListener("error", onEnd);
    }
    v.src = url;
    playMedia(v);
    const fo = s("foreignObject", { x, y, width: w, height: hh, class: "video" });
    fo.append(v);
    return fo;
  }

  /** Play one visual cue (spec 23.11): a video until it ends, or a picture or animation for `duration` ms. It is anchored to a token
   * (following it as it moves), a board space, or the stage, and catches no clicks, so play goes on beneath it.
   * Returns {done, stop}: done settles when the cue is over, and stop ends it early (a skip). */
  playCue({ url, video, duration = 2500, anchor, reference, channel }) {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    if (!this.scene) return { done: Promise.resolve(), stop() {} };
    const node = video ? this.video(url, 0, 0, 0, 0, { channel, onEnd: () => stop() })
      : s("image", { href: url, class: "cue", preserveAspectRatio: "xMidYMid meet", style: `animation-duration: ${duration}ms` });
    const timer = video ? null : setTimeout(() => stop(), duration);
    const stop = () => {
      clearTimeout(timer);
      node.querySelector?.("video")?.pause();
      node.remove();
      if (this.cue?.node === node) this.cue = null;
      finish();
    };
    this.cue = { node, anchor, reference };
    this.cueLayer.append(node);
    this.placeCue();
    return { done, stop };
  }

  /** Size and place the playing cue: a quarter of the safe zone on its token or space (kept inside the zone), or
   * the stage's size in the middle of it. A token that is not in this scene puts the cue on the stage. */
  placeCue() {
    const cue = this.cue, sc = this.scene;
    if (!cue || !sc) return;
    const zone = sc.safe_zone;
    let at = null;
    if (cue.anchor === "token") {
      const e = cue.reference && this.tree?.entities?.[cue.reference];
      if (e?.x != null && (e.scene == null || e.scene === sc.scene_key)) at = [e.x, e.y];
    } else if (cue.anchor === "space" && cue.reference) {
      at = cellPoint(sc, cue.reference);
    }
    const size = zone.side * (at ? 0.25 : 0.6);
    const [cx, cy] = at || [zone.x + zone.side / 2, zone.y + zone.side / 2];
    const clamp = (v, lo) => Math.max(lo, Math.min(lo + zone.side - size, v));
    const x = clamp(cx - size / 2, zone.x), y = clamp(cy - size / 2, zone.y);
    for (const [k, v] of Object.entries({ x, y, width: size, height: size })) cue.node.setAttribute(k, v);
    const turn = this.upright(x + size / 2, y + size / 2).trim();       // upright to the viewer, about its middle
    if (turn) cue.node.setAttribute("transform", turn);
    else cue.node.removeAttribute("transform");
  }

  drawFocus(svg, zone) {
    const pj = this.preferences.projection;
    if (!pj?.show_focus) return;
    const size = zone.side * 0.3, x = zone.x + (zone.side - size) / 2, y = zone.y + (zone.side - size) / 2;
    if (pj.focus_image) {
      svg.append(this.look.image(pj.focus_image, x, y, size, size));
      return;
    }
    svg.append(focusStar(x + size / 2, y + size / 2, size / 2));
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

  /**
   * A press on the scene: Alt pings, the pen starts a stroke, and the
   * hand picks up a token it may drag. The table view only watches.
   *
   * @param {PointerEvent} e the press
   */
  onDown(e) {
    const p = this.pt(e);

    // Only the main button, and not from the table view.
    if ((e.button === 0) && (this.app.view !== "table")) {
      if (e.altKey) {
        this.app.ephemeral(this.scene.scene_key, p.x, p.y);
      } else if (this.tool === "pen") {
        this.stroke = [[Math.round(p.x), Math.round(p.y)]];
        this.svg.setPointerCapture(e.pointerId);
      } else {
        this.pickUp(e, p);
      }
    }
  }

  /**
   * Pick up the token under a press, when there is a control to drag it
   * with.
   *
   * @param {PointerEvent} e the press
   * @param {{x: number, y: number}} p where, in the scene
   */
  pickUp(e, p) {
    const id = this.tokenAt(e);
    const card = e.target.closest?.(".fan-card");
    let control = null;
    let node = null;
    let ent = null;

    // The control a drag of it carries out.
    if (id) {
      control = this.dragControl(id);
    }

    // Hold it, and outline how far it may go; or hold a fan's card.
    if ((!control) && (card) && (this.control("tabletop.play"))) {
      this.pickUpCard(e, card);
    } else if (control) {
      node = e.target.closest(".token");
      ent = this.tree.entities[id];
      this.drag = {
        id,
        node,
        start: p,
        ent,
        control,
        moved: false,
        base: node.getAttribute("transform"),
      };
      this.showReach(control, ent);
      this.svg.setPointerCapture(e.pointerId);
    }
  }

  /**
   * Pick up a card from a fan, to play it into a place or onto the
   * table. It is carried in its fan's own frame, so it follows the
   * pointer however its placemat or the view is turned.
   *
   * @param {PointerEvent} e the press
   * @param {SVGGElement} card the card's group
   */
  pickUpCard(e, card) {
    const frame = card.parentNode;

    this.drag = {
      id: card.dataset.token,
      node: card,
      frame,
      start: localPoint(frame, e),
      ent: null,
      control: this.control("tabletop.play"),
      fromPlace: card.closest(".place")?.dataset.place,
      isPending: (card.dataset.pending === "1"),
      moved: false,
      base: card.getAttribute("transform"),
    };
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

  /**
   * A pointer move: extend a pen stroke, or carry a dragged token.
   *
   * @param {PointerEvent} e the move
   */
  onMove(e) {
    const d = this.drag;
    let p = this.pt(e);
    let last = null;
    let dx = 0;
    let dy = 0;

    if (this.stroke) {
      // Add a point once the pen has gone far enough.
      last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) {
        this.stroke.push([Math.round(p.x), Math.round(p.y)]);
        this.render(this.tree);
      }
    } else if (d) {
      // Follow the pointer, in the frame it is carried in; past a few px
      // it counts as a move. Over a fan, show where it would go.
      if (d.frame) {
        p = localPoint(d.frame, e);
      }
      dx = p.x - d.start.x;
      dy = p.y - d.start.y;
      if (Math.hypot(dx, dy) > 3) {
        d.moved = true;
      }
      d.node.setAttribute("transform", `translate(${dx} ${dy}) ${d.base}`);
      d.node.classList.add("dragging");
      this.showMarker(e);

      // Offer the hand panel as a place to drop it, when it may go there.
      if ((d.moved) && (this.takesToHand(d))) {
        this.app.dragFromBoard(e, this.tree.entities?.[d.id]);
      }
    }
  }

  /**
   * A card dragged from the hand moving over the scene: let it be
   * dropped, and show where it would go in a fan.
   *
   * @param {DragEvent} e the drag
   */
  onDragOver(e) {
    e.preventDefault();
    this.showMarker(e);
  }

  /**
   * Where in the fan under the pointer a dropped token would go, or
   * undefined when there is no fan there (or no place at all).
   *
   * @param {MouseEvent} e the pointer event
   * @param {Element|undefined} placeEl the place under it
   * @returns {number|undefined} the insert position
   */
  dropIndex(e, placeEl) {
    let ret = undefined;
    let fan = null;

    if (placeEl) {
      fan = this.fans.get(placeEl.dataset.place);
    }
    if (fan) {
      ret = insertIndex(fan.look, fan.layout, localPoint(placeEl, e));
    }

    return ret;
  }

  /**
   * Show the insert marker in the fan under the pointer, or clear it.
   *
   * @param {MouseEvent} e the pointer event
   */
  showMarker(e) {
    const placeEl = placeAt(e);
    const index = this.dropIndex(e, placeEl);
    let fan = null;

    this.clearMarker();
    if (index !== undefined) {
      fan = this.fans.get(placeEl.dataset.place);
      this.marker = s("line", {
        class: "insert-marker",
        ...insertMarker(fan.look, fan.layout, index),
      });
      placeEl.append(this.marker);
    }
  }

  /** Take the insert marker away. */
  clearMarker() {
    this.marker?.remove();
    this.marker = null;
  }

  /**
   * A release: finish a pen stroke, or put down a dragged token.
   *
   * @param {PointerEvent} e the release
   */
  async onUp(e) {
    const points = this.stroke;
    const d = this.drag;

    if (points) {
      // Commit the stroke, if it is more than a dot.
      this.stroke = null;
      if (points.length > 1) {
        await this.app.commitMark({
          type: "stroke",
          points,
          color: this.app.penColor,
          width: 4,
        }, this.scene.scene_key);
      }
      this.render(this.tree);
    } else if (d) {
      // Let go of the token; a press with no move puts it back.
      this.drag = null;
      this.reach?.remove();
      this.reach = null;
      if (!d.moved) {
        d.node.setAttribute("transform", d.base);
      } else {
        await this.putDown(e, d);
      }
    }
  }

  /**
   * Put down a dragged token: into the viewer's hand when it was let go
   * on the hand panel, by the rules' own move (it says where, and checks
   * it), into the place under the pointer, or on the table where it was
   * let go. A refused move puts it back.
   *
   * @param {PointerEvent} e the release
   * @param {object} d the drag
   */
  async putDown(e, d) {
    const p = this.pt(e);
    const placeEl = placeAt(e);
    const index = this.dropIndex(e, placeEl);
    let hand = null;
    let x = 0;
    let y = 0;
    let ack = null;

    // The hand place it was let go on, when it may go there.
    if (this.takesToHand(d)) {
      hand = this.app.handDropAt(e);
    }
    this.app.endDragFromBoard();

    // Where it was let go: a fan's card at the pointer, a token where
    // it started plus how far it went.
    this.clearMarker();
    if (d.fromPlace != null) {
      x = round(p.x);
      y = round(p.y);
    } else {
      x = round(d.ent.x + (p.x - d.start.x));
      y = round(d.ent.y + (p.y - d.start.y));
    }

    // Say where it goes.
    if (hand != null) {
      ack = await this.takeToHand(d, hand);
    } else if (d.fromPlace != null) {
      ack = await this.playCard(d, placeEl, index, x, y);
    } else if (d.control.action_type !== "tabletop.move") {
      ack = await this.app.act(
        d.control.action_type,
        { ...d.control.params, x, y },
      );
    } else if ((placeEl) && (this.control("tabletop.take"))) {
      ack = await this.app.act(
        "tabletop.take",
        withIndex({ token: d.id, to: placeEl.dataset.place }, index),
      );
    } else {
      ack = await this.app.act("tabletop.move", {
        token: d.id, x, y, scene: this.scene.scene_key,
      });
    }

    // Refused: back where it was.
    if (ack.outcome !== "accepted") {
      d.node.setAttribute("transform", d.base);
      d.node.classList.remove("dragging");
    }
  }

  /**
   * Whether a drag may end in the viewer's hand: a card out of a place on
   * the board, which is played into the hand, or a token loose on the
   * table that the free tabletop moves and lets be taken.
   *
   * @param {object} d the drag
   * @returns {boolean} whether it may
   */
  takesToHand(d) {
    let ret = false;

    if (d.fromPlace != null) {
      ret = (this.control("tabletop.play") != null);
    } else {
      ret = (
        (d.control.action_type === "tabletop.move") &&
        (this.control("tabletop.take") != null)
      );
    }

    return ret;
  }

  /**
   * Take a dragged card into a place in the viewer's hand: a take for a
   * token loose on the table, a play for a card out of a place, and
   * taking back a pending card.
   *
   * @param {object} d the drag
   * @param {string} hand the hand place it goes into
   * @returns {Promise<object>} the server's answer, or a refusal when
   *   the card is already there
   */
  takeToHand(d, hand) {
    const request = takeIntoHand(
      d.id,
      d.fromPlace ?? null,
      hand,
      d.isPending === true,
    );
    let ret = Promise.resolve({ outcome: "unchanged" });

    if (request != null) {
      ret = this.app.act(request.action, request.params);
    }

    return ret;
  }

  /**
   * Play a card dragged out of a fan: into the place it was let go on,
   * at the position under the pointer, or onto the table there. A
   * pending card goes back only to the hand, so anywhere else it stays.
   *
   * @param {object} d the drag
   * @param {Element|undefined} placeEl the place under the pointer
   * @param {number|undefined} index where in that place, when it fans
   * @param {number} x where on the scene it was let go
   * @param {number} y where on the scene it was let go
   * @returns {Promise<object>} the server's answer
   */
  playCard(d, placeEl, index, x, y) {
    let ret = null;

    if (d.isPending === true) {
      ret = Promise.resolve({ outcome: "unchanged" });
    } else if (placeEl) {
      ret = this.app.act("tabletop.play", withIndex({
        token: d.id, to: placeEl.dataset.place, face_up: true,
      }, index));
    } else {
      ret = this.app.act("tabletop.play", {
        token: d.id,
        to: "table",
        x,
        y,
        face_up: true,
        scene: this.scene.scene_key,
      });
    }

    return ret;
  }

  onDouble(e) {
    const id = this.tokenAt(e);
    if (!id || this.app.view === "table") return;
    const ent = this.tree.entities[id];
    const token = this.look.tokens.get(ent?.kind);
    if (token?.roll && this.control("tabletop.roll")) this.app.act("tabletop.roll", { token: id });
    else if (this.control("tabletop.flip")) this.app.act("tabletop.flip", { token: id });
  }

  /**
   * A token's menu, on a right-click: flip, roll, rotate, take it into
   * the hand, and for a GM speak as it; or the menu of a card in a place
   * on the board. The table view only watches.
   *
   * @param {MouseEvent} e the contextmenu event
   */
  onContext(e) {
    const id = this.tokenAt(e);
    const card = e.target.closest?.(".fan-card");
    const items = [];
    let ent = null;
    let token = null;

    if ((id != null) && (id !== "") && (this.app.view !== "table")) {
      // The token, and its kind.
      e.preventDefault();
      ent = this.tree.entities[id];
      token = this.look.tokens.get(ent?.kind);

      // What may be done with it.
      if (
        (this.control("tabletop.flip")) &&
        ((token?.sides?.length > 1) || (ent.hidden))
      ) {
        items.push([
          "Flip",
          () => this.app.act("tabletop.flip", { token: id }),
        ]);
      }
      if ((this.control("tabletop.roll")) && (token?.roll)) {
        items.push([
          "Roll",
          () => this.app.act("tabletop.roll", { token: id }),
        ]);
      }
      if (this.control("tabletop.rotate")) {
        items.push([
          "Rotate 90°",
          () => this.app.act("tabletop.rotate", {
            token: id,
            rotation: (ent.rotation || 0) + 90,
          }),
        ]);
      }
      if (this.control("tabletop.take")) {
        items.push([
          "Take into my hand",
          () => this.app.act("tabletop.take", { token: id }),
        ]);
      }
      if ((this.app.isGM()) && (this.app.feature("messages"))) {
        items.push(["Speak as this…", () => this.app.speakAs(id)]);
      }

      this.app.menu(e.clientX, e.clientY, items);
    }

    // A card in a place on the board has a menu of its own.
    if ((id == null) && (card != null) && (this.app.view !== "table")) {
      this.cardMenu(e, card);
    }
  }

  /**
   * The menu of a card in a place on the board (a row, a fan, the
   * discard), on a right-click: take it into the viewer's hand, or take
   * back one of the viewer's own pending cards.
   *
   * @param {MouseEvent} e the contextmenu event
   * @param {SVGGElement} card the card's group
   */
  cardMenu(e, card) {
    const hand = this.app.handPlaces()[0]?.[0];
    const from = card.closest(".place")?.dataset.place;
    const isPending = (card.dataset.pending === "1");
    const items = [];
    let request = null;
    let label = "Take into my hand";

    // Where it would go, when the viewer can play cards and has a hand.
    e.preventDefault();
    if ((hand != null) && (this.control("tabletop.play") != null)) {
      request = takeIntoHand(
        card.dataset.token,
        from ?? null,
        hand,
        isPending,
      );
    }
    if (isPending) {
      label = "Take back into my hand";
    }

    // The menu: taking it, when it isn't in the hand already.
    if (request != null) {
      items.push([
        label,
        () => this.app.act(request.action, request.params),
      ]);
    }
    this.app.menu(e.clientX, e.clientY, items);
  }

  /**
   * The hover hint on a card on the board: how to take it into the hand.
   * Nothing when the viewer can't: in the table view, without a seat, with
   * no hand panel, or when the rules offer no way.
   *
   * @param {boolean} isInPlace whether it is in a place on the board, not
   *   loose on the table
   * @returns {string} the hint, or "" for none
   */
  takeHint(isInPlace) {
    let ret = "";

    if (
      (this.app.view === "table") ||
      (this.app.seat == null) ||
      (this.app.handPlaces().length === 0)
    ) {
      ret = "";
    } else if ((isInPlace) && (this.control("tabletop.play") != null)) {
      ret = (
        "Drag it onto your hand to take it, or onto another place." +
        " Right-click to take it."
      );
    } else if ((!isInPlace) && (this.control("tabletop.take") != null)) {
      ret = (
        "Drag it onto your hand to take it." +
        " Right-click for more."
      );
    } else {
      ret = "";
    }

    return ret;
  }

  /**
   * A card dropped from the hand: into the place under it (face up), or
   * onto the table (face down with Shift).
   *
   * @param {DragEvent} e the drop
   */
  async onDrop(e) {
    const id = e.dataTransfer.getData("text/x-dionysus-token");
    const p = this.pt(e);
    const placeEl = placeAt(e);
    const index = this.dropIndex(e, placeEl);

    e.preventDefault();
    this.clearMarker();

    // Play it where it was dropped, when it is a token: in a fan, at the
    // position under the pointer.
    if (id) {
      if (placeEl) {
        await this.app.act("tabletop.play", withIndex({
          token: id, to: placeEl.dataset.place, face_up: true,
        }, index));
      } else {
        await this.app.act("tabletop.play", {
          token: id,
          to: "table",
          x: round(p.x),
          y: round(p.y),
          face_up: !e.shiftKey,
          scene: this.scene.scene_key,
        });
      }
    }
  }
}

/**
 * A value rounded to hundredths, as moves are sent.
 *
 * @param {number} v the value
 * @returns {number} it, rounded
 */
function round(v) {
  return Math.round(v * 100) / 100;
}

/**
 * A pointer event's position in an element's own frame, through its
 * screen matrix, so every turn and move above it is undone.
 *
 * @param {SVGGraphicsElement} el the element
 * @param {MouseEvent} e the event
 * @returns {{x: number, y: number}} the point
 */
function localPoint(el, e) {
  const matrix = el.getScreenCTM();
  let ret = { x: 0, y: 0 };

  if (matrix) {
    ret = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
  }

  return { x: ret.x, y: ret.y };
}

/**
 * A move's params, with the position in a place added when there is one.
 *
 * @param {object} params the move's params
 * @param {number|undefined} index where in the place, if it fans
 * @returns {object} the params
 */
function withIndex(params, index) {
  const ret = { ...params };

  if (index !== undefined) {
    ret.index = index;
  }

  return ret;
}

/**
 * A label's style as inline CSS, so it wins over the scene's defaults.
 *
 * @param {object} style the label's style
 * @returns {string|null} the CSS, or null when it sets nothing
 */
function labelStyle(style) {
  const rules = [];
  let ret = null;

  // Each field it sets, as a CSS property.
  if (style.font_size != null) {
    rules.push(`font-size: ${Number(style.font_size)}px`);
  }
  if (style.font_weight != null) {
    rules.push(`font-weight: ${style.font_weight}`);
  }
  if (style.color != null) {
    rules.push(`fill: ${style.color}`);
  }
  if (style.opacity != null) {
    rules.push(`opacity: ${Number(style.opacity)}`);
  }
  if (rules.length > 0) {
    ret = rules.join("; ");
  }

  return ret;
}

/**
 * The attributes of a placemat's frame: its box, drawn as its frame
 * style says.
 *
 * @param {object} mat the placemat's declaration
 * @returns {object} the rect's attributes
 */
function frameAttributes(mat) {
  const frame = mat.frame || {};

  return {
    class: "placemat-frame",
    width: mat.width,
    height: mat.height,
    rx: frame.radius ?? 0,
    fill: frame.fill ?? "none",
    stroke: frame.stroke ?? null,
    "stroke-width": frame.stroke_width ?? null,
    "stroke-opacity": frame.stroke_opacity ?? null,
    opacity: frame.opacity ?? null,
  };
}

/**
 * The place under a pointer event, if any: found by screen position, so
 * it is right whatever the view's turn.
 *
 * @param {MouseEvent} e the event
 * @returns {Element|undefined} the place's group
 */
function placeAt(e) {
  return document.elementsFromPoint(e.clientX, e.clientY)
    .find((el) => el.closest?.(".place"))?.closest(".place");
}

/**
 * One pointy-top hexagon as path data.
 *
 * @param {number} cx its center's x
 * @param {number} cy its center's y
 * @param {number} r its radius, center to corner
 * @returns {string} the path data
 */
function hexagon(cx, cy, r) {
  const points = [];
  let a = 0;

  // Six corners, starting 30 degrees above the right.
  for (let i = 0; i < 6; i++) {
    a = Math.PI / 180 * (60 * i - 30);
    points.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }

  return `M${points.join("L")}Z`;
}
