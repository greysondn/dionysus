// The colour theme: follow the device (auto, the default), or stay light or
// dark whatever the device says. The choice is kept in this browser. The
// stylesheet reads it from data-theme on the page: no attribute means auto.

import { h } from "./ui.js";

const KEY = "dionysus.theme";
const MODES = ["auto", "light", "dark"];
const LABELS = { auto: "Auto", light: "Light", dark: "Dark" };

/**
 * The saved mode.
 *
 * @returns {string} auto, light or dark; auto when nothing valid is saved
 */
export function savedTheme() {
    let ret = "auto";

    try {
        const saved = localStorage.getItem(KEY);
        if (MODES.includes(saved)) {
            ret = saved;
        }
    } catch {
        // Storage may be blocked: stay on auto.
    }

    return ret;
}

/**
 * Show a mode on the page, and keep it.
 *
 * @param {string} mode auto, light or dark
 */
export function applyTheme(mode) {
    const root = document.documentElement;

    if (mode === "auto") {
        root.removeAttribute("data-theme");
    } else {
        root.setAttribute("data-theme", mode);
    }
    try {
        localStorage.setItem(KEY, mode);
    } catch {
        // Storage may be blocked: the choice lasts until the page closes.
    }
}

/**
 * The mode after another: auto, light, dark, then auto again.
 *
 * @param {string} mode the current mode
 * @returns {string} the next
 */
export function nextTheme(mode) {
    return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

/**
 * A button that steps through the modes and says which is on.
 *
 * @returns {HTMLElement} the button
 */
export function themeButton() {
    const button = h("button.ghost.small.theme", { type: "button" });
    const show = () => {
        button.textContent = `Theme: ${LABELS[savedTheme()]}`;
    };

    button.addEventListener("click", () => {
        applyTheme(nextTheme(savedTheme()));
        show();
    });
    show();

    return button;
}

applyTheme(savedTheme());
