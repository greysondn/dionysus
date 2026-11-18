// Placing a card without the board, for the hand view on a phone: pick the
// card, then the area it goes to (the table's own places, or a seat's),
// then the spot in that area. Three taps, and the picker can be cancelled
// at any step. The areas and spots are pure functions, so they run under
// Node too (tests/client/pick.test.mjs).

import { h, s } from "./ui.js";

/**
 * The area of the table's own places, which no seat owns.
 */
export const TABLE_AREA = "table";

/**
 * How many of a pile's top cards the spot step shows beside it.
 */
const SHOWN_CARDS = 6;

/**
 * How many cards of a stack the spot step shows: only the top one, as
 * the hand view's pile list does. What lies under it is a history the
 * players are not meant to browse, even where the cards are face up.
 */
const STACK_SHOWN_CARDS = 1;

/**
 * The place holding a token, among the places the viewer can see into.
 *
 * @param {object} places the places, each an array of token ids or (when
 *     the viewer sees only how many) a count
 * @param {string} token the token's id
 * @returns {string|null} the place's id, or null when it is in none
 */
export function holderOf(places, token) {
  let ret = null;

  for (const [pid, contents] of Object.entries(places || {})) {
    if ((Array.isArray(contents)) && (contents.includes(token))) {
      ret = pid;
    }
  }

  return ret;
}

/**
 * The areas a token can go to: the table's own places, the viewer's own
 * (their hand among them), and each other seat's places that everyone
 * sees face up. The place it is in now is left out, and so is an area
 * left with no places.
 *
 * Each area lists its places in the order the game declares them. The
 * table's area comes first, then the viewer's, then the other seats' in
 * seat order.
 *
 * @param {object} places the places the viewer sees
 * @param {Array<object>} declarations the game's place declarations
 * @param {number|null} seat the viewer's seat
 * @param {string} token the token being placed
 * @returns {Array<{key: string, seat: number|null, places: string[]}>}
 *     the areas
 */
export function areasFor(places, declarations, seat, token) {
  const from = holderOf(places, token);
  const order = (declarations || []).map((d) => d.place_id);
  const byKey = new Map();
  const ret = [];
  let ids = [];

  // Each place, into its area, unless it is where the token is or another
  // seat's private place.
  for (const pid of Object.keys(places || {})) {
    const [base, owner] = pid.split(".");
    const declaration = (declarations || []).find((d) => (
      d.place_id === base
    ));
    const isOther = (
      (owner !== undefined) &&
      (Number(owner) !== seat)
    );
    const isPublic = (declaration?.visibility?.others_see === "face");
    let key = TABLE_AREA;
    let owningSeat = null;

    if (owner !== undefined) {
      key = `seat:${owner}`;
      owningSeat = Number(owner);
    }
    if ((pid !== from) && ((!isOther) || (isPublic))) {
      if (!byKey.has(key)) {
        byKey.set(key, { key: key, seat: owningSeat, places: [] });
      }
      byKey.get(key).places.push(pid);
    }
  }

  // The places in each area in the game's order, and the areas in theirs.
  for (const area of byKey.values()) {
    area.places.sort((a, b) => (
      order.indexOf(a.split(".")[0]) - order.indexOf(b.split(".")[0])
    ));
  }
  ids = [...byKey.keys()].sort((a, b) => (
    areaRank(a, seat) - areaRank(b, seat)
  ));
  for (const key of ids) {
    ret.push(byKey.get(key));
  }

  return ret;
}

/**
 * Where an area sorts: the table's first, the viewer's next, then the
 * other seats' in seat order.
 *
 * @param {string} key the area's key
 * @param {number|null} seat the viewer's seat
 * @returns {number} its rank, lower first
 */
function areaRank(key, seat) {
  let ret = 0;

  if (key === TABLE_AREA) {
    ret = -2;
  } else if (key === `seat:${seat}`) {
    ret = -1;
  } else {
    ret = Number(key.slice("seat:".length));
  }

  return ret;
}

/**
 * The spots in a place a token can go: one for a pile (on top), a place
 * that keeps itself sorted, an unordered place, or one the viewer sees
 * only a count of; and for a place kept in the order cards are laid, a
 * spot before each card and one after the last.
 *
 * @param {object|undefined} declaration the place's declaration
 * @param {Array<string>|object} contents the place's tokens, or a count
 * @returns {Array<number|null>} each spot's index, null for the end
 */
export function spotsFor(declaration, contents) {
  const isLaidOrder = (
    (declaration?.ordering === "ordered") &&
    (!((declaration?.order_by || []).length > 0))
  );
  const ret = [];

  // A spot at every gap where the order is the player's; else one.
  if ((isLaidOrder) && (Array.isArray(contents)) && (contents.length > 0)) {
    for (let i = 0; i <= contents.length; i++) {
      ret.push(i);
    }
  } else {
    ret.push(null);
  }

  return ret;
}

/**
 * The cards of a one-spot place that the spot step draws beside its
 * button: a stack shows only its top card, any other place its last few.
 *
 * @param {object|undefined} declaration the place's declaration
 * @param {Array<string>} cards the place's tokens, bottom first
 * @returns {Array<string>} the tokens to draw, bottom first
 */
export function shownCards(declaration, cards) {
    let ret = [];

    // A stack keeps what is under its top card to itself.
    if (declaration?.ordering === "stack") {
        ret = cards.slice(-STACK_SHOWN_CARDS);
    } else {
        ret = cards.slice(-SHOWN_CARDS);
    }

    return ret;
}

/**
 * The picker: a dialog that steps from the card to its area to its spot,
 * then plays it there.
 */
export class PlacePicker {
  /**
   * @param {object} table the table page, for its state, look, seat names
   *     and acting
   * @param {string} token the token to place
   */
  constructor(table, token) {
    this.table = table;
    this.token = token;
    this.body = h("div.dialog-body.picker");
    this.back = h("button.ghost", {
      type: "button",
      onclick: () => this.showAreas(),
    }, "Back");
    this.dialog = h(
      "dialog.dialog.place-picker",
      {},
      h("header", {}, h("h2", {}, "Play a card")),
      this.body,
      h(
        "footer",
        {},
        this.back,
        h("button", {
          type: "button",
          onclick: () => this.close(),
        }, "Cancel"),
      ),
    );
    // Escape closes it too.
    this.dialog.addEventListener("close", () => this.dialog.remove());
  }

  /**
   * Open the picker on its first step: the areas.
   */
  open() {
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.showAreas();
  }

  /**
   * Close the picker and take it off the page. It doesn't wait for the
   * dialog's close event, which a page in the background may not get to
   * before the next picker opens.
   */
  close() {
    this.dialog.close();
    this.dialog.remove();
  }

  /**
   * The step that picks an area.
   */
  showAreas() {
    const state = this.table.state;
    const areas = areasFor(
      state.places,
      this.table.look.declaration.places,
      this.table.seat,
      this.token,
    );
    let rows = [];

    // A button for each area, or word that there is nowhere to go.
    this.back.hidden = true;
    if (areas.length === 0) {
      rows = [h("p.muted", {}, "There is nowhere to play it.")];
    } else {
      rows = areas.map((area) => h("button.picker-choice", {
        type: "button",
        onclick: () => this.showSpots(area),
      }, this.areaName(area)));
    }
    this.body.replaceChildren(
      this.cardPicture(),
      h("h3", {}, "Where to?"),
      ...rows,
    );
  }

  /**
   * The step that picks a spot in an area: each of its places, with a
   * button for each spot in it, between its cards where the order is the
   * player's.
   *
   * @param {object} area the area picked
   */
  showSpots(area) {
    const blocks = [];

    // Each place, its spots among its cards.
    for (const pid of area.places) {
      blocks.push(this.placeBlock(pid));
    }

    this.back.hidden = false;
    this.body.replaceChildren(
      this.cardPicture(),
      h("h3", {}, `Where in ${this.areaName(area)}?`),
      ...blocks,
    );
  }

  /**
   * One place in the spot step: its name, and its cards with a spot
   * button at each place the card can go.
   *
   * @param {string} pid the place's id
   * @returns {HTMLElement} the block
   */
  placeBlock(pid) {
      const contents = this.table.state.places?.[pid];
      const base = pid.split(".")[0];
      const declaration = (this.table.look.declaration.places || [])
          .find((d) => d.place_id === base);
      const spots = spotsFor(declaration, contents);
      const row = h("div.picker-row");
      let cards = [];
      let count = 0;

      // Its cards, and how many it holds.
      if (Array.isArray(contents)) {
          cards = contents;
          count = contents.length;
      } else {
          count = contents?.count ?? 0;
      }

      // Its cards, with a spot before each and after the last; or one spot.
      if (spots[0] === null) {
          row.append(this.spotButton(pid, null, "Put it here"));
          for (const id of shownCards(declaration, cards)) {
              row.append(this.miniCard(id));
          }
      } else {
          for (const index of spots) {
              row.append(this.spotButton(pid, index, "+"));
              if (index < cards.length) {
                  row.append(this.miniCard(cards[index]));
              }
          }
      }

      return h(
          "div.picker-place",
          {},
          h(
              "h4",
              {},
              `${declaration?.name || base} `,
              h("span.muted", {}, `${count}`),
          ),
          row,
      );
  }

  /**
   * A button that plays the card into a spot, and closes the picker.
   *
   * @param {string} pid the place
   * @param {number|null} index the spot, null for the end
   * @param {string} label the button's text
   * @returns {HTMLButtonElement} the button
   */
  spotButton(pid, index, label) {
    const params = { token: this.token, to: pid };

    if (index !== null) {
      params.index = index;
    }

    return h("button.picker-spot", {
      type: "button",
      onclick: () => {
        this.close();
        this.table.act("tabletop.play", params);
      },
    }, label);
  }

  /**
   * What an area is called: the table, "You", or the seat's name.
   *
   * @param {object} area the area
   * @returns {string} its name
   */
  areaName(area) {
    let ret = "";

    if (area.seat === null) {
      ret = "The table";
    } else if (area.seat === this.table.seat) {
      ret = "Your places";
    } else {
      ret = this.table.seatName(area.seat);
    }

    return ret;
  }

  /**
   * The card being placed, drawn small at the top of each step.
   *
   * @returns {HTMLElement|null} its picture
   */
  cardPicture() {
    return h("div.picker-card", {}, this.miniCard(this.token));
  }

  /**
   * A token drawn small, as the places list draws them.
   *
   * @param {string} id the token's id
   * @returns {SVGSVGElement|null} its picture, or null when it is hidden
   */
  miniCard(id) {
    const entity = this.table.state.entities?.[id];
    let ret = null;
    let drawn = null;

    if ((entity != null) && (!entity.hidden)) {
      drawn = this.table.look.drawEntity(entity);
      ret = s(
        "svg",
        { viewBox: `0 0 ${drawn.w} ${drawn.h}`, class: "mini-card" },
        drawn.node,
      );
    }

    return ret;
  }
}
