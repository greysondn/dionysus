// Bots in the pickers that seat them: shown with where they stand on the
// game's leaderboard, best first. The server sends each ranked bot's place
// (bot_ranks, by bot id); a bot with no rating there is simply missing from
// it, and is listed last as unranked. These are pure functions, so they run
// under Node too (tests/client/botrank.test.mjs).

/**
 * The bots in picker order: the ranked ones first, best rank first, then
 * the unranked ones. Bots of the same rank, and the unranked, are in name
 * order.
 *
 * @param {string[]} bots the bot ids
 * @param {object} ranks each ranked bot's {rank, text}, by bot id
 * @returns {string[]} a sorted copy of the ids
 */
export function sortBots(bots, ranks) {
    const known = ranks || {};

    return [...bots].sort((a, b) => {
        let ret = 0;
        const rankA = known[a]?.rank;
        const rankB = known[b]?.rank;

        if ((rankA === undefined) && (rankB === undefined)) {
            ret = a.localeCompare(b);
        } else if (rankA === undefined) {
            ret = 1;
        } else if (rankB === undefined) {
            ret = -1;
        } else if (rankA !== rankB) {
            ret = rankA - rankB;
        } else {
            ret = a.localeCompare(b);
        }

        return ret;
    });
}

/**
 * How a bot reads in a picker: its place and rating when it has one, else
 * that it is unranked.
 *
 * @param {string} bot the bot id
 * @param {object} ranks each ranked bot's {rank, text}, by bot id
 * @param {string} prefix put before the id, such as "bot: "
 * @returns {string} for example "#2 bot: monopoly.banker (306 ± 58)", or
 *     "bot: monopoly.genesis_jeeves (unranked)"
 */
export function botLabel(bot, ranks, prefix = "") {
    const entry = (ranks || {})[bot];
    let ret = "";

    if (entry === undefined) {
        ret = `${prefix}${bot} (unranked)`;
    } else if ((entry.text === undefined) || (entry.text === "")) {
        ret = `#${entry.rank} ${prefix}${bot}`;
    } else {
        ret = `#${entry.rank} ${prefix}${bot} (${entry.text})`;
    }

    return ret;
}
