// Zooming and panning the board: where the part of the board in view is.
// The view is a window onto the board's whole box, as large as the box
// divided by the zoom, kept inside it. These are pure functions, so they
// run under Node too (tests/client/viewport.test.mjs).

/**
 * The least zoom: the whole board.
 */
export const MIN_ZOOM = 1;

/**
 * The most the board can be zoomed in.
 */
export const MAX_ZOOM = 8;

/**
 * What one step in or out multiplies the zoom by.
 */
export const ZOOM_STEP = 1.25;

/**
 * Keep a zoom between the least and the most.
 *
 * @param {number} zoom the zoom asked for
 * @returns {number} the nearest zoom allowed
 */
export function clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The zoom a step in or out leads to.
 *
 * @param {number} zoom the zoom now
 * @param {number} direction 1 to zoom in, -1 to zoom out
 * @returns {number} the new zoom
 */
export function stepZoom(zoom, direction) {
    let ret = zoom;

    if (direction > 0) {
        ret = clampZoom(zoom * ZOOM_STEP);
    } else {
        ret = clampZoom(zoom / ZOOM_STEP);
    }

    return ret;
}

/**
 * The window onto the board for a zoom and a centre, the centre moved in
 * if the window would leave the board.
 *
 * @param {Array<number>} base the board's whole box: [x, y, width, height]
 * @param {number} zoom the zoom
 * @param {{x: number, y: number}|null} center what the window is centred
 *     on, or null for the middle of the board
 * @returns {{box: Array<number>, center: {x: number, y: number}}} the
 *     window as a box, and the centre it really has
 */
export function windowFor(base, zoom, center) {
    const [x, y, width, height] = base;
    const z = clampZoom(zoom);
    const w = width / z;
    const h = height / z;
    const want = center || { x: x + width / 2, y: y + height / 2 };
    const cx = Math.min(x + width - w / 2, Math.max(x + w / 2, want.x));
    const cy = Math.min(y + height - h / 2, Math.max(y + h / 2, want.y));

    return { box: [cx - w / 2, cy - h / 2, w, h], center: { x: cx, y: cy } };
}
