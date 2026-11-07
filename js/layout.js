// The generic renderer for a game's look: layouts (positioned nodes in px), templates (a layout plus property
// values), and assets (files in the game's pool, or uploaded to a table or player pool). Everything is data.
// HTML fragment nodes are drawn unsanitized, as the spec allows; values still enter through {{key}} bindings,
// which are escaped as text. Slots resolve through the viewer's look (spec 23.5, slots.js); whatever a slot draws is
// fitted into its vanilla's box, so a theme never moves anything.
import { s } from "./ui.js";
import { resolveSlot } from "./slots.js";

export function referenceString(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  if (a.pool_kind) return `${a.pool_kind}:${a.pool_id}/${a.asset_key}`;
  return null;
}

// A game over its parts, as the loader extends them (plugins._extend): an object merges key by key, a list of entries
// merges by entry id (an entry with the same id is extended in turn, a new one is added), anything else replaces.
const ENTRY_IDS = ["key", "node_id", "place_id", "flow_id", "window_id", "token_id", "pile_id", "scene_key", "cue_id",
  "challenge_id", "behavior_id", "template_id", "pool_id", "asset_key", "scope", "locale"];
const PART_LISTS = ["scenes", "places", "tokens", "rollables", "piles"];
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
function entryId(e) {
  if (!plain(e)) return null;
  const k = ENTRY_IDS.find((name) => name in e);
  return k ? `${k}=${e[k]}` : null;
}
export function extend(base, over) {
  if (plain(base) && plain(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? extend(base[k], v) : v;
    return out;
  }
  if (Array.isArray(base) && Array.isArray(over) && [...base, ...over].every(entryId)) {
    const out = [...base];
    for (const e of over) {
      const at = out.findIndex((b) => entryId(b) === entryId(e));
      if (at < 0) out.push(e);
      else out[at] = extend(out[at], e);
    }
    return out;
  }
  return over;
}

const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class GameLook {
  constructor(cache, text) {
    this.cache = cache;
    this.text = text;
    this.declaration = {};
    this.files = new Map();       // "plugin_id/path" -> {hash, mime}
    this.templates = new Map();   // template_id -> {declaration, layout}
    this.assets = new Map();      // reference -> {hash, mime, width, height}
    this.tokens = new Map();
    this.onUpdate = () => {};
    this.remote = new Map();      // reference -> Promise<{hash, mime}> for uploaded assets
    this.resolveRemote = async () => null;
    this.slots = new Map();       // slot key -> the assembled game's slot
    this.view = {};               // the viewer's look: { theme, bindings: {every, table}, peek, settings }
    this.flavor = null;           // the table's flavor, as the server sent it, and its strings
    this.flavorStrings = {};
  }

  async load(manifest) {
    this.files.clear();             // loaded again when the table's expansions change: start from nothing
    this.templates.clear();
    this.assets.clear();
    this.tokens.clear();
    for (const f of manifest.files) this.files.set(f.path, f);
    this.declaration = await this.cache.json(manifest.entry);
    const plugin = [...this.files.keys()].find((p) => p.endsWith("/game.json"))?.split("/game.json")[0];
    this.plugin = plugin;
    // the parts the game is made of (spec section 3), in the order they apply: their pools are server pools, and
    // their places, tokens and piles lie under the game's own (a server from before parts sends only boards)
    const parts = manifest.parts || (manifest.boards || []).map((b) => ({ part_id: b.board_id, kind: "board", entry: b.entry }));
    const merged = {};
    for (const p of parts) {
      const part = await this.cache.json(p.entry).catch(() => null);
      if (!part) continue;
      await this.addPool(part.pool || {}, p.part_id, "server", p.part_id);
      for (const name of PART_LISTS) if (part[name]) merged[name] = extend(merged[name] || [], part[name]);
    }
    const own = { ...this.declaration };
    for (const name of PART_LISTS) if (merged[name]) own[name] = extend(merged[name], this.declaration[name] || []);
    this.declaration = own;
    await this.addPool(this.declaration.pool || {}, plugin, "game", this.declaration.game_id);     // its templates win over its parts'
    // the expansions the table chose (spec section 5.3), in the order they apply: the parts each brings, then its
    // declarations, extend the game; its pool is a server pool of its own id, and its strings join the game's
    const added = [];
    for (const x of manifest.expansions || []) {
      const exp = await this.cache.json(x.entry).catch(() => null);
      if (!exp) continue;
      for (const p of x.parts || []) {
        const part = await this.cache.json(p.entry).catch(() => null);
        if (!part) continue;
        await this.addPool(part.pool || {}, p.part_id, "server", p.part_id);
        for (const name of PART_LISTS) if (part[name]) this.declaration[name] = extend(this.declaration[name] || [], part[name]);
      }
      await this.addPool(exp.pool || {}, x.expansion_id, "server", x.expansion_id);
      this.declaration = extend(this.declaration, exp.declarations || {});
      added.push([x.expansion_id, exp]);
    }
    for (const t of [...(this.declaration.tokens || []), ...(this.declaration.rollables || [])]) this.tokens.set(t.token_id, t);
    const strings = {};
    const locale = (navigator.language || "en").slice(0, 2);
    const readStrings = async (owner, declaration) => {
      const bundles = [declaration.base_text, ...(declaration.locales || []).filter((l) => l.locale === locale)];
      for (const b of bundles) {
        const f = b && this.files.get(`${owner}/${b.path}`);
        if (f) Object.assign(strings, await this.cache.json(f.hash).catch(() => ({})));
      }
    };
    await readStrings(plugin, this.declaration);
    for (const [id, exp] of added) await readStrings(id, exp);
    this.strings = strings;
    this.slots = new Map((this.declaration.slots || []).map((sl) => [sl.key, sl]));
    await this.applyLook(manifest.look);
  }

  // The viewer's look (spec 23.5, 23.6): the pools of the theme and art packs it draws from, the uploads its bindings
  // name, and the table's flavor strings. Their files are already here (in the gate, or fetched in the background).
  async applyLook(look) {
    look = look || {};
    for (const f of look.files || []) if (f.path) this.files.set(f.path, f);
    for (const p of look.pools || []) await this.addPool(p.pool || {}, p.plugin, p.kind, p.plugin, false);
    for (const [reference, u] of Object.entries(look.uploads || {})) this.assets.set(reference, { hash: u.hash, mime: u.mime });
    this.view = { ...this.view, theme: look.theme || null, bindings: look.bindings || { every: {}, table: {} }, choice: look.choice || null };
    this.flavor = look.flavor || null;
    // the flavor in the viewer's language over its base language; the text module puts it above the game's
    const strings = {};
    if (this.flavor) {
      const locale = (navigator.language || "en").slice(0, 2);
      const paths = [this.flavor.base, ...(this.flavor.translations || []).filter((t) => t.locale === locale).map((t) => t.path)];
      for (const path of paths) {
        const f = path && this.files.get(path);
        if (f) Object.assign(strings, await this.cache.json(f.hash).catch(() => ({})));
      }
    }
    this.flavorStrings = strings;
  }

  /** What a slot draws for this viewer now: {reference, layer}. `vanilla` is the drawing's own asset, when the slot has none. */
  slotReference(key, vanilla = null) {
    const slot = this.slots.get(key);
    if (!slot) return { reference: referenceString(vanilla), layer: "vanilla" };
    return resolveSlot(slot, this.view, vanilla, (reference) => this.assets.has(reference));
  }

  /** A side's vanilla picture: its asset, or the slot's default when it names a slot and no asset. */
  vanillaOf(side) {
    if (side?.asset) return referenceString(side.asset);
    const slot = side?.slot && this.slots.get(side.slot);
    return slot ? referenceString(slot.default_asset) : null;
  }

  // A pool's assets, as "<kind>:<pool_id>/<asset_key>", and its templates, from the files of the plugin that ships it.
  async addPool(pool, plugin, kind, defaultId, withTemplates = true) {
    const poolId = pool.pool_id || defaultId;
    for (const a of pool.assets || []) {
      const path = a.media?.path ? `${plugin}/${a.media.path}` : null;
      const file = path ? this.files.get(path) : [...this.files.values()].find((f) => f.hash === a.media?.content_hash);
      if (file) this.assets.set(`${kind}:${poolId}/${a.asset_key}`, { hash: file.hash, mime: file.mime || a.media?.mime_type, width: a.width, height: a.height, name: a.name });
    }
    for (const t of withTemplates ? pool.templates || [] : []) {      // a theme's templates never replace the game's
      const f = this.files.get(`${plugin}/${t.layout_path}`);
      const layout = f ? await this.cache.json(f.hash).catch(() => null) : null;
      const exports = [];
      for (const x of t.exports || []) {
        const xf = this.files.get(`${plugin}/${x.layout_path}`);
        const xl = xf ? await this.cache.json(xf.hash).catch(() => null) : null;
        if (xl) exports.push({ declaration: x, layout: xl });
      }
      this.templates.set(t.template_id, { declaration: t, layout, exports });
    }
  }

  // ---------------------------------------------------------------- sizes

  sideOf(token, sideKey) {
    return (token?.sides || []).find((sd) => sd.key === sideKey) || (token?.sides || [])[0] || null;
  }

  sizeOfSide(side) {
    if (!side) return [60, 60];
    if (side.template_id && this.templates.has(side.template_id)) {
      const t = this.templates.get(side.template_id).declaration;
      return [t.width, t.height];
    }
    const a = this.assets.get(this.vanillaOf(side));            // the vanilla's box, whatever the theme draws in it
    if (a && a.width) return [a.width, a.height];
    return [60, 60];
  }

  // ---------------------------------------------------------------- drawing

  // An entity as the viewer sees it: its current side, or the back the server sent in place of it.
  drawEntity(ent) {
    if (ent.hidden) {
      const [w, hgt] = this.sizeOfSide(ent.back);
      return { node: this.drawSide(ent.back, {}, w, hgt), w, h: hgt };
    }
    const token = this.tokens.get(ent.kind);
    const side = this.sideOf(token, ent.side || token?.default_side);
    const [w, hgt] = this.sizeOfSide(side);
    const props = { ...(token?.properties || {}), ...(side?.properties || {}), ...(ent.props || {}) };
    if (ent.rolled != null) props.value = ent.rolled;
    return { node: this.drawSide(side, props, w, hgt, token), w, h: hgt };
  }

  drawSide(side, props, w, hgt, token) {
    const g = s("g", { class: "side" });
    const drawn = side?.slot && this.slots.has(side.slot) ? this.slotReference(side.slot, side.asset) : null;
    if (drawn && drawn.layer !== "vanilla" && drawn.reference) {
      // a theme or binding: a picture fitted into the side's own box (a templated side too)
      const fit = this.slots.get(side.slot).size?.fit || "contain";
      g.append(this.image(drawn.reference, 0, 0, w, hgt, fit));
    } else if (side?.template_id && this.templates.get(side.template_id)?.layout) {
      const t = this.templates.get(side.template_id);
      const defaults = Object.fromEntries((t.declaration.properties || []).filter((p) => p.default != null).map((p) => [p.key, p.default]));
      g.append(this.drawNode(t.layout, { ...defaults, ...(side.properties || {}), ...props }));
    } else if (side?.asset || drawn?.reference) {
      g.append(this.image(drawn?.reference || referenceString(side.asset), 0, 0, w, hgt));
    } else {
      // no look declared: a plain token with its name
      g.append(s("rect", { width: w, height: hgt, rx: 8, class: "plain-token" }));
      g.append(s("text", { x: w / 2, y: hgt / 2, "text-anchor": "middle", "dominant-baseline": "central", class: "plain-token-label" },
        side?.key && token ? `${token.name || token.token_id}${token.sides?.length > 1 ? ` (${side.key})` : ""}` : (token?.name || "?")));
    }
    return g;
  }

  image(reference, x, y, w, hgt, fit = "contain") {
    const img = s("image", { x, y, width: w, height: hgt, preserveAspectRatio: fit === "cover" ? "xMidYMid slice" : fit === "stretch" ? "none" : "xMidYMid meet" });
    const p = this.urlFor(reference).then((url) => { if (url) img.setAttribute("href", url); }).catch(() => img.classList.add("missing"));
    this.waits?.push(p);
    return img;
  }

  /** The file a reference names ({hash, mime, ...}): one of the game's, or a table upload fetched on demand. */
  async assetFor(reference) {
    if (!reference) return null;
    const a = this.assets.get(reference);
    if (a) return a;
    if (!this.remote.has(reference)) this.remote.set(reference, this.resolveRemote(reference));
    return this.remote.get(reference);
  }

  async urlFor(reference) {
    const a = await this.assetFor(reference);
    return a ? this.cache.url(a.hash, a.mime) : null;
  }

  sub(v, props) {
    return typeof v === "string" ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => props[k] ?? "") : v;
  }

  drawNode(node, props) {
    const st = Object.fromEntries(Object.entries(node.style || {}).map(([k, v]) => [k, this.sub(v, props)]));
    const w = node.width || 0, hgt = node.height || 0;
    const tf = [`translate(${node.x || 0} ${node.y || 0})`];
    if (node.rotation) tf.push(`rotate(${node.rotation} ${w / 2} ${hgt / 2})`);
    const g = s("g", { transform: tf.join(" "), opacity: node.opacity ?? 1 });
    const paint = { fill: st.fill ?? (node.kind === "text" ? undefined : "none"), stroke: st.stroke, "stroke-width": st.stroke_width };
    if (node.clip) {
      const id = `clip${Math.random().toString(36).slice(2, 9)}`;
      g.append(s("clipPath", { id }, this.shape(node.clip, w, hgt, {}, st)));
      g.setAttribute("clip-path", `url(#${id})`);
    }
    switch (node.kind) {
      case "box":
        g.append(s("rect", { width: w, height: hgt, rx: st.radius || 0, ...paint }));
        break;
      case "shape":
        g.append(this.shape(node.shape || "rectangle", w, hgt, paint, st, node.text));
        break;
      case "text": {
        let content = node.bind != null ? props[node.bind] : node.text;
        if (content && typeof content === "object") content = this.text.t(content);
        else if (typeof content === "string" && node.bind == null && this.text.has(content)) content = this.text.t(content);
        if (node.bind == null) content = this.sub(content, props);
        const align = st.align || "left";
        const valign = st.valign || "top";
        const x = align === "center" ? w / 2 : align === "right" ? w : 0;
        const y = valign === "middle" ? hgt / 2 : valign === "bottom" ? hgt : 0;
        g.append(s("text", {
          x, y, fill: st.color || "currentColor", "font-size": st.font_size || 14, "font-weight": st.font_weight,
          "font-family": st.font_family, "text-anchor": align === "center" ? "middle" : align === "right" ? "end" : "start",
          "dominant-baseline": valign === "middle" ? "central" : valign === "bottom" ? "text-after-edge" : "hanging",
        }, content == null ? "" : String(content)));
        break;
      }
      case "image": {
        const own = node.bind != null ? props[node.bind] : node.asset;
        const reference = node.slot && node.bind == null ? this.slotReference(node.slot, own).reference : referenceString(own);
        if (reference) g.append(this.image(reference, 0, 0, w, hgt, st.fit));
        break;
      }
      case "html": {
        const html = (node.html || "").replace(/\{\{(\w+)\}\}/g, (_, k) => escape(props[k]));
        const fo = s("foreignObject", { width: w, height: hgt });
        const div = document.createElement("div");
        div.className = "fragment";
        div.innerHTML = html;                     // not sanitized: players were told on connect
        fo.append(div);
        g.append(fo);
        if (node.fragment_path) {
          const f = this.files.get(`${this.plugin}/${node.fragment_path}`);
          if (f) this.waits?.push(this.cache.text(f.hash).then((t) => { div.innerHTML = t.replace(/\{\{(\w+)\}\}/g, (_, k) => escape(props[k])); }));
        }
        break;
      }
      default:
        break;
    }
    for (const c of node.children || []) g.append(this.drawNode(c, props));
    return g;
  }

  /** An export layout (spec section 23.9) drawn as one page: an <svg> sized in the page's unit, its nodes in px as in
   * any layout. It resolves once every image and fragment in it has loaded, so it can be printed or saved whole. */
  async drawPage(exp, props) {
    const root = exp.layout;
    const w = root.width || 794, hgt = root.height || 1123;
    const svg = s("svg", { width: `${exp.declaration.page_width}${exp.declaration.unit}`, height: `${exp.declaration.page_height}${exp.declaration.unit}`,
      viewBox: `0 0 ${w} ${hgt}`, class: "export-page", "font-family": "Georgia, 'Times New Roman', serif" });
    this.waits = [];
    try {
      svg.append(this.drawNode(root, props));
      await Promise.allSettled(this.waits);
    } finally {
      this.waits = null;
    }
    return svg;
  }

  shape(kind, w, hgt, paint, st, points) {
    if (kind === "ellipse") return s("ellipse", { cx: w / 2, cy: hgt / 2, rx: w / 2, ry: hgt / 2, ...paint });
    if (kind === "rounded_rectangle") return s("rect", { width: w, height: hgt, rx: st.radius || Math.min(w, hgt) / 8, ...paint });
    if (kind === "line") return s("line", { x1: 0, y1: 0, x2: w, y2: hgt, ...paint, stroke: paint.stroke || "currentColor" });
    if (kind === "polygon") return s("polygon", { points: points || `0,${hgt} ${w / 2},0 ${w},${hgt}`, ...paint });
    return s("rect", { width: w, height: hgt, ...paint });
  }
}
