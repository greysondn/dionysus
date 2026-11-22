// Watching an all-bots tournament: one view that follows the play from table
// to table. A tournament plays one run (one table) after another, so the
// spectator is the table view of the table now playing, with a bar above it
// that says where the tournament is and sets the pace the bots play at.
// When the run changes, the watcher moves to the new table by itself.
//
// The pace is the bots' wait between decisions. It is set when watching
// starts (a tournament runs at full speed otherwise, too fast to follow) and
// set back to full speed when the watcher stops.

import { clear, h } from "./ui.js";

/**
 * How often the watcher asks where the tournament is.
 */
export const POLL_MS = 1000;

/**
 * The pace the watcher starts at, in seconds between decisions.
 */
export const DEFAULT_PACE = 0.5;

/**
 * The paces on offer, in seconds between decisions; 0 is full speed.
 */
export const PACES = [
    { seconds: 0, label: "Full speed" },
    { seconds: 0.25, label: "Quick" },
    { seconds: 0.5, label: "Steady" },
    { seconds: 1, label: "Slow" },
    { seconds: 2, label: "Very slow" },
];

/**
 * What the bar says about where the tournament is.
 *
 * @param {object} state the tournament's state, as the server reports it
 * @returns {string} a line of text
 */
export function progressText(state) {
    let ret = "";

    if (state.status === "running") {
        ret = (
            `Run ${state.runs_done + 1} of ${state.runs_total}` +
            ` \u00b7 match ${Math.min(
                state.current_completed + 1,
                state.current_requested,
            )} of ${state.current_requested}`
        );
    } else if (state.status === "done") {
        ret = `Finished: ${state.runs_done} runs played`;
    } else {
        ret = `The tournament was ${state.status}`;
    }

    return ret;
}

/**
 * Follows one tournament for the admin watching it.
 */
export class TournamentWatcher {
    /**
     * @param {object} app the app, which opens tables and sends requests
     * @param {number} tournamentId the tournament to follow
     */
    constructor(app, tournamentId) {
        this.app = app;
        this.tournamentId = tournamentId;
        this.state = null;
        this.tableId = null;
        this.pace = DEFAULT_PACE;
        this.timer = null;
        this.isOpening = false;
        this.el = h("div.spectate-bar");
    }

    /**
     * Start watching: set the pace, go to the table now playing and keep
     * following.
     */
    async start() {
        this.state = await this.app.net.request(
            "admin.autoplay.watch",
            { tournament_id: this.tournamentId, delay: this.pace },
        );
        this.render();
        await this.follow();
        this.timer = setInterval(() => this.poll(), POLL_MS);
    }

    /**
     * Stop watching: put the pace back to full speed and stop following.
     * The table on screen is left to whatever opens next.
     */
    stop() {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
            this.app.net.request(
                "admin.autoplay.watch",
                { tournament_id: this.tournamentId, delay: 0 },
            ).catch(() => {});
        }
    }

    /**
     * Ask where the tournament is now, and move there if it has moved on.
     */
    async poll() {
        if (!this.isOpening) {
            try {
                this.state = await this.app.net.request(
                    "admin.autoplay.watch",
                    { tournament_id: this.tournamentId },
                );
                this.render();
                await this.follow();
            } catch {
                // The connection may be down; the next poll tries again.
            }
        }
    }

    /**
     * Open the table the tournament is playing at, if it is not the one
     * on screen.
     */
    async follow() {
        const next = this.state.current_table_id;

        if ((next != null) && (next !== this.tableId)) {
            this.isOpening = true;
            try {
                // Leave the table finished with, so the server forgets us.
                if (this.tableId != null) {
                    await this.app.net.request(
                        "tables.leave",
                        { table_id: this.tableId },
                    ).catch(() => {});
                }
                this.tableId = next;
                await this.app.openTable(
                    next,
                    { view: "table", spectator: this },
                );
            } finally {
                this.isOpening = false;
            }
        }
    }

    /**
     * Set the pace, here and at the server.
     *
     * @param {number} seconds the wait between decisions
     */
    async setPace(seconds) {
        this.pace = seconds;
        this.state = await this.app.net.request(
            "admin.autoplay.watch",
            { tournament_id: this.tournamentId, delay: seconds },
        );
        this.render();
    }

    /**
     * Draw the bar again.
     */
    render() {
        const state = this.state;
        const pace = h(
            "select",
            {
                "aria-label": "Pace",
                onchange: (e) => this.setPace(Number(e.target.value)),
            },
            PACES.map((p) => h(
                "option",
                { value: String(p.seconds), selected: (p.seconds === this.pace) },
                p.label,
            )),
        );

        clear(
            this.el,
            h("b", {}, `Watching all bots ${state.tournament_id}`),
            h("span.muted", {}, state.game_id),
            h("span", {}, progressText(state)),
            h("span.muted", {}, (state.current_bots || []).join(" vs ")),
            h("label.field.inline", {}, h("span", {}, "Pace"), pace),
            h("button.ghost.small", {
                type: "button",
                onclick: () => this.app.stopWatching(),
            }, "Stop watching"),
        );
    }
}
