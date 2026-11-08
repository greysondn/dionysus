// Seat values (a phase, a score, a goal) as the table shows them: in
// label holes, beside each seat's name, and above the viewer's hand. The
// game declares them in seat_values; the view holds each seat's under
// values/<key>/<seat>, and a score's changes under
// value_history/<key>/<seat>. Pure functions, so they run under Node too
// (tests/client/seatvalues.test.mjs).

/**
 * The game's seat values, by key.
 *
 * @param {object} declaration the game's declaration
 * @returns {Map<string, object>} each value's declaration, by its key
 */
export function valueDeclarations(declaration) {
  const ret = new Map();

  for (const value of declaration?.seat_values || []) {
    ret.set(value.key, value);
  }

  return ret;
}

/**
 * The seat values the game shows in one spot.
 *
 * @param {Map<string, object>} declarations the seat values, by key
 * @param {string} spot "seat_strip" or "hand"
 * @returns {Array<object>} their declarations, in the game's order
 */
export function shownIn(declarations, spot) {
  const ret = [];

  for (const value of declarations.values()) {
    if ((value.show || []).includes(spot)) {
      ret.push(value);
    }
  }

  return ret;
}

/**
 * A seat's value, as the viewer's view holds it.
 *
 * @param {object} tree the viewer's view
 * @param {string} key the value's key
 * @param {number|string} seat the seat
 * @returns {*} the value, or undefined when the viewer does not see it
 */
export function seatValue(tree, key, seat) {
  return tree?.values?.[key]?.[String(seat)];
}

/**
 * The text key a value maps to, through its declaration's texts.
 *
 * @param {object} declaration the value's declaration
 * @param {*} value the value
 * @returns {string|null} the text key, or null when it maps to none
 */
export function valueTextKey(declaration, value) {
  let ret = null;

  if ((value != null) && (declaration?.texts?.[String(value)] != null)) {
    ret = declaration.texts[String(value)];
  }

  return ret;
}

/**
 * Which value and seat a label hole names: "phase" (the mat's seat) or
 * "phase.2" (seat 2).
 *
 * @param {string} rest the hole's name after "value:" or "text:"
 * @param {string|null} seat the placemat's seat, or null on the board
 * @returns {{key: string, seat: string}|null} the value and seat, or null
 *   when no seat is named or implied
 */
export function parseHole(rest, seat) {
  const match = /^([a-z0-9_]+)(?:\.(\d+))?$/.exec(rest);
  let ret = null;

  if (match == null) {
    ret = null;
  } else if (match[2] != null) {
    ret = { key: match[1], seat: match[2] };
  } else if (seat != null) {
    ret = { key: match[1], seat: String(seat) };
  } else {
    ret = null;
  }

  return ret;
}

/**
 * The text of a label hole that reads a seat value: {{value:phase}} is the
 * value itself, {{text:phase}} the string its texts map it to.
 *
 * @param {object} tree the viewer's view
 * @param {Map<string, object>} declarations the seat values, by key
 * @param {string} name the hole's name, "value:..." or "text:..."
 * @param {string|null} seat the placemat's seat, or null on the board
 * @param {function(string): string} translate a text key's string
 * @returns {string|null} the text, or null when it cannot be filled
 */
export function holeText(tree, declarations, name, seat, translate) {
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  const named = parseHole(name.slice(colon + 1), seat);
  let ret = null;
  let value;
  let textKey = null;

  if (named != null) {
    value = seatValue(tree, named.key, named.seat);
  }
  if (value == null) {
    ret = null;
  } else if (kind === "value") {
    ret = String(value);
  } else if (kind === "text") {
    textKey = valueTextKey(declarations.get(named.key), value);
    if (textKey != null) {
      ret = translate(textKey);
    }
  } else {
    ret = null;
  }

  return ret;
}

/**
 * Whether the viewer may edit a seat's value by hand. The server decides;
 * this only says whether to offer it.
 *
 * @param {object} declaration the value's declaration
 * @param {number|null} viewerSeat the viewer's seat
 * @param {number} seat the seat whose value it is
 * @param {boolean} isGM whether the viewer is the GM
 * @returns {boolean} true when the viewer may
 */
export function mayEdit(declaration, viewerSeat, seat, isGM) {
  let ret = false;

  if (viewerSeat == null) {
    ret = false;
  } else if (isGM) {
    ret = true;
  } else {
    switch (declaration.edit || "owner") {
      case "owner":
        ret = (viewerSeat === seat);
        break;
      case "anyone":
        ret = true;
        break;
      default:
        ret = false;
        break;
    }
  }

  return ret;
}

/**
 * A history entry's change as the score sheet shows it: +45, -10, 0.
 *
 * @param {number} change how much it changed
 * @returns {string} the change, signed
 */
export function signed(change) {
  let ret = String(change);

  if (change > 0) {
    ret = `+${change}`;
  }

  return ret;
}

/**
 * The rows of a score sheet: one per entry, numbered from 1, for each
 * seat seen, side by side. A seat with fewer entries has blanks.
 *
 * @param {object} bySeat each seat's entries, by seat number as text
 * @param {Array<number>} seats the seats, in the sheet's column order
 * @returns {Array<Array<object|null>>} each row's entry for each seat,
 *   or null where the seat has none
 */
export function sheetRows(bySeat, seats) {
  const ret = [];
  let longest = 0;
  let row = [];

  // The longest column says how many rows there are.
  for (const seat of seats) {
    longest = Math.max(longest, (bySeat?.[String(seat)] || []).length);
  }

  // Each row: every seat's entry at that place, or a blank.
  for (let i = 0; i < longest; i += 1) {
    row = [];
    for (const seat of seats) {
      row.push((bySeat?.[String(seat)] || [])[i] ?? null);
    }
    ret.push(row);
  }

  return ret;
}
