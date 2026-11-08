/**
 * Pending plays, as the client draws them.
 *
 * A place the game declares with "hold": true holds what a player plays
 * into it: the server keeps the cards in the player's pending layer
 * (tree.pending[seat]) until they commit the play. The player's own tree
 * has their entries whole; every other seat's is only {count}. The player
 * sees their pending cards faded where they will land, and commits or
 * cancels from the turn line. Hints (tree.hints[place]) are short lines a
 * rules mechanic writes, which placemat labels show through
 * {{hint:<place>}}.
 */

/**
 * A place's tokens as the seat holding a play sees them: its own, with
 * the seat's pending tokens for it set in at their indexes (the server's
 * pending_view, the same way). The entries are in the order played, so
 * they go in by ascending index; past the end is the end.
 *
 * @param {Array<string>} contents the place's tokens
 * @param {Array<object>} entries the seat's pending entries
 * @param {string} place the place instance
 * @returns {Array<string>} the token ids, in order
 */
export function pendingView(contents, entries, place) {
  const ret = contents.slice();
  const mine = [];
  let position = 0;

  // The place's entries, by index.
  for (const entry of entries) {
    if (entry.to === place) {
      mine.push(entry);
    }
  }
  mine.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // Set each in at its index.
  for (const entry of mine) {
    position = Math.min(Math.max(entry.index ?? 0, 0), ret.length);
    ret.splice(position, 0, entry.token);
  }

  return ret;
}

/**
 * The viewer's own pending entries.
 *
 * @param {object|null} tree the viewer's tree
 * @param {number|null} seat the viewer's seat
 * @returns {Array<object>} the entries in order, or an empty list
 */
export function myPending(tree, seat) {
  const found = tree?.pending?.[String(seat)];
  let ret = [];

  if ((seat != null) && (Array.isArray(found))) {
    ret = found;
  }

  return ret;
}

/**
 * How many cards each other seat holds pending, for the seats that hold
 * any.
 *
 * @param {object|null} tree the viewer's tree
 * @param {number|null} seat the viewer's seat, left out
 * @returns {Array<{seat: number, count: number}>} the seats, in seat
 *   order
 */
export function othersPending(tree, seat) {
  const ret = [];
  let count = 0;

  for (const [key, value] of Object.entries(tree?.pending || {})) {
    // A seat's entries, or only how many.
    if (Array.isArray(value)) {
      count = value.length;
    } else {
      count = value?.count ?? 0;
    }
    if ((key !== String(seat)) && (count > 0)) {
      ret.push({ seat: Number(key), count: count });
    }
  }
  ret.sort((a, b) => a.seat - b.seat);

  return ret;
}

/**
 * The entity to draw for a pending card: the card, showing the side it
 * was played with.
 *
 * @param {object} entity the card, as the tree has it
 * @param {object} entry its pending entry
 * @returns {object} the entity to draw
 */
export function pendingEntity(entity, entry) {
  let ret = entity;

  if (entry.side != null) {
    ret = { ...entity, side: entry.side };
  }

  return ret;
}

/**
 * The text of a {{hint:<place>}} label hole: the hint the rules set for
 * the place, or "" when there is none.
 *
 * @param {object|null} tree the viewer's tree
 * @param {string} place the place instance, its {seat} already filled
 * @returns {string} the hint
 */
export function hintText(tree, place) {
  const value = tree?.hints?.[place];
  let ret = "";

  if (typeof value === "string") {
    ret = value;
  }

  return ret;
}
