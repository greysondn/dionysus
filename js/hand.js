// The hand panel's bookkeeping: which cards just came into the viewer's
// hand, so the panel can mark them, and where a card dragged off the board
// onto the hand panel goes. Pure functions, so they run under Node too
// (tests/client/hand.test.mjs).

/**
 * The cards that came into a hand: those in it now that were not in it
 * before.
 *
 * When every card in it now is new, the whole hand was replaced (a deal, a
 * new hand, or a seat just taken) and none of them is marked: a fresh hand
 * all marked tells the player nothing.
 *
 * @param {Array<string>} before the hand's token ids before the event
 * @param {Array<string>} after the hand's token ids after it
 * @returns {Array<string>} the ids that came in, or none when the whole
 *   hand was replaced
 */
export function newArrivals(before, after) {
  const had = new Set(before);
  let ret = [];

  // The ones it did not have.
  for (const id of after) {
    if (!had.has(id)) {
      ret.push(id);
    }
  }

  // None, when the whole hand is new.
  if (ret.length === after.length) {
    ret = [];
  }

  return ret;
}

/**
 * The request that takes a card from the board into a place in the
 * viewer's hand: a take for a token lying loose on the table, a play for
 * one in a place drawn on the board (a row, a fan, the discard), and
 * taking back one of the viewer's own pending cards (drawn faded where it
 * will land) for a pending one.
 *
 * @param {string} id the token's id
 * @param {string|null} from the place holding it, or null when it lies on
 *   the table
 * @param {string} to the hand place it goes into
 * @param {boolean} [isPending=false] whether it is the viewer's pending
 *   card, held back from the place it is drawn in
 * @returns {{action: string, params: object}|null} the action and its
 *   params, or null when it is already in that place
 */
export function takeIntoHand(id, from, to, isPending = false) {
  let ret = null;

  if (isPending) {
    ret = { action: "pending.return", params: { token: id } };
  } else if (from == null) {
    ret = { action: "tabletop.take", params: { token: id, to: to } };
  } else if (from !== to) {
    ret = { action: "tabletop.play", params: { token: id, to: to } };
  } else {
    ret = null;
  }

  return ret;
}

/**
 * Which of the hand panel's places a card dropped on the panel goes into:
 * the one it was let go over, or else the first.
 *
 * @param {Array<string>} shown the place ids the hand panel shows, in
 *   order
 * @param {string|null|undefined} under the place id of the block under
 *   the pointer, when there is one
 * @returns {string|null} the place, or null when the panel shows none
 */
export function handDropPlace(shown, under) {
  let ret = null;

  if ((under != null) && (shown.includes(under))) {
    ret = under;
  } else if (shown.length > 0) {
    ret = shown[0];
  } else {
    ret = null;
  }

  return ret;
}
