// The trade panel: a two-column list drawn over the middle of the board, one
// column for each player, in which what one player gives the other is
// proposed by moving it across. A game asks for it by putting an "x-trade"
// block in the schema of the control that offers or counters a trade (what
// everyone owns and what to start from), and by keeping the trade on the
// table, in a form the panel can draw, at mechanics/<id>/trade_view.

import { clear, h } from "./ui.js";

/** The mechanic that keeps the trade on the table. */
const MECHANIC = "monopoly.rules";

/** How much of the board's width the panel covers. */
const PANEL_FRACTION = 0.64;

/** How many font-size units the panel is wide, so everything scales. */
const PANEL_UNITS = 28;

/** What a click on an empty cash line offers, before it is changed. */
const STARTING_CASH = 50;

const ACTION_OFFER = "monopoly.offer";
const ACTION_COUNTER = "monopoly.counter";
const ACTION_ACCEPT = "monopoly.accept";
const ACTION_REJECT = "monopoly.reject";
const ACTION_WITHDRAW = "monopoly.withdraw";

const RAILROAD = "<svg viewBox='0 0 10 10'><rect x='0' y='3' width='10' height='4' fill='currentColor'/><circle cx='2.5' cy='8.5' r='1.4' fill='currentColor'/><circle cx='7.5' cy='8.5' r='1.4' fill='currentColor'/><rect x='6' y='0' width='3' height='3' fill='currentColor'/></svg>";
const UTILITY = "<svg viewBox='0 0 10 10'><path d='M5 0 L8 5 L6 5 L7 10 L2 4 L4.5 4 Z' fill='currentColor'/></svg>";
const JAIL_BARS = "<svg viewBox='0 0 10 10'><path d='M1 0v10M4 0v10M7 0v10M10 0v10' stroke='currentColor' stroke-width='1.5'/></svg>";

/**
 * A pip for a property: its color group's color, or a symbol for a
 * railroad or a utility.
 *
 * @param {object} item the item, as the game describes it
 * @returns {HTMLElement} the pip
 */
function pipFor(item) {
    const ret = h("span.pip");

    if (item.color) {
        ret.style.background = item.color;
    }
    if (item.kind === "railroad") {
        ret.innerHTML = RAILROAD;
    } else if (item.kind === "utility") {
        ret.innerHTML = UTILITY;
    } else if (item.kind === "card") {
        ret.innerHTML = JAIL_BARS;
    } else if (item.kind === "cash") {
        ret.classList.add("cash");
    }

    return ret;
}

/**
 * An amount of money as the game writes it.
 *
 * @param {Array<string>} currency the text before and after the amount
 * @param {number} amount the amount
 * @returns {string} the text, such as "$200"
 */
function money(currency, amount) {
    return `${currency[0]}${amount}${currency[1]}`;
}

/**
 * The trade panel.
 */
export class TradePanel {
    /**
     * @param {object} table the table view the panel is drawn on
     */
    constructor(table) {
        this.table = table;
        this.el = h("div.trade-panel", { hidden: true });
        this.mode = "";
        this.control = null;
        this.plan = null;
        this.partner = 0;
        this.offer = null;
        this.dismissed = "";
        this.dragging = null;
        this.observer = null;
    }

    /**
     * Keep the panel in step with the table: put it over the board
     * while a trade is being made or is waiting for this viewer, and take
     * it away when neither is so.
     */
    sync() {
        const view = this.standing();
        const key = JSON.stringify(view);

        if (this.mode === "edit") {
            if (!this.hasControl(this.control.action_type)) {
                this.close();
            }
        } else if (
            (view !== null) &&
            (this.involves(view)) &&
            (key !== this.dismissed)
        ) {
            this.mode = "view";
            this.view = view;
        } else {
            this.mode = "";
        }
        this.draw();
    }

    /**
     * Start composing a trade from a control that asks for one.
     *
     * @param {object} control the offer or counter control
     */
    edit(control) {
        const plan = control.params_schema["x-trade"];
        const start = plan.start || {};

        this.mode = "edit";
        this.control = control;
        this.plan = plan;
        this.partner = plan.fixed;
        if (this.partner === 0) {
            this.partner = this.partnerNamed(start.partner) || plan.partners[0];
        }
        this.offer = {
            me:   this.offerFrom(start, "give"),
            them: this.offerFrom(start, "get"),
        };
        this.draw();
    }

    /** Put the panel away, keeping a standing trade dismissed until it changes. */
    close() {
        if (this.mode === "view") {
            this.dismissed = JSON.stringify(this.view);
        }
        this.mode = "";
        this.draw();
    }

    /**
     * What the table says is on offer, as the game keeps it.
     *
     * @returns {object|null} the trade, or null when none is
     */
    standing() {
        const view = this.table.state?.mechanics?.[MECHANIC]?.trade_view;
        let ret = null;

        if ((view != null) && (Object.keys(view).length > 0)) {
            ret = view;
        }

        return ret;
    }

    /**
     * Whether the viewer is one of the two in a trade.
     *
     * @param {object} view the trade
     * @returns {boolean} whether they are
     */
    involves(view) {
        const seat = this.table.seat;

        return ((seat === view.from) || (seat === view.to));
    }

    /**
     * Whether the table has a control of a kind.
     *
     * @param {string} type the action type
     * @returns {boolean} whether there is one
     */
    hasControl(type) {
        return this.controlOf(type) !== null;
    }

    /**
     * The table's control of a kind.
     *
     * @param {string} type the action type
     * @returns {object|null} the control, or null
     */
    controlOf(type) {
        let ret = null;

        for (const control of this.table.controls) {
            if (control.action_type === type) {
                ret = control;
            }
        }

        return ret;
    }

    /**
     * The seat that goes by a name.
     *
     * @param {string} name the player's name
     * @returns {number} the seat, or 0
     */
    partnerNamed(name) {
        let ret = 0;

        for (const seat of this.plan.partners) {
            if (this.plan.players[String(seat)].name === name) {
                ret = seat;
            }
        }

        return ret;
    }

    /**
     * What one side starts out giving.
     *
     * @param {object} start the form's starting values
     * @param {string} way "give" or "get"
     * @returns {object} {names, cash, cards}
     */
    offerFrom(start, way) {
        return {
            names: new Set(start[way] || []),
            cash:  start[`${way}_cash`] || 0,
            cards: start[`${way}_cards`] || 0,
        };
    }

    /** Put the panel over the middle of the board, sized to it. */
    place() {
        const sceneView = this.table.sceneView;
        const matrix = sceneView.svg.getScreenCTM();
        const scene = sceneView.scene;
        let centre = null;
        let wrap = null;
        let size = 0;

        if ((matrix != null) && (scene != null)) {
            wrap = sceneView.el.getBoundingClientRect();
            centre = new DOMPoint(scene.width / 2, scene.height / 2)
                .matrixTransform(matrix);
            size = scene.width * PANEL_FRACTION * matrix.a;
            this.el.style.width = `${size}px`;
            this.el.style.height = `${size}px`;
            this.el.style.left = `${centre.x - wrap.left - size / 2}px`;
            this.el.style.top = `${centre.y - wrap.top - size / 2}px`;
            this.el.style.fontSize = `${size / PANEL_UNITS}px`;
        }
    }

    /** Draw whatever the panel should show now. */
    draw() {
        const sceneView = this.table.sceneView;

        if (this.mode === "") {
            this.el.hidden = true;
        } else {
            if (this.el.parentNode !== sceneView.el) {
                sceneView.el.append(this.el);
                this.observer = new ResizeObserver(() => this.place());
                this.observer.observe(sceneView.el);
            }
            this.el.hidden = false;
            this.place();
            if (this.mode === "edit") {
                this.drawEditor();
            } else {
                this.drawView();
            }
        }
    }

    // ------------------------------------------------------------ editor

    /** Draw the panel for composing a trade. */
    drawEditor() {
        const mine = this.plan.players[String(this.plan.me)];
        const theirs = this.plan.players[String(this.partner)];
        const status = this.editorStatus();

        clear(
            this.el,
            this.heads(mine, theirs, true),
            h(
                "div.cols",
                {},
                this.column("me", mine, theirs),
                this.column("them", theirs, mine),
            ),
            this.summary(this.editorLines(mine, theirs)),
            this.bar(this.editorButtons(status), status.text),
        );
    }

    /**
     * Whether the trade can be proposed yet, and what to tell the viewer.
     *
     * @returns {object} {ok, text}
     */
    editorStatus() {
        let ret = { ok: true, text: "" };
        const stuff = this.offer.me.names.size + this.offer.them.names.size +
            this.offer.me.cards + this.offer.them.cards;

        if (stuff === 0) {
            ret = { ok: false, text: "Add a property or a jail card" };
        }

        return ret;
    }

    /**
     * The heads of the columns: seat, name and, for the other player,
     * arrows to choose among the players there are.
     *
     * @param {object} left the left player
     * @param {object} right the right player
     * @param {boolean} choosing whether the right one can be changed
     * @returns {HTMLElement} the heads
     */
    heads(left, right, choosing) {
        const rightHead = this.head(right);
        const many = ((choosing) && (this.plan.fixed === 0) && (this.plan.partners.length > 1));

        if (many) {
            rightHead.prepend(h("button.arrow", { type: "button", "aria-label": "Previous player", onclick: () => this.cycle(-1) }, "◀"));
            rightHead.append(h("button.arrow", { type: "button", "aria-label": "Next player", onclick: () => this.cycle(1) }, "▶"));
        }

        return h(
            "div.heads",
            {},
            this.head(left),
            rightHead,
            h("button.close", { type: "button", "aria-label": "Close", onclick: () => this.close() }, "✕"),
        );
    }

    /**
     * One player's head.
     *
     * @param {object} player the player, as the game describes them
     * @param {string} tag a small word after the name
     * @returns {HTMLElement} the head
     */
    head(player) {
        let tag = "";

        if (player.seat === this.table.seat) {
            tag = "you";
        }

        return h(
            "div.head",
            {},
            h("span.name", {}, this.label(player)),
            h("span.tag", {}, tag),
        );
    }

    /**
     * A player as the panel names them: their seat's color, then whoever
     * is sitting there in parentheses, as "Brown (Foo)".
     *
     * @param {object} player the player, as the game describes them
     * @returns {string} the name
     */
    label(player) {
        return this.table.seatName(player.seat, player.name);
    }

    /**
     * Move on to another player to trade with.
     *
     * @param {number} step 1 for the next, -1 for the one before
     */
    cycle(step) {
        const seats = this.plan.partners;
        const at = seats.indexOf(this.partner);

        this.partner = seats[(at + step + seats.length) % seats.length];
        this.offer.them = { names: new Set(), cash: 0, cards: 0 };
        this.drawEditor();
    }

    /**
     * One player's column: cash first, then what they own in board order,
     * then jail cards, and, below, what the other player offers them.
     *
     * @param {string} side "me" or "them"
     * @param {object} owner the player the column lists
     * @param {object} other the other player
     * @returns {HTMLElement} the column
     */
    column(side, owner, other) {
        const col = h("div.col", { dataset: { side } });
        const otherSide = this.otherSide(side);
        const offered = this.offer[side];
        const received = this.offer[otherSide];
        let seen = false;

        col.append(this.cashRow(side, owner));
        for (const item of owner.items) {
            col.append(this.itemRow(side, item, offered.names.has(item.name)));
        }
        if (owner.cards > 0) {
            col.append(h("div.sep"));
        }
        for (let n = 0; n < owner.cards; n++) {
            col.append(this.cardRow(side, n, n < offered.cards));
        }

        // What the other player gives this one, marked as coming in.
        for (const item of other.items) {
            if (received.names.has(item.name)) {
                if (!seen) {
                    col.append(h("div.sep.incoming", {}, "Incoming"));
                    seen = true;
                }
                col.append(h("div.row.received", {}, pipFor(item), h("span.label", {}, item.name), h("span.value", {}, money(this.plan.currency, item.value))));
            }
        }
        this.wireDrop(col, side);

        return col;
    }

    /**
     * The other side.
     *
     * @param {string} side "me" or "them"
     * @returns {string} the other one
     */
    otherSide(side) {
        let ret = "me";

        if (side === "me") {
            ret = "them";
        }

        return ret;
    }

    /**
     * A property's line.
     *
     * @param {string} side whose column it is in
     * @param {object} item the property
     * @param {boolean} isOffered whether it is being offered
     * @returns {HTMLElement} the line
     */
    itemRow(side, item, isOffered) {
        let label = item.name;
        const row = h("div.row", { draggable: !item.locked });

        if (item.mortgaged) {
            label = `${label} (mortgaged)`;
        }
        row.append(pipFor(item), h("span.label", {}, label), h("span.value", {}, money(this.plan.currency, item.value)));
        if (item.locked) {
            row.classList.add("locked");
            row.title = "A building in its group keeps it out of a trade";
        } else {
            row.addEventListener("click", () => this.toggleName(side, item.name));
            this.wireDrag(row, side, item.name);
        }
        if (isOffered) {
            row.classList.add("offered");
        }

        return row;
    }

    /**
     * A jail card's line.
     *
     * @param {string} side whose column it is in
     * @param {number} n which of their cards
     * @param {boolean} isOffered whether it is being offered
     * @returns {HTMLElement} the line
     */
    cardRow(side, n, isOffered) {
        const row = h("div.row", { draggable: true }, pipFor({ kind: "card" }), h("span.label", {}, "Get Out of Jail Free"), h("span.value", {}, ""));

        row.addEventListener("click", () => this.toggleCard(side, n));
        this.wireDrag(row, side, `card:${n}`);
        if (isOffered) {
            row.classList.add("offered");
        }

        return row;
    }

    /**
     * A player's cash line: their cash, and, once some is offered, the
     * amount, which can be typed over.
     *
     * @param {string} side whose column it is in
     * @param {object} owner the player
     * @returns {HTMLElement} the line
     */
    cashRow(side, owner) {
        const amount = this.offer[side].cash;
        const row = h("div.row.cashrow", { draggable: true }, pipFor({ kind: "cash" }));
        let input = null;

        if (amount > 0) {
            input = h("input", { type: "number", min: 0, max: owner.cash, step: 10, value: String(amount), "aria-label": "Cash to give" });
            input.addEventListener("click", (e) => e.stopPropagation());
            input.addEventListener("change", () => this.setCash(side, Number(input.value)));
            row.classList.add("offered-cash");
            row.append(h("span.label", {}, "Cash to give"), input);
        } else {
            row.append(h("span.label", {}, "Cash"), h("span.value", {}, money(this.plan.currency, owner.cash)));
        }
        row.addEventListener("click", () => this.toggleCash(side, owner));
        this.wireDrag(row, side, "cash");

        return row;
    }

    /**
     * Let a line be dragged to the other column.
     *
     * @param {HTMLElement} row the line
     * @param {string} side whose column it is in
     * @param {string} key what it is: a property's name, "cash" or "card:N"
     */
    wireDrag(row, side, key) {
        row.addEventListener("dragstart", (e) => {
            this.dragging = { side, key };
            e.dataTransfer.setData("text/plain", `${side}:${key}`);
        });
    }

    /**
     * Let a column take what is dragged from the other.
     *
     * @param {HTMLElement} col the column
     * @param {string} side whose column it is
     */
    wireDrop(col, side) {
        col.addEventListener("dragover", (e) => {
            if ((this.dragging !== null) && (this.dragging.side !== side)) {
                e.preventDefault();
                col.classList.add("drop");
            }
        });
        col.addEventListener("dragleave", () => col.classList.remove("drop"));
        col.addEventListener("drop", (e) => {
            e.preventDefault();
            col.classList.remove("drop");
            this.dropped(side);
        });
    }

    /**
     * Something was dropped on a column: offer it, if it came from the
     * other one and is not offered already.
     *
     * @param {string} side the column
     */
    dropped(side) {
        const drag = this.dragging;

        this.dragging = null;
        if ((drag !== null) && (drag.side !== side)) {
            this.offerKey(drag.side, drag.key);
        }
    }

    /**
     * Offer something that is not offered yet.
     *
     * @param {string} side whose it is
     * @param {string} key a property's name, "cash" or "card:N"
     */
    offerKey(side, key) {
        const owner = this.plan.players[String(this.seatOf(side))];

        if (key === "cash") {
            if (this.offer[side].cash === 0) {
                this.toggleCash(side, owner);
            }
        } else if (key.startsWith("card:")) {
            this.offer[side].cards = Math.max(this.offer[side].cards, Number(key.slice(5)) + 1);
            this.drawEditor();
        } else {
            this.offer[side].names.add(key);
            this.drawEditor();
        }
    }

    /**
     * The seat a side stands for.
     *
     * @param {string} side "me" or "them"
     * @returns {number} the seat
     */
    seatOf(side) {
        let ret = this.partner;

        if (side === "me") {
            ret = this.plan.me;
        }

        return ret;
    }

    /**
     * Offer a property, or take the offer back.
     *
     * @param {string} side whose it is
     * @param {string} name the property
     */
    toggleName(side, name) {
        const names = this.offer[side].names;

        if (names.has(name)) {
            names.delete(name);
        } else {
            names.add(name);
        }
        this.drawEditor();
    }

    /**
     * Offer a jail card, or take the offer back.
     *
     * @param {string} side whose it is
     * @param {number} n which of their cards
     */
    toggleCard(side, n) {
        const offer = this.offer[side];

        if (n < offer.cards) {
            offer.cards = n;
        } else {
            offer.cards = n + 1;
        }
        this.drawEditor();
    }

    /**
     * Offer some cash, or take the offer back.
     *
     * @param {string} side whose it is
     * @param {object} owner the player
     */
    toggleCash(side, owner) {
        const offer = this.offer[side];

        if (offer.cash > 0) {
            offer.cash = 0;
        } else {
            offer.cash = Math.min(STARTING_CASH, owner.cash);
        }
        this.drawEditor();
    }

    /**
     * Change the cash offered, within what the player has.
     *
     * @param {string} side whose it is
     * @param {number} amount the amount typed
     */
    setCash(side, amount) {
        const owner = this.plan.players[String(this.seatOf(side))];
        let value = Math.floor(amount);

        if (Number.isNaN(value)) {
            value = 0;
        }
        this.offer[side].cash = Math.max(0, Math.min(value, owner.cash));
        this.drawEditor();
    }

    /**
     * The summary's lines for the trade being composed.
     *
     * @param {object} mine the viewer
     * @param {object} theirs their partner
     * @returns {Array<Array<string>>} each line's giver, taker and what
     */
    editorLines(mine, theirs) {
        return [
            ...this.linesFor(this.label(mine), this.label(theirs), this.offer.me),
            ...this.linesFor(this.label(theirs), this.label(mine), this.offer.them),
        ];
    }

    /**
     * The lines for what one side gives.
     *
     * @param {string} giver who gives
     * @param {string} taker who gets
     * @param {object} offer {names, cash, cards}
     * @returns {Array<Array<string>>} the lines
     */
    linesFor(giver, taker, offer) {
        const ret = [];

        for (const name of offer.names) {
            ret.push([giver, taker, name]);
        }
        if (offer.cash > 0) {
            ret.push([giver, taker, money(this.plan.currency, offer.cash)]);
        }
        for (let n = 0; n < offer.cards; n++) {
            ret.push([giver, taker, "a Get Out of Jail Free card"]);
        }

        return ret;
    }

    /**
     * The buttons at the foot of the editor: Propose for a new offer or
     * Modify for a counter-offer.
     *
     * @param {object} status whether the trade can be sent
     * @returns {Array<object>} each button's {label, ok, run}
     */
    editorButtons(status) {
        let label = "Propose";

        if (this.control.action_type === ACTION_COUNTER) {
            label = "Modify";
        }

        return [{ label, ok: status.ok, run: () => this.send() }];
    }

    /** Send the trade as composed, and put the panel away. */
    send() {
        const params = {
            give_cash:  this.offer.me.cash,
            get_cash:   this.offer.them.cash,
            give_cards: this.offer.me.cards,
            get_cards:  this.offer.them.cards,
        };

        if (this.control.action_type === ACTION_OFFER) {
            params.partner = this.plan.players[String(this.partner)].name;
        }
        if (this.offer.me.names.size > 0) {
            params.give = Array.from(this.offer.me.names);
        }
        if (this.offer.them.names.size > 0) {
            params.get = Array.from(this.offer.them.names);
        }
        this.table.act(this.control.action_type, params);
        this.close();
    }

    // ------------------------------------------------------------ viewer

    /** Draw the panel for a trade waiting on the table. */
    drawView() {
        const view = this.view;
        const left = { seat: view.from, name: view.names[String(view.from)] };
        const right = { seat: view.to, name: view.names[String(view.to)] };
        let lines = [];

        this.plan = this.planFor(view);
        lines = this.viewLines(view, left, right);
        clear(
            this.el,
            this.heads(left, right, false),
            h(
                "div.cols",
                {},
                this.viewColumn(left, view.give, view.give_cash, view.give_cards),
                this.viewColumn(right, view.get, view.get_cash, view.get_cards),
            ),
            this.summary(lines),
            this.bar(this.viewButtons(view), this.viewStatus(view)),
        );
    }

    /**
     * What a plan needs, for a panel that only shows a trade.
     *
     * @param {object} view the trade
     * @returns {object} a plan with the trade's currency
     */
    planFor(view) {
        return { currency: view.currency, me: this.table.seat, players: {}, partners: [], fixed: 0 };
    }

    /**
     * One player's side of a trade on the table: what they give.
     *
     * @param {object} player the player
     * @param {Array<object>} items the properties
     * @param {number} cash the cash
     * @param {number} cards the jail cards
     * @returns {HTMLElement} the column
     */
    viewColumn(player, items, cash, cards) {
        const col = h("div.col.view", {});

        if (cash > 0) {
            col.append(h("div.row", {}, pipFor({ kind: "cash" }), h("span.label", {}, "Cash"), h("span.value", {}, money(this.plan.currency, cash))));
        }
        for (const item of items) {
            col.append(h("div.row", {}, pipFor(item), h("span.label", {}, item.name), h("span.value", {}, money(this.plan.currency, item.value))));
        }
        for (let n = 0; n < cards; n++) {
            col.append(h("div.row", {}, pipFor({ kind: "card" }), h("span.label", {}, "Get Out of Jail Free"), h("span.value", {}, "")));
        }
        if (col.children.length === 0) {
            col.append(h("div.row.nothing", {}, `${this.label(player)} gives nothing`));
        }

        return col;
    }

    /**
     * The summary's lines for a trade on the table.
     *
     * @param {object} view the trade
     * @param {object} left the player who offered it
     * @param {object} right the player offered it
     * @returns {Array<Array<string>>} the lines
     */
    viewLines(view, left, right) {
        const give = {
            names: new Set(view.give.map((item) => item.name)),
            cash:  view.give_cash,
            cards: view.give_cards,
        };
        const get = {
            names: new Set(view.get.map((item) => item.name)),
            cash:  view.get_cash,
            cards: view.get_cards,
        };

        return [
            ...this.linesFor(this.label(left), this.label(right), give),
            ...this.linesFor(this.label(right), this.label(left), get),
        ];
    }

    /**
     * What the foot of the panel says about a waiting trade.
     *
     * @param {object} view the trade
     * @returns {string} the text
     */
    viewStatus(view) {
        const seat = this.table.seat;
        const from = this.label({ seat: view.from, name: view.names[String(view.from)] });
        const to = this.label({ seat: view.to, name: view.names[String(view.to)] });
        let ret = `${from} proposes this trade`;

        if (seat === view.from) {
            ret = `Waiting for ${to}`;
        }

        return ret;
    }

    /**
     * The buttons for a waiting trade: Accept, Modify and Reject for the
     * player offered it, Withdraw for the one who offered.
     *
     * @param {object} view the trade
     * @returns {Array<object>} each button's {label, ok, run}
     */
    viewButtons(view) {
        const seat = this.table.seat;
        let ret = [];

        if (seat === view.to) {
            ret = [
                this.controlButton("Accept", ACTION_ACCEPT),
                this.controlButton("Modify", ACTION_COUNTER),
                this.controlButton("Reject", ACTION_REJECT),
            ];
        } else if (seat === view.from) {
            ret = [this.controlButton("Withdraw", ACTION_WITHDRAW)];
        }

        return ret;
    }

    /**
     * A button that presses one of the table's controls.
     *
     * @param {string} label the button's text
     * @param {string} type the control's action type
     * @returns {object} {label, ok, run}
     */
    controlButton(label, type) {
        const control = this.controlOf(type);

        return {
            label,
            ok:  (control !== null),
            run: () => this.table.pressControl(control),
        };
    }

    // ------------------------------------------------------------ shared

    /**
     * The summary of the trade, one item to a line.
     *
     * @param {Array<Array<string>>} lines each line's giver, taker and what
     * @returns {HTMLElement} the summary
     */
    summary(lines) {
        const title = h("div.title", {}, h("span", {}, "Trade summary"), h("span", {}, `${lines.length} item${lines.length === 1 ? "" : "s"}`));
        const list = h("div.lines");
        const box = h("div.summary", {}, title, list);

        if (lines.length === 0) {
            list.append(h("div.none", {}, "Select something to give, or something to ask for."));
        }
        for (const [giver, taker, what] of lines) {
            list.append(h("div.line", {}, h("b", {}, giver), " gives ", h("b", {}, taker), ` ${what}`));
        }

        return box;
    }

    /**
     * The foot of the panel: a word on where things stand, and the buttons
     * that apply.
     *
     * @param {Array<object>} buttons each button's {label, ok, run}
     * @param {string} text what to say
     * @returns {HTMLElement} the bar
     */
    bar(buttons, text) {
        const bar = h("div.actions", {}, h("span.status", {}, text));

        for (const button of buttons) {
            bar.append(h("button", { type: "button", disabled: !button.ok, onclick: button.run }, button.label));
        }

        return bar;
    }
}
