// The table's panes, resized by the viewer: the dividers between the top
// bar and the rest, between the main column and the side panel, and
// between the scene and the hand. Moving a divider scales everything in
// the pane it moves (CSS zoom), so a pane's contents always fit it; the
// scene fits whatever box it is left with. The scales are kept in this
// browser, and a double-click on a divider, or Reset layout, puts them
// back.

/** Where this browser keeps the pane scales. */
const PANES_KEY = "dionysus.paneScales";

/** The panes that can be resized, each with its smallest and largest scale. */
export const PANE_LIMITS = {
  head: { min: 0.7, max: 1.6 },
  side: { min: 0.7, max: 1.8 },
  hand: { min: 0.5, max: 2.5 },
};

/** The most of the screen's height the top bar may take. */
const HEAD_MAX_SHARE = 0.3;

/** The most of the screen's width the side panel may take. */
const SIDE_MAX_SHARE = 0.5;

/**
 * The least height left to the scene, in pixels; the same as its
 * min-height in the combined view (app.css).
 */
const SCENE_MIN_PX = 220;

/** The scale every pane starts at. */
const DEFAULT_SCALE = 1;

/**
 * Each pane's divider: which pointer coordinate moves it, and which way.
 * The top bar grows as its divider moves down; the side panel and the
 * hand grow as theirs move left and up.
 */
const DIVIDERS = {
  head: { axis: "clientY", sign: 1, orientation: "horizontal" },
  side: { axis: "clientX", sign: -1, orientation: "vertical" },
  hand: { axis: "clientY", sign: -1, orientation: "horizontal" },
};

/**
 * Keeps the viewer's pane scales, draws the dividers that change them,
 * and applies them to the table's page as CSS variables
 * (--head-scale, --side-scale, --hand-scale).
 *
 * Sends "change" when a drag or a reset has changed a scale.
 */
export class PaneSizer extends EventTarget {
  constructor() {
    super();
    this.scales = storedScales();
    this.screen = null;
    this.hand = null;
    this.above = null;
    this.drag = null;
    this.onDown = this.pointerDown.bind(this);
    this.onMove = this.pointerMove.bind(this);
    this.onUp = this.pointerUp.bind(this);
    this.onReset = this.resetOne.bind(this);
  }

  /**
   * Take the page the panes are on, after it has been laid out, and
   * apply the scales to it.
   *
   * @param {HTMLElement} screen the table's page
   * @param {HTMLElement|null} hand the hand panel, in the combined view
   * @param {HTMLElement|null} above what sits above the hand: the scene,
   *   or the state panel when there is no scene
   */
  attach(screen, hand, above) {
    this.screen = screen;
    this.hand = hand;
    this.above = above;
    this.apply();
  }

  /**
   * A divider for one pane, to drag (mouse or touch) or double-click.
   *
   * @param {string} name the pane: "head", "side" or "hand"
   * @returns {HTMLDivElement} the divider
   */
  divider(name) {
    const ret = document.createElement("div");

    ret.className = `pane-divider pane-${name}`;
    ret.dataset.pane = name;
    ret.setAttribute("role", "separator");
    ret.setAttribute("aria-orientation", DIVIDERS[name].orientation);
    ret.title = "Drag to resize · double-click to reset";
    ret.addEventListener("pointerdown", this.onDown);
    ret.addEventListener("pointermove", this.onMove);
    ret.addEventListener("pointerup", this.onUp);
    ret.addEventListener("pointercancel", this.onUp);
    ret.addEventListener("dblclick", this.onReset);

    return ret;
  }

  /**
   * Whether any pane is not at its starting scale.
   *
   * @returns {boolean} whether one has been resized
   */
  isChanged() {
    let ret = false;

    for (const name of Object.keys(PANE_LIMITS)) {
      if (this.scales[name] !== DEFAULT_SCALE) {
        ret = true;
      }
    }

    return ret;
  }

  /** Put every pane back at its starting scale. */
  reset() {
    this.scales = scalesFrom(null);
    this.apply();
    storeScales(this.scales);
    this.dispatchEvent(new Event("change"));
  }

  /** Set the scales on the page, as CSS variables. */
  apply() {
    if (this.screen != null) {
      for (const name of Object.keys(PANE_LIMITS)) {
        this.screen.style.setProperty(
          `--${name}-scale`,
          String(this.scales[name]),
        );
      }
    }
  }

  /**
   * Start dragging a divider: note where it started, how big its pane
   * is, and how big the pane may grow.
   *
   * @param {PointerEvent} event the press on the divider
   */
  pointerDown(event) {
    const target = event.currentTarget;
    const name = target.dataset.pane;
    let measured = null;

    // The main button, or a touch or a pen.
    if (event.button === 0) {
      measured = this.measure(name, target);
      this.drag = {
        name,
        pointerId: event.pointerId,
        start: event[DIVIDERS[name].axis],
        startScale: this.scales[name],
        size: measured.size,
        max: maxScale(
          this.scales[name],
          measured.size,
          measured.room,
          PANE_LIMITS[name],
        ),
      };
      target.setPointerCapture(event.pointerId);
      target.classList.add("dragging");
      event.preventDefault();
    }
  }

  /**
   * Follow the drag: scale the pane so it is as big as the divider says.
   *
   * @param {PointerEvent} event the move
   */
  pointerMove(event) {
    const drag = this.drag;
    let delta = 0;

    if ((drag != null) && (event.pointerId === drag.pointerId)) {
      delta = (
        (event[DIVIDERS[drag.name].axis] - drag.start) *
        DIVIDERS[drag.name].sign
      );
      this.scales[drag.name] = dragScale(
        drag.startScale,
        drag.size,
        delta,
        PANE_LIMITS[drag.name].min,
        drag.max,
      );
      this.apply();

      // A taller top bar leaves the main column less room: the hand
      // gives way once the scene is down to its least height.
      if (drag.name === "head") {
        this.fitHand();
      }
    }
  }

  /**
   * Shrink the hand until the main column no longer runs past the
   * bottom of the screen, as far as its smallest scale.
   */
  fitHand() {
    let main = null;
    let overflow = 0;
    let size = 0;

    if ((this.hand != null) && (!this.hand.hidden)) {
      // How far the main column runs past its box.
      main = this.hand.parentElement;
      overflow = main.scrollHeight - main.clientHeight;
      size = this.hand.getBoundingClientRect().height;

      if (overflow > 0) {
        this.scales.hand = dragScale(
          this.scales.hand,
          size,
          -overflow,
          PANE_LIMITS.hand.min,
          this.scales.hand,
        );
        this.apply();
      }
    }
  }

  /**
   * End the drag, and keep the new scale.
   *
   * @param {PointerEvent} event the release, or the cancel
   */
  pointerUp(event) {
    const drag = this.drag;
    const target = event.currentTarget;

    if ((drag != null) && (event.pointerId === drag.pointerId)) {
      this.drag = null;
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      target.classList.remove("dragging");
      storeScales(this.scales);
      this.dispatchEvent(new Event("change"));
    }
  }

  /**
   * Put one pane back at its starting scale.
   *
   * @param {MouseEvent} event the double-click on its divider
   */
  resetOne(event) {
    this.scales[event.currentTarget.dataset.pane] = DEFAULT_SCALE;
    this.apply();
    storeScales(this.scales);
    this.dispatchEvent(new Event("change"));
  }

  /**
   * How big a pane is now, and the most room it may take, in pixels.
   *
   * @param {string} name the pane
   * @param {HTMLElement} divider the pane's divider
   * @returns {{size: number, room: number}} its size and its room
   */
  measure(name, divider) {
    const screen = this.screen.getBoundingClientRect();
    const line = divider.getBoundingClientRect();
    let hand = null;
    let above = null;
    let ret = { size: 0, room: 0 };

    switch (name) {
      case "head":
        // The top bar and the seat strip, down to the divider.
        ret = {
          size: line.top - screen.top,
          room: screen.height * HEAD_MAX_SHARE,
        };
        break;
      case "side":
        ret = {
          size: screen.right - line.right,
          room: screen.width * SIDE_MAX_SHARE,
        };
        break;
      case "hand":
        // The hand may take what the scene has beyond its least height.
        hand = this.hand.getBoundingClientRect();
        above = this.above.getBoundingClientRect();
        ret = {
          size: hand.height,
          room: hand.height + above.height - SCENE_MIN_PX,
        };
        break;
      default:
        throw new Error(`Unknown pane: ${name}`);
    }

    return ret;
  }
}

/**
 * A scale kept within a pane's limits.
 *
 * @param {number} scale the scale
 * @param {number} min the smallest it may be
 * @param {number} max the largest it may be
 * @returns {number} the scale, clamped
 */
export function clampScale(scale, min, max) {
  return Math.min(max, Math.max(min, scale));
}

/**
 * The scale a pane takes when its divider has moved: the pane grows or
 * shrinks by the move, and its contents scale with it.
 *
 * @param {number} startScale the pane's scale when the drag started
 * @param {number} startSize the pane's size then, in pixels
 * @param {number} delta how far the pane grows, in pixels (less than
 *   zero to shrink)
 * @param {number} min the smallest scale
 * @param {number} max the largest scale
 * @returns {number} the new scale
 */
export function dragScale(startScale, startSize, delta, min, max) {
  let ret = startScale;

  // A pane with no size has nothing to scale by.
  if (startSize > 0) {
    ret = clampScale(startScale * ((startSize + delta) / startSize), min, max);
  }

  return ret;
}

/**
 * The largest scale a pane may take: its own limit, or less when the
 * room it has would be overrun first; never under its smallest.
 *
 * @param {number} scale the pane's scale now
 * @param {number} size the pane's size now, in pixels
 * @param {number} room the most room it may take, in pixels
 * @param {{min: number, max: number}} limits the pane's limits
 * @returns {number} the largest scale
 */
export function maxScale(scale, size, room, limits) {
  let ret = limits.max;

  if (size > 0) {
    ret = Math.min(limits.max, scale * (room / size));
  }

  return Math.max(limits.min, ret);
}

/**
 * The pane scales out of what was kept: each a number within its
 * limits, or the starting scale where there is none.
 *
 * @param {object|null} saved what was kept, read from JSON
 * @returns {{head: number, side: number, hand: number}} the scales
 */
export function scalesFrom(saved) {
  const ret = {};
  let value = null;

  for (const [name, limits] of Object.entries(PANE_LIMITS)) {
    value = saved?.[name];
    if ((typeof value === "number") && (Number.isFinite(value))) {
      ret[name] = clampScale(value, limits.min, limits.max);
    } else {
      ret[name] = DEFAULT_SCALE;
    }
  }

  return ret;
}

/**
 * The pane scales this browser kept.
 *
 * @returns {{head: number, side: number, hand: number}} the scales; the
 *   starting ones when storage is blocked or holds nothing readable
 */
function storedScales() {
  let saved = null;

  try {
    saved = JSON.parse(localStorage.getItem(PANES_KEY));
  } catch {
    // Storage is blocked, or holds something else: start over.
    saved = null;
  }

  return scalesFrom(saved);
}

/**
 * Keep the pane scales in this browser, when it lets them be kept.
 *
 * @param {{head: number, side: number, hand: number}} scales the scales
 */
function storeScales(scales) {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(scales));
  } catch {
    // Storage is blocked: the scales hold for this page only.
  }
}
