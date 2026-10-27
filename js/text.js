// Text is never sent finished: events, controls and announcements carry text keys with parameters, and this
// resolves them. Fallback order (spec 23.6): the flavor in the viewer's language, the flavor in its base language,
// vanilla in the viewer's language, vanilla in its base language; then the client shell's own strings.

export class Text {
  constructor() {
    this.core = {};
    this.layers = [];          // [{name, strings}] highest priority first
    this.seatName = (n) => `Seat ${n}`;
  }

  async loadCore(locale = "en") {
    const res = await fetch(new URL(`../strings/${locale}.json`, import.meta.url)).catch(() => null);
    this.core = res && res.ok ? await res.json() : {};
    if (locale !== "en" && !Object.keys(this.core).length) return this.loadCore("en");
  }

  setLayers(layers) {
    this.layers = layers.filter((l) => l && l.strings);
  }

  has(key) {
    return this.layers.some((l) => key in l.strings) || key in this.core;
  }

  raw(key) {
    for (const l of this.layers) if (key in l.strings) return l.strings[key];
    return this.core[key];
  }

  t(key, params = {}) {
    if (key && typeof key === "object") return this.t(key.key, key.params || {});
    const template = this.raw(key);
    if (template == null) return humanize(key, params);
    return template.replace(/\{(\w+)\}/g, (_, name) => this.param(name, params[name]));
  }

  param(name, value) {
    if (value == null) return "";
    if (typeof value === "object" && value.key) return this.t(value);
    return String(value);
  }
}

// A key with no string still reads as something: "tabletop.action.draw" -> "Draw (pile: deck)"
function humanize(key, params) {
  const last = String(key || "?").split(".").pop().replace(/[_-]+/g, " ");
  const words = last.charAt(0).toUpperCase() + last.slice(1);
  const shown = Object.entries(params || {}).filter(([, v]) => v != null && typeof v !== "object");
  return shown.length ? `${words} (${shown.map(([k, v]) => `${k}: ${v}`).join(", ")})` : words;
}
