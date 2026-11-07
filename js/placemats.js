// Placemats and labels on the scene (spec section 20): which seats have a
// placemat, how each lies, and the text a label shows. Drawing only, from
// the state the viewer was sent. Pure functions, so they run under Node
// too (tests/client/placemats.test.mjs).
import { SIDE_TURNS, sideFor } from "./facing.js";

/**
 * The seats that have this placemat drawn: each seat with a spot whose
 * every mat place exists for it (with the free tabletop, the seats sat
 * in when the match started).
 *
 * @param {object} mat the placemat's declaration
 * @param {object} places the state's places, as the viewer sees them
 * @returns {string[]} the seat numbers, in order
 */
export function matSeats(mat, places) {
  const ret = [];
  const names = (mat.places || []).map((place) => place.place_id);
  let hasAll = false;

  for (const seat of Object.keys(mat.spots || {})) {
    hasAll = (names.length > 0);
    for (const name of names) {
      if ((places || {})[`${name}.${seat}`] == null) {
        hasAll = false;
      }
    }
    if (hasAll) {
      ret.push(seat);
    }
  }

  return ret.sort((a, b) => Number(a) - Number(b));
}

/**
 * How far a seat's placemat is turned on the scene, clockwise: its
 * spot's rotation, or the turn that has it face the side the seat sits
 * on (a seat in the north gets 180, one in the east 270), so the seat's
 * own view of the table shows it upright.
 *
 * @param {object} spot the seat's spot
 * @param {object|undefined} seatSides the scene's seat_sides
 * @param {string} seat the seat number
 * @returns {number} degrees, 0 to 359
 */
export function matRotation(spot, seatSides, seat) {
  let ret = 0;

  if (spot.rotation != null) {
    ret = spot.rotation;
  } else {
    ret = -SIDE_TURNS[sideFor(seatSides, Number(seat))];
  }

  return ((ret % 360) + 360) % 360;
}

/**
 * A path in a label, with {seat} replaced by the mat's seat.
 *
 * @param {string} path the path as declared
 * @param {string|null} seat the mat's seat, or null on the board
 * @returns {string} the path
 */
export function seatPath(path, seat) {
  let ret = path;

  if (seat != null) {
    ret = path.replaceAll("{seat}", String(seat));
  }

  return ret;
}

/**
 * The value at a path ("mechanics/phase10/phase/2") in a state tree.
 *
 * @param {object} tree the state
 * @param {string} path the path, its parts split by "/"
 * @returns {*} the value, or undefined when there is none
 */
export function readPath(tree, path) {
  let ret = tree;

  for (const part of path.split("/")) {
    if ((ret != null) && (typeof ret === "object")) {
      ret = ret[part];
    } else {
      ret = undefined;
    }
  }

  return ret;
}

/**
 * Fill a label's {{name}} holes.
 *
 * @param {string} template the text, with its holes
 * @param {function(string): (string|null)} resolve the text of a hole
 *   by name, or null when it cannot be filled
 * @returns {string|null} the text, or null when a hole cannot be filled
 */
export function fillText(template, resolve) {
  let ret = "";
  let from = 0;
  let value = null;

  // Copy the text between holes, and each hole's text. A hole ends at
  // the first "}}" not followed by another "}", so a {seat} inside one
  // ({{count:play_a.{seat}}}) stays part of its name.
  for (const match of template.matchAll(/\{\{(.+?)\}\}(?!\})/g)) {
    value = resolve(match[1].trim());
    if ((ret != null) && (value != null)) {
      ret += template.slice(from, match.index) + value;
    } else {
      ret = null;
    }
    from = match.index + match[0].length;
  }
  if (ret != null) {
    ret += template.slice(from);
  }

  return ret;
}
