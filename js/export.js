// Export (spec section 23.9): a template's print layout drawn with the requester's current values, from the same
// layout machinery as the board. It is a snapshot of this viewer's own projection, so it holds only what they may see
// (a stat they may not see prints as "?"); it is drawn here, sends nothing to the server, and is not an event.
// The page prints through the browser's dialog (save as PDF there), or downloads as one self-contained HTML file.
import { dialog, h, toast } from "./ui.js";

const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The export layouts an entity offers: those of the templates its token's sides are drawn with, by name. */
export function exportsFor(look, ent) {
  if (!ent || ent.hidden) return [];
  const token = look.tokens.get(ent.kind);
  const out = new Map();
  for (const side of token?.sides || []) {
    for (const x of look.templates.get(side.template_id)?.exports || []) if (!out.has(x.declaration.name)) out.set(x.declaration.name, x);
  }
  return [...out.values()];
}

/** The values a sheet binds to: every declared stat, each derived stat's breakdown as <key>_breakdown, the token's and
 * the entity's own properties, and the names in `extra`. Lists of token or catalog keys become names. A stat the
 * projection leaves out is its default if this viewer may see it (`whole`: the GM or its owner; otherwise its reveal
 * `level`, as the server decides), and "?" if not. */
export function sheetProperties(look, ent, { whole = false, level = null } = {}, extra = {}) {
  const token = look.tokens.get(ent.kind);
  const side = look.sideOf(token, ent.side || token?.default_side);
  const catalog = Object.fromEntries((look.declaration.catalog || []).map((c) => [c.key, c.name]));
  const name = (x) => (typeof x === "string" ? look.tokens.get(x)?.name || catalog[x] || x : x);
  const fmt = (v) => (Array.isArray(v) ? (v.length ? v.map((x) => fmt(name(x))).join(", ") : "none")
    : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v == null ? "" : String(v));
  const props = {};
  const sees = (d) => {
    const levels = d.reveal_levels || [];
    return whole || d.reveal_at == null || (levels.includes(level) && levels.indexOf(level) >= levels.indexOf(d.reveal_at));
  };
  for (const d of look.declaration.stats || []) {
    props[d.key] = sees(d) && !d.formula && d.base_default != null ? fmt(d.base_default) : "?";
    props[`${d.key}_breakdown`] = "";
  }
  const tmpl = look.templates.get(side?.template_id)?.declaration;
  for (const p of tmpl?.properties || []) if (p.default != null) props[p.key] = fmt(p.default);
  for (const src of [token?.properties, side?.properties, ent.props, ent]) {
    for (const [k, v] of Object.entries(src || {})) if (v === null || typeof v !== "object" || Array.isArray(v)) props[k] = fmt(v);
  }
  for (const [k, v] of Object.entries(ent.stats || {})) props[k] = fmt(v);
  for (const [k, d] of Object.entries(ent.derived || {})) {
    props[k] = fmt(d.value);
    const terms = String(d.breakdown || "").split(" = ").slice(0, -1).join(" = ");
    props[`${k}_breakdown`] = terms && terms !== props[k] ? `${terms} = ${props[k]}` : "";
  }
  props.kind_name = token?.name || ent.kind || "";
  return { ...props, ...extra };
}

/** Show an export of one entity, with Print and Download. */
export async function openExport(screen, entityId, exportEntry) {
  if (screen.state?.settings?.["export.enabled"] === false) { toast("Exports are switched off at this table.", "warn"); return; }
  const ent = screen.state?.entities?.[entityId];
  if (!ent || ent.hidden) return;
  const look = screen.look;
  const title = look.text.has(`export.${exportEntry.declaration.name}`) ? look.text.t(`export.${exportEntry.declaration.name}`) : exportEntry.declaration.name.replace(/_/g, " ");
  const when = new Date();
  const viewer = screen.seat != null ? screen.seatName(screen.seat) : "the table view";
  const gm = screen.isGM() && screen.state?.settings?.["gm.sight"] !== false;
  const whole = gm || (screen.seat != null && ent.owner === screen.seat);
  const props = sheetProperties(look, ent, { whole, level: screen.state?.reveals?.[entityId] ?? null }, {
    name: ent.name || entityId,
    owner_name: ent.owner != null ? screen.seatName(ent.owner) : "the GM",
    viewer_name: viewer,
    table_name: screen.snap?.table?.name || "",
    exported: `${screen.snap?.table?.name || screen.snap?.game?.name || ""} · what ${viewer} could see on ${when.toLocaleString()} · a snapshot, not a record of play`,
  });
  const page = await look.drawPage(exportEntry, props);
  const file = `${ent.name || entityId} - ${title}`.replace(/[\\/:*?"<>|]+/g, "_");
  const preview = h("div.export-preview", {}, page);
  dialog(`${title}: ${ent.name || entityId}`, [
    h("p.muted", {}, "Your current view of this sheet. Print it, or save it as a PDF from the print dialog; Download saves a page that opens in any browser."),
    h("div.row", {},
      h("button.primary", { type: "button", onclick: () => print(page, exportEntry, preview) }, "Print"),
      h("button.ghost", { type: "button", onclick: () => download(page, exportEntry, file).catch((e) => toast(e.message, "warn")) }, "Download")),
    preview,
  ], [["Close", true]]);
}

const pageCss = (exp) => `@page { size: ${exp.declaration.page_width}${exp.declaration.unit} ${exp.declaration.page_height}${exp.declaration.unit}; margin: 0; }`;

// Print: the page moves out of the dialog into a print root the print styles leave alone, and back once printed.
function print(page, exp, home) {
  const root = h("div", { id: "print-root" }, page);
  const style = h("style", {}, pageCss(exp));
  document.head.append(style);
  document.body.append(root);
  document.body.classList.add("printing");
  const done = () => {
    window.removeEventListener("afterprint", done);
    document.body.classList.remove("printing");
    style.remove();
    home.append(page);
    root.remove();
  };
  window.addEventListener("afterprint", done);
  window.print();
}

// Download: one HTML file that opens anywhere, with its images inlined, since the cache's blob URLs do not travel.
async function download(page, exp, file) {
  const copy = page.cloneNode(true);
  for (const img of copy.querySelectorAll("image")) {
    const href = img.getAttribute("href");
    if (href?.startsWith("blob:")) img.setAttribute("href", await dataUrl(href));
  }
  const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escape(file)}</title>\n<style>${pageCss(exp)}\n`
    + "html, body { margin: 0; background: #fff; } svg { display: block; margin: 0 auto; } .fragment { width: 100%; height: 100%; }\n"
    + `@media screen { body { background: #ddd; padding: 16px 0; } svg { background: #fff; box-shadow: 0 2px 12px rgb(0 0 0 / 0.25); max-width: 100%; height: auto; } }\n`
    + `</style></head><body>\n${new XMLSerializer().serializeToString(copy)}\n</body></html>\n`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = h("a", { href: url, download: `${file}.html` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function dataUrl(href) {
  const blob = await (await fetch(href)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
