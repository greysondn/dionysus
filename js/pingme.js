// "Ping me": the spots on the board where a viewer's own tokens stand, for
// the tool bar's button to ping. The game says which tokens are the
// viewer's, in its ping_me declaration: a token kind, and optionally the
// seat value that names the side the viewer's tokens show (Monopoly's
// pawn is the one whose side is the seat's color). With no seat value, a
// token is the viewer's when it is owned by their seat. Pure functions,
// so they run under Node too (tests/client/pingme.test.mjs).

/**
 * Whether the viewer has a ping-me button to press: the game declared the
 * facility.
 *
 * @param {object|null} declaration the game's ping_me declaration
 * @returns {boolean} true when the game provides it
 */
export function providesPingMe(declaration) {
    return ((declaration != null) && (typeof declaration.kind === "string"));
}

/**
 * Whether a token is one of the viewer's own.
 *
 * @param {object} entity the token
 * @param {object} declaration the game's ping_me declaration
 * @param {object} tree the viewer's view
 * @param {number} seat the viewer's seat
 * @returns {boolean} true when it is the viewer's
 */
function isMine(entity, declaration, tree, seat) {
    let ret = false;
    let side = null;

    if (entity.kind !== declaration.kind) {
        ret = false;
    } else if (declaration.side_value != null) {
        side = tree?.values?.[declaration.side_value]?.[String(seat)];
        ret = ((side != null) && (entity.side === side));
    } else {
        ret = (entity.owner === seat);
    }

    return ret;
}

/**
 * The spots to ping: where each of the viewer's own tokens stands on the
 * scene they are looking at. A token that is not on the board (off the
 * table, in a hand or on another scene) is left out.
 *
 * @param {object} tree the viewer's view
 * @param {object|null} declaration the game's ping_me declaration
 * @param {number|null} seat the viewer's seat
 * @param {string} sceneKey the scene the viewer is on
 * @returns {Array<{x: number, y: number}>} the spots, in token order
 */
export function pingMeSpots(tree, declaration, seat, sceneKey) {
    const ret = [];

    // Each token of the viewer's that stands on this scene.
    if ((providesPingMe(declaration)) && (seat != null)) {
        for (const entity of Object.values(tree?.entities || {})) {
            if (
                (entity != null) &&
                (!entity.hidden) &&
                (isMine(entity, declaration, tree, seat)) &&
                (entity.scene === sceneKey) &&
                (typeof entity.x === "number") &&
                (typeof entity.y === "number")
            ) {
                ret.push({ x: entity.x, y: entity.y });
            }
        }
    }

    return ret;
}
