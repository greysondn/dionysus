// The left-hand tool bar of the combined view: the board's generic tools.
// One tool is in hand at a time (Null, Pen, Ping or Pan); Erase, Zoom and
// the user's colour are not tools in hand but things to do. The bar can be
// folded away to a thin tab. The viewer's colour and whether the bar is
// folded are kept in this browser.

import { h } from "./ui.js";

const COLOR_KEY = "dionysus.userColor";
const FOLD_KEY = "dionysus.toolBarFolded";

/**
 * The colour a viewer starts with.
 */
export const DEFAULT_COLOR = "#ffd166";

/**
 * The tools that can be in hand. The Null tool is "hand": the board
 * behaves as it does with no tool, which is how the rest of the client
 * already names it. A tool that marks the board needs a seat at a table
 * with marks.
 */
export const TOOLS = [
    { id: "hand", glyph: "\u2196", label: "Null", title: "No tool: the board behaves as usual", marks: false },
    { id: "pen", glyph: "\u270e", label: "Pen", title: "Draw on the board, in your colour", marks: true },
    { id: "ping", glyph: "\u25ce", label: "Ping", title: "Ping a spot on the board, in your colour", marks: true },
    { id: "pan", glyph: "\u2725", label: "Pan", title: "Drag the board to move what is in view", marks: false },
];

/**
 * Whether a string is a colour as a colour input gives it.
 *
 * @param {string} text the text
 * @returns {boolean} whether it is "#" and six hex digits
 */
export function isColor(text) {
    return ((typeof text === "string") && (/^#[0-9a-fA-F]{6}$/.test(text)));
}

/**
 * Read a kept setting, which storage may refuse.
 *
 * @param {string} key the setting
 * @returns {string|null} what is kept, or null
 */
function kept(key) {
    let ret = null;

    try {
        ret = localStorage.getItem(key);
    } catch {
        // Storage may be blocked: nothing is kept.
    }

    return ret;
}

/**
 * Keep a setting, if storage lets it.
 *
 * @param {string} key the setting
 * @param {string} value what to keep
 */
function keep(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be blocked: it lasts until the page closes.
    }
}

/**
 * The tool bar. It asks the table, through the hooks it is given, what it
 * may offer and tells it what was done.
 *
 * Hooks: canMark() says whether the viewer may mark the board; onTool(id)
 * is told which tool is in hand; onZoom("in", "out" or "reset") zooms the
 * board; onErase(event) opens the erase menu; canPingMe() says whether the
 * game provides "ping me" and onPingMe() pings the viewer's own tokens.
 */
export class ToolBar {
    /**
     * @param {object} hooks what the table gives the bar
     */
    constructor(hooks) {
        this.hooks = hooks;
        this.tool = "hand";
        this.folded = (kept(FOLD_KEY) === "1");
        this.color = kept(COLOR_KEY);
        if (!isColor(this.color)) {
            this.color = DEFAULT_COLOR;
        }
        this.el = h("aside.tool-bar");
        this.render();
    }

    /**
     * Put a tool in hand, and tell the table.
     *
     * @param {string} id the tool
     */
    select(id) {
        this.tool = id;
        this.hooks.onTool(id);
        this.render();
    }

    /**
     * Fold the bar away, or open it again.
     */
    toggleFold() {
        this.folded = (!this.folded);
        keep(FOLD_KEY, this.folded ? "1" : "0");
        this.render();
    }

    /**
     * Draw the bar again: after a tool is picked, or when what the viewer
     * may do has changed. A tool that marks is put down if the viewer can
     * no longer mark.
     */
    render() {
        const canMark = this.hooks.canMark();
        const parts = [];

        // A folded bar is only its tab.
        this.el.classList.toggle("folded", this.folded);
        if (this.folded) {
            this.el.replaceChildren(h("button.ghost.small.fold", {
                type: "button",
                title: "Show the tool bar",
                "aria-label": "Show the tool bar",
                onclick: () => this.toggleFold(),
            }, "\u00bb"));
            return;
        }

        // Put down a tool the viewer may no longer use.
        if ((!canMark) && (TOOLS.find((t) => t.id === this.tool).marks)) {
            this.tool = "hand";
            this.hooks.onTool("hand");
        }

        parts.push(h("button.ghost.small.fold", {
            type: "button",
            title: "Fold the tool bar away",
            "aria-label": "Fold the tool bar away",
            onclick: () => this.toggleFold(),
        }, "\u00ab"));
        for (const tool of TOOLS) {
            if ((canMark) || (!tool.marks)) {
                parts.push(this.toolButton(tool));
            }
            if ((canMark) && (tool.id === "ping")) {
                parts.push(this.pingMeButton());
            }
        }
        if (canMark) {
            parts.push(h("button.ghost.small.tool", {
                type: "button",
                title: "Erase marks on the board",
                onclick: (e) => this.hooks.onErase(e),
            }, "\u232b Erase"));
            parts.push(this.colorPicker());
        }
        parts.push(h("div.tool-group", {},
            h("span.muted.small", {}, "Zoom"),
            this.zoomButton("in", "+", "Zoom the board in"),
            this.zoomButton("out", "\u2212", "Zoom the board out"),
            this.zoomButton("reset", "1:1", "Show the whole board again")));
        this.el.replaceChildren(...parts);
    }

    /**
     * A button that puts a tool in hand, lit while it is.
     *
     * @param {object} tool the tool
     * @returns {HTMLElement} the button
     */
    toolButton(tool) {
        let on = "";

        if (this.tool === tool.id) {
            on = " on";
        }

        return h(`button.ghost.small.tool${on}`, {
            type: "button",
            title: tool.title,
            "aria-pressed": String(this.tool === tool.id),
            onclick: () => this.select(tool.id),
        }, `${tool.glyph} ${tool.label}`);
    }

    /**
     * The "ping me" button, beside the Ping tool. It is an action, not a
     * tool in hand. A game that does not provide it gets the button
     * anyway, disabled, so players can see it exists.
     *
     * @returns {HTMLElement} the button
     */
    pingMeButton() {
        const isProvided = this.hooks.canPingMe();
        let title = "This game has nothing to ping for you";

        if (isProvided) {
            title = "Ping your own pieces on the board, in your colour";
        }

        return h("button.ghost.small.tool.ping-me", {
            type: "button",
            title,
            disabled: (!isProvided),
            onclick: () => this.hooks.onPingMe(),
        }, "◎ Ping me");
    }

    /**
     * A button that zooms the board.
     *
     * @param {string} how in, out or reset
     * @param {string} text what it says
     * @param {string} title what it is for
     * @returns {HTMLElement} the button
     */
    zoomButton(how, text, title) {
        return h("button.ghost.small.tool", {
            type: "button",
            title,
            "aria-label": title,
            onclick: () => this.hooks.onZoom(how),
        }, text);
    }

    /**
     * The viewer's colour, which the pen and the ping use.
     *
     * @returns {HTMLElement} the picker
     */
    colorPicker() {
        const input = h("input", {
            type: "color",
            value: this.color,
            "aria-label": "Your colour",
        });

        input.addEventListener("input", () => {
            if (isColor(input.value)) {
                this.color = input.value;
                keep(COLOR_KEY, this.color);
            }
        });

        return h("label.tool-group", { title: "Your colour, for the pen and the ping" },
            h("span.muted.small", {}, "Colour"), input);
    }
}
