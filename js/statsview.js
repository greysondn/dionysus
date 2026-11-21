// How recorded stats are shown. A stat with one figure is a row. A stat kept
// by bucket (a die face, a space on a board) is a distribution: a bar for
// each bucket, in bucket order, so the shape of it can be seen. The grouping
// is a pure function, so it runs under Node too
// (tests/client/statsview.test.mjs).

import { h } from "./ui.js";

/**
 * The aggregate whose buckets are counts, so that each is a share of the
 * whole.
 */
const SUM = "sum";

/**
 * Group the rows of a stat listing by stat, a group in the order its first
 * row came. A group is a distribution when any of its rows has a bucket.
 *
 * @param {Array<object>} rows the listing: each row has a key, a name, a
 *     bucket ("" for none) and a value
 * @returns {Array<object>} the groups: {key, name, isDistribution, rows}
 */
export function groupStats(rows) {
    const groups = [];
    const byKey = new Map();
    let group = null;

    for (const row of rows) {
        group = byKey.get(row.key);
        if (group === undefined) {
            group = { key: row.key, name: row.name, isDistribution: false, rows: [] };
            byKey.set(row.key, group);
            groups.push(group);
        }
        if ((row.bucket !== undefined) && (row.bucket !== null) && (row.bucket !== "")) {
            group.isDistribution = true;
        }
        group.rows.push(row);
    }

    return groups;
}

/**
 * Put the rows of a distribution in bucket order: numbers by value (the
 * faces of a die), and anything else as text with its numbers by value
 * (the spaces of a board, numbered round it).
 *
 * @param {Array<object>} rows the rows of one stat
 * @returns {Array<object>} a sorted copy
 */
export function sortedBuckets(rows) {
    const ret = [...rows];

    ret.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket), undefined, { numeric: true }));

    return ret;
}

/**
 * A figure as it is shown: a whole number with its thousands marked, and
 * anything else to two places.
 *
 * @param {number} value the figure
 * @returns {string} the text
 */
export function formatFigure(value) {
    let ret = String(value);

    if (typeof value === "number") {
        if (Number.isInteger(value)) {
            ret = value.toLocaleString("en-US");
        } else {
            ret = value.toFixed(2);
        }
    }

    return ret;
}

/**
 * Draw one stat that has a single figure: its name and figure, and, where
 * the stat is a record, who holds it.
 *
 * @param {object} row the stat's row
 * @returns {HTMLElement} the row
 */
function figureRow(row) {
    const parts = [h("span", {}, row.name), h("b.number", {}, formatFigure(row.value))];

    if (row.holder) {
        parts.push(h("span.muted", {}, `held by ${row.holder}`));
    } else if (row.samples !== undefined) {
        parts.push(h("span.muted.small", {}, `${row.samples} samples`));
    }

    return h("div.stat-row", {}, ...parts);
}

/**
 * Draw one stat kept by bucket: a bar for each bucket, as long as its share
 * of the largest, with its count and, for a stat that counts, its share of
 * the total.
 *
 * @param {object} group the stat's group
 * @returns {HTMLElement} the distribution
 */
function distribution(group) {
    const rows = sortedBuckets(group.rows);
    const aggregate = rows[0].aggregate;
    const isCount = ((aggregate === undefined) || (aggregate === SUM));
    let most = 1;
    let total = 0;
    const lines = [];
    let share = "";

    for (const row of rows) {
        most = Math.max(most, row.value);
        total = total + row.value;
    }
    for (const row of rows) {
        share = "";
        if ((isCount) && (total > 0)) {
            share = `${((100 * row.value) / total).toFixed(1)}%`;
        }
        lines.push(h("div.dist-row", { title: `${row.bucket}: ${formatFigure(row.value)}` },
            h("span.dist-label", {}, row.bucket),
            h("span.dist-bar", {}, h("span", { style: { width: `${(100 * row.value) / most}%` } })),
            h("span.dist-value.number", {}, formatFigure(row.value)),
            h("span.dist-share.muted.small", {}, share)));
    }

    return h("div.dist", {}, h("h5", {}, group.name), h("div.dist-rows", {}, ...lines));
}

/**
 * Draw a listing of stats: each stat with one figure as a row, each stat
 * kept by bucket as a distribution.
 *
 * @param {Array<object>} rows the listing, as the server gives it
 * @returns {HTMLElement} the stats
 */
export function statsView(rows) {
    const parts = [];

    for (const group of groupStats(rows)) {
        if (group.isDistribution) {
            parts.push(distribution(group));
        } else {
            for (const row of group.rows) {
                parts.push(figureRow(row));
            }
        }
    }

    return h("div.stats-view", {}, ...parts);
}
