// Seeing the table from a seat (spec section 20): the scene is drawn turned so the viewer's side of the table is at
// the bottom, and what must read is turned back. Drawing only: the scene, its state and every action stay in the
// scene's own frame. Pure functions, so they run under Node too (tests/client/facing.test.mjs).

/** How far the view turns, clockwise in degrees, to bring a side to the bottom of the screen. */
export const SIDE_TURNS = { south: 0, west: 270, north: 180, east: 90 };
export const SIDES = Object.keys(SIDE_TURNS);

/** The side a viewer sees a scene from: their choice, or for "seat" (the default) the side the scene declares for
 * their seat. A seat the scene does not list, the GM and the table view (no seat) sit south. */
export function sideFor(seatSides, seat, choice = "seat") {
  if (SIDES.includes(choice)) return choice;
  const side = seat == null ? null : (seatSides || {})[String(seat)];
  return SIDES.includes(side) ? side : "south";
}

const norm = (deg) => {                     // into (-180, 180]
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

/** The scene's view box once turned about its center: a quarter turn swaps its width and height. */
export function turnedBox(w, h, turn) {
  if (turn % 180 === 0) return [0, 0, w, h];
  return [(w - h) / 2, (h - w) / 2, h, w];
}

/** The transform that turns the scene's content about its center. */
export function turnTransform(w, h, turn) {
  return turn ? `rotate(${turn} ${w / 2} ${h / 2})` : "";
}

/** A point in the turned view box back to the scene's own frame: what every pointer position goes through. */
export function toScene(x, y, w, h, turn) {
  const cx = w / 2, cy = h / 2, a = (-turn * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** A scene point to where it is drawn in the turned view box (toScene's inverse). */
export function fromScene(x, y, w, h, turn) {
  return toScene(x, y, w, h, -turn);
}

/** How much a drawing turns back, about its own anchor, under a view turned by `turn`. `reorient` is "board" (it
 * keeps its direction on the board: no turn back) or a step in degrees dividing 360: it turns back by the multiple
 * of the step that leaves it nearest upright on screen, and of two equally near, the one turned clockwise (a quarter
 * clockwise reads top to bottom, as on a book's spine). */
export function turnBack(turn, reorient = 90) {
  const step = Number(reorient);
  if (reorient === "board" || !(step > 0) || step >= 360) return 0;
  let best = null;
  for (let k = 0; k * step < 360; k++) {
    const net = norm(turn + k * step);
    if (best == null || Math.abs(net) < Math.abs(best) || (Math.abs(net) === Math.abs(best) && net > best)) best = net;
  }
  return norm(best - turn);
}
