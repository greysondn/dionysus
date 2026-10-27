// The generic renderer for a game's look: layouts (positioned nodes in px), templates (a layout plus property
// values), and assets (files in the game's pool, or uploaded to a table or player pool). Everything is data.
// HTML fragment nodes are drawn unsanitized, as the spec allows; values still enter through {{key}} bindings,
// which are escaped as text.
import { s } from "./ui.js";

export function refString(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  if (a.pool_kind) return `${a.pool_kind}:${a.pool_id}/${a.asset_key}`;
  return null;
}

const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class GameLook {
  constructor(cache, text) {
    this.cache = cache;
    this.text = text;
    this.decl = {};
    this.files = new Map();       // "plugin_id/path" -> {hash, mime}
    this.templates = new Map();   // template_id -> {decl, layout}
    this.assets = new Map();      // ref -> {hash, mime, width, height}
    this.tokens = new Map();
    this.onUpdate = () => {};
    this.remote = new Map();      // ref -> Promise<{hash, mime}> for uploaded assets
    this.resolveRemote = async () => null;
  }

  async load(manifest) {
    this.files.clear();
    for (const f of manifest.files) this.files.set(f.path, f);
    this.decl = await this.cache.json(manifest.entry);
    const plugin = [...this.files.keys()].find((p) => p.endsWith("/game.json"))?.split("/game.json")[0];
    this.plugin = plugin;
    const pool = this.decl.pool || {};
    const poolId = pool.pool_id || this.decl.game_id;
    for (const a of pool.assets || []) {
      const path = a.media?.path ? `${plugin}/${a.media.path}` : null;
      const file = path ? this.files.get(path) : [...this.files.values()].find((f) => f.hash === a.media?.content_hash);
      if (file) this.assets.set(`game:${poolId}/${a.asset_key}`, { hash: file.hash, mime: file.mime || a.media?.mime_type, width: a.width, height: a.height, name: a.name });
    }
    for (const t of pool.templates || []) {
      const f = this.files.get(`${plugin}/${t.layout_path}`);
      const layout = f ? await this.cache.json(f.hash).catch(() => null) : null;
      this.templates.set(t.template_id, { decl: t, layout });
    }
    for (const t of [...(this.decl.tokens || []), ...(this.decl.rollables || [])]) this.tokens.set(t.token_id, t);
    const strings = {};
    const base = this.decl.base_text;
    if (base) {
      const f = this.files.get(`${plugin}/${base.path}`);
      if (f) Object.assign(strings, await this.cache.json(f.hash).catch(() => ({})));
    }
    const locale = (navigator.language || "en").slice(0, 2);
    for (const l of this.decl.locales || []) {
      if (l.locale === locale) {
        const f = this.files.get(`${plugin}/${l.path}`);
        if (f) Object.assign(strings, await this.cache.json(f.hash).catch(() => ({})));
      }
    }
    this.strings = strings;
  }

  // ---------------------------------------------------------------- sizes

  sideOf(token, sideKey) {
    return (token?.sides || []).find((sd) => sd.key === sideKey) || (token?.sides || [])[0] || null;
  }

  sizeOfSide(side) {
    if (!side) return [60, 60];
    if (side.template_id && this.templates.has(side.template_id)) {
      const t = this.templates.get(side.template_id).decl;
      return [t.width, t.height];
    }
    const a = this.assets.get(refString(side.asset));
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
    if (side?.template_id && this.templates.get(side.template_id)?.layout) {
      const t = this.templates.get(side.template_id);
      const defaults = Object.fromEntries((t.decl.properties || []).filter((p) => p.default != null).map((p) => [p.key, p.default]));
      g.append(this.drawNode(t.layout, { ...defaults, ...(side.properties || {}), ...props }));
    } else if (side?.asset) {
      g.append(this.image(refString(side.asset), 0, 0, w, hgt));
    } else {
      // no look declared: a plain token with its name
      g.append(s("rect", { width: w, height: hgt, rx: 8, class: "plain-token" }));
      g.append(s("text", { x: w / 2, y: hgt / 2, "text-anchor": "middle", "dominant-baseline": "central", class: "plain-token-label" },
        side?.key && token ? `${token.name || token.token_id}${token.sides?.length > 1 ? ` (${side.key})` : ""}` : (token?.name || "?")));
    }
    return g;
  }

  image(ref, x, y, w, hgt, fit = "contain") {
    const img = s("image", { x, y, width: w, height: hgt, preserveAspectRatio: fit === "cover" ? "xMidYMid slice" : fit === "stretch" ? "none" : "xMidYMid meet" });
    this.urlFor(ref).then((url) => { if (url) img.setAttribute("href", url); }).catch(() => img.classList.add("missing"));
    return img;
  }

  async urlFor(ref) {
    if (!ref) return null;
    let a = this.assets.get(ref);
    if (!a) {
      if (!this.remote.has(ref)) this.remote.set(ref, this.resolveRemote(ref));
      a = await this.remote.get(ref);
      if (!a) return null;
    }
    return this.cache.url(a.hash, a.mime);
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
        g.append(this.shape(node.shape || "rect", w, hgt, paint, st, node.text));
        break;
      case "text": {
        let content = node.bind != null ? props[node.bind] : node.text;
        if (content && typeof content === "object") content = this.text.t(content);
        else if (typeof content === "string" && node.bind == null && this.text.has(content)) content = this.text.t(content);
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
        const ref = refString(node.bind != null ? props[node.bind] : node.asset);
        if (ref) g.append(this.image(ref, 0, 0, w, hgt, st.fit));
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
          if (f) this.cache.text(f.hash).then((t) => { div.innerHTML = t.replace(/\{\{(\w+)\}\}/g, (_, k) => escape(props[k])); });
        }
        break;
      }
      default:
        break;
    }
    for (const c of node.children || []) g.append(this.drawNode(c, props));
    return g;
  }

  shape(kind, w, hgt, paint, st, points) {
    if (kind === "ellipse") return s("ellipse", { cx: w / 2, cy: hgt / 2, rx: w / 2, ry: hgt / 2, ...paint });
    if (kind === "rounded_rect") return s("rect", { width: w, height: hgt, rx: st.radius || Math.min(w, hgt) / 8, ...paint });
    if (kind === "line") return s("line", { x1: 0, y1: 0, x2: w, y2: hgt, ...paint, stroke: paint.stroke || "currentColor" });
    if (kind === "polygon") return s("polygon", { points: points || `0,${hgt} ${w / 2},0 ${w},${hgt}`, ...paint });
    return s("rect", { width: w, height: hgt, ...paint });
  }
}
