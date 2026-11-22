// How a seat is named on screen. The seat is not the player, so the seat's
// own name comes first (its label, such as "Blue", or "Seat 1") and the
// player now occupying it follows in parentheses: "Seat 1 (Foo)", "Blue
// (Bar)". An empty seat is just its name. Pure functions, so they run
// under Node too (tests/client/seatnames.test.mjs).

/**
 * The player in a seat, if there is one.
 *
 * @param {Array<object>} seats the table's seat views
 * @param {number|string} n the seat's number
 * @returns {string|null} the occupant's name, or null for an empty seat
 */
export function occupantOf(seats, n) {
    const seat = (seats || []).find((x) => (x.seat_id === Number(n)));
    let ret = null;

    if ((seat?.account_name != null) && (seat.account_name !== "")) {
        ret = seat.account_name;
    }

    return ret;
}

/**
 * A seat's name with its occupant after it.
 *
 * @param {Array<object>} seats the table's seat views
 * @param {number|string} n the seat's number
 * @param {string|null} name what the game calls the seat (Monopoly's
 *     "Blue"), when it says; else the seat's label, else "Seat n"
 * @returns {string} the seat's name, then "(occupant)" when occupied
 */
export function seatTitle(seats, n, name = null) {
    const seat = (seats || []).find((x) => (x.seat_id === Number(n)));
    const occupant = occupantOf(seats, n);
    let ret = name ?? seat?.label ?? `Seat ${n}`;

    // The occupant follows, unless it is already the name.
    if ((occupant != null) && (occupant !== ret)) {
        ret = `${ret} (${occupant})`;
    }

    return ret;
}
