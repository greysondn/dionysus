// How a place's tokens are laid out on the scene: a stack, or a fan in a
// row, a column or a grid (spec section 20, "Places on the scene").
// Drawing only: the place's list and its order are the server's. Pure
// functions, so they run under Node too (tests/client/fan.test.mjs).

/** What a look's fields are when no level gives them. */
export const LOOK_DEFAULTS = {
  mode: "stack",
  skew: 0,
  gap: 8,
  length: 480,
  min_step: 8,
  align: "start",
  slot: [100, 140],
  label: "name_count",
  columns: 5,
};

/** A row's or a column's step when its look does not say. (A grid's is a
 * slot and a gap.) */
const LINE_STEP = 28;

/** The edge a mode reveals when its look does not say. */
const REVEAL_DEFAULTS = {
  stack: "none",
  row: "left",
  column: "top",
  grid: "none",
};

/**
 * A place's look, its levels laid over each other field by field, the
 * later winning, with the defaults under all of them.
 *
 * @param {...(object|null|undefined)} levels the place declaration's
 *   look, then a node's or a placemat place's
 * @returns {object} every field of the look
 */
export function resolveLook(...levels) {
  const ret = { ...LOOK_DEFAULTS };

  // Each level's fields over the ones before.
  for (const level of levels) {
    for (const [key, value] of Object.entries(level || {})) {
      if (value != null) {
        ret[key] = value;
      }
    }
  }

  // The reveal, by mode, when no level said.
  if (ret.reveal == null) {
    ret.reveal = REVEAL_DEFAULTS[ret.mode] || "none";
  }

  return ret;
}

/**
 * Lay out a fan: where each token's slot goes, in the place's own frame,
 * and in which order they are drawn.
 *
 * The frame's box is the fan's length along its direction and one slot
 * across it (a grid: its length across, and rows going down). A fan
 * longer than its length squeezes its step down to min_step, and is then
 * scaled; one whose tokens may not overlap is only scaled.
 *
 * @param {object} look a resolved look (resolveLook)
 * @param {number} count how many tokens it holds
 * @returns {{box: {w: number, h: number}, scale: number,
 *   slots: Array<{x: number, y: number}>, order: number[],
 *   cell: {w: number, h: number}, step: number, rowStep: number}}
 *   the box; how much each slot is scaled; each token's slot's top-left
 *   corner, by its index in the list; the indexes in drawing order (the
 *   last on top); a slot's scaled size; and the scaled steps
 */
export function fanLayout(look, count) {
  let ret = null;

  if (look.mode === "grid") {
    ret = gridLayout(look, count);
  } else {
    ret = lineLayout(look, count);
  }

  return ret;
}

/**
 * Lay out a row or a column.
 *
 * @param {object} look a resolved look, its mode row or column
 * @param {number} count how many tokens it holds
 * @returns {object} the layout, as fanLayout gives it
 */
function lineLayout(look, count) {
  const isRow = (look.mode !== "column");
  const [slotW, slotH] = look.slot;
  const overlaps = (look.reveal !== "none");
  const slots = [];
  const order = [];
  let along = slotH;
  let across = slotW;
  let step = look.step ?? LINE_STEP;
  let extent = 0;
  let scale = 1;
  let start = 0;
  let a = 0;
  let b = 0;

  // A slot's size along the fan and across it.
  if (isRow) {
    along = slotW;
    across = slotH;
  }

  // The step: one that does not overlap, or the look's.
  if (!overlaps) {
    step = along + look.gap;
  }

  // Squeeze the step to fit the length, then scale what still does not.
  extent = along + Math.max(0, count - 1) * step;
  if ((extent > look.length) && (overlaps) && (count > 1)) {
    step = Math.max(look.min_step, (look.length - along) / (count - 1));
    extent = along + (count - 1) * step;
  }
  if (extent > look.length) {
    scale = look.length / extent;
  }

  // Where a short fan starts in its length.
  start = alignStart(look.align, look.length, extent * scale);

  // Each slot along the fan, moved across it by the skew, and centered
  // across when scaled.
  for (let i = 0; i < count; i++) {
    a = start + i * step * scale;
    b = (i * look.skew * scale) + (across - across * scale) / 2;
    if (isRow) {
      slots.push({ x: a, y: b });
    } else {
      slots.push({ x: b, y: a });
    }
  }

  // The drawing order: a fan revealing the start of each token draws
  // each over the one before it; one revealing the end, under it.
  for (let i = 0; i < count; i++) {
    order.push(i);
  }
  if ((look.reveal === "right") || (look.reveal === "bottom")) {
    order.reverse();
  }

  return {
    box: lineBox(isRow, look.length, across),
    scale,
    slots,
    order,
    cell: { w: slotW * scale, h: slotH * scale },
    step: step * scale,
    rowStep: 0,
  };
}

/**
 * The box of a row or a column: its length along it, a slot across.
 *
 * @param {boolean} isRow whether it is a row
 * @param {number} length its length
 * @param {number} across a slot's size across it
 * @returns {{w: number, h: number}} the box
 */
function lineBox(isRow, length, across) {
  let ret = { w: across, h: length };

  if (isRow) {
    ret = { w: length, h: across };
  }

  return ret;
}

/**
 * Where a fan of some extent starts in its length.
 *
 * @param {string} align start, center or end
 * @param {number} length the length it may take
 * @param {number} extent the length it takes
 * @returns {number} its start
 */
function alignStart(align, length, extent) {
  let ret = 0;

  switch (align) {
    case "center":
      ret = (length - extent) / 2;
      break;
    case "end":
      ret = length - extent;
      break;
    default:
      ret = 0;
  }

  return ret;
}

/**
 * Lay out a grid: rows of `columns` slots across its length, filled like
 * text, going down. Scaled when a row is longer than its length.
 *
 * @param {object} look a resolved look, its mode grid
 * @param {number} count how many tokens it holds
 * @returns {object} the layout, as fanLayout gives it
 */
function gridLayout(look, count) {
  const [slotW, slotH] = look.slot;
  const columns = Math.max(1, look.columns);
  const across = Math.min(columns, Math.max(1, count));
  const slots = [];
  const order = [];
  let step = slotW + look.gap;
  let rowStep = slotH + look.gap;
  let extent = 0;
  let scale = 1;
  let start = 0;

  // The steps: the look's, or a slot and a gap.
  if (look.step != null) {
    step = look.step;
  }
  if (look.row_step != null) {
    rowStep = look.row_step;
  }

  // Scale a row that does not fit, and align a short one.
  extent = slotW + (columns - 1) * step;
  if (extent > look.length) {
    scale = look.length / extent;
  }
  start = alignStart(
    look.align,
    look.length,
    (slotW + (across - 1) * step) * scale,
  );

  // Each slot, by its column and row.
  for (let i = 0; i < count; i++) {
    slots.push({
      x: start + (i % columns) * step * scale,
      y: Math.floor(i / columns) * rowStep * scale,
    });
    order.push(i);
  }

  return {
    box: { w: look.length, h: slotH },
    scale,
    slots,
    order,
    cell: { w: slotW * scale, h: slotH * scale },
    step: step * scale,
    rowStep: rowStep * scale,
  };
}

/**
 * Where a token dropped at a point would go in a fan: how many tokens
 * come before the point. Left of the first token's middle is 0 ("add
 * before"), past the last one's middle is the count ("add after").
 *
 * @param {object} look a resolved look
 * @param {object} layout its layout (fanLayout)
 * @param {{x: number, y: number}} point the drop, in the place's frame
 * @returns {number} the index, 0 to the count
 */
export function insertIndex(look, layout, point) {
  const count = layout.slots.length;
  const columns = Math.max(1, look.columns);
  let ret = 0;
  let row = 0;
  let first = 0;
  let last = 0;

  if (look.mode === "grid") {
    // The row under the point, then the place in that row.
    row = Math.floor(point.y / Math.max(1, layout.rowStep));
    row = Math.max(0, row);
    first = Math.min(count, row * columns);
    last = Math.min(count, first + columns);
    ret = first + countBefore(layout, first, last, "x", point.x);
  } else if (look.mode === "column") {
    ret = countBefore(layout, 0, count, "y", point.y);
  } else {
    ret = countBefore(layout, 0, count, "x", point.x);
  }

  return ret;
}

/**
 * How many slots from first up to last have their middle before a
 * value along an axis.
 *
 * @param {object} layout the fan's layout
 * @param {number} first the first slot's index
 * @param {number} last one past the last slot's index
 * @param {string} axis "x" or "y"
 * @param {number} value the point's coordinate on that axis
 * @returns {number} how many
 */
function countBefore(layout, first, last, axis, value) {
  let half = layout.cell.h / 2;
  let ret = 0;

  // Half a slot along the axis: where its middle is.
  if (axis === "x") {
    half = layout.cell.w / 2;
  }

  for (let i = first; i < last; i++) {
    if ((layout.slots[i][axis] + half) < value) {
      ret += 1;
    }
  }

  return ret;
}

/**
 * Where to draw the marker that shows an insert position: a line across
 * the fan, between the tokens it would go between.
 *
 * @param {object} look a resolved look
 * @param {object} layout its layout
 * @param {number} index the insert position
 * @returns {{x1: number, y1: number, x2: number, y2: number}} the line
 */
export function insertMarker(look, layout, index) {
  const count = layout.slots.length;
  const { w, h } = layout.cell;
  const isColumn = (look.mode === "column");
  let ret = null;
  let at = 0;
  let slot = null;
  let along = w;

  // A slot's size along the fan.
  if (isColumn) {
    along = h;
  }

  if (count === 0) {
    // An empty fan: at its first slot's start.
    at = alignStart(look.align, look.length, along);
    slot = { x: at, y: 0 };
    if (isColumn) {
      slot = { x: 0, y: at };
    }
  } else if (index < count) {
    slot = layout.slots[index];
  } else {
    slot = layout.slots[count - 1];
  }

  // Before the slot at the index, or after the last one.
  if (isColumn) {
    at = slot.y - 2;
    if ((count > 0) && (index >= count)) {
      at = slot.y + h + 2;
    }
    ret = { x1: slot.x - 6, y1: at, x2: slot.x + w + 6, y2: at };
  } else {
    at = slot.x - 2;
    if ((count > 0) && (index >= count)) {
      at = slot.x + w + 2;
    }
    ret = { x1: at, y1: slot.y - 6, x2: at, y2: slot.y + h + 6 };
  }

  return ret;
}
