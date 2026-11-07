// The viewer's own choices at a table, in one place (spec 23.7: never logged, never shared): the display (table_view),
// peek at vanilla, the per-game choices (a theme; later views add their keys here), and slot bindings. The table
// reads them from here and listens for one "change"; saving goes through preferences.set and slots.bind.

export class ViewerPreferences extends EventTarget {
  constructor(net, tableId) {
    super();
    this.net = net;
    this.tableId = tableId;
    this.display = {};                       // table_view: hide outside the safe zone, tabletop, projection
    this.peek = false;                       // peek at vanilla
    this.game = {};                          // this game's choices, the table's over the game's: { theme }
    this.bindings = { every: {}, table: {} };
  }

  async load(display) {
    if (display) this.display = display;
    const r = await this.net.request("preferences.get", { table_id: this.tableId }).catch(() => null);
    if (r) this.take(r);
    return this;
  }

  take(r) {
    if (r.table_view) this.display = r.table_view;
    this.peek = !!r.peek_vanilla;
    this.game = r.game || {};
    this.bindings = r.bindings || { every: {}, table: {} };
  }

  changed(what) {
    this.dispatchEvent(new CustomEvent("change", { detail: { what } }));
  }

  saveDisplay() {
    return this.net.request("preferences.set", { table_view: { ...this.display } });
  }

  async setPeek(on) {
    this.peek = !!on;
    this.changed("peek");
    await this.net.request("preferences.set", { table_id: this.tableId, peek_vanilla: this.peek });
  }

  /** A per-game choice, for this table or every table of the game; null removes it. */
  async setGame(key, value, scope = "table") {
    this.take(await this.net.request("preferences.set", { table_id: this.tableId, game: { [key]: value }, for: scope }));
    this.changed(key);
  }

  /** Bind a slot (or clear it, with a null reference), for every table or this one only. */
  async bind(slot, reference, here = false) {
    const r = await this.net.request("slots.bind", { table_id: here ? this.tableId : null, slot, asset_reference: reference || null });
    this.bindings = { every: r.bindings || {}, table: here ? r.table_bindings || {} : this.bindings.table };
    if (!here) {                               // a binding for every table: refetch this table's own, which it keeps
      const p = await this.net.request("preferences.get", { table_id: this.tableId }).catch(() => null);
      if (p) this.bindings = p.bindings;
    }
    this.changed("bindings");
  }
}
