// Notation: the game or the position as text, in a format the game's notation plugins write (PDN for draughts), and
// loading one back. Export is a request the server answers from what this viewer may see, and is never logged; a load
// is the action notation.load, which the table agrees to by its load mode (a vote by default) and the rules check.
import { clear, dialog, h, toast } from "./ui.js";

const WHAT = { position: "Position", game: "Game so far" };

/** The Notation dialog: export (copy, download) and load (paste, open a file). */
export function openNotation(screen) {
  const formats = screen.snap?.game?.notations || [];
  if (!formats.length) return;
  let format = formats[0];
  const pick = (onchange) => {
    if (formats.length < 2) return null;
    const select = h("select", { "aria-label": "Format" }, formats.map((f) => h("option", { value: f.notation_id }, f.name)));
    select.value = format.notation_id;
    select.addEventListener("change", () => { format = formats.find((f) => f.notation_id === select.value); onchange(); });
    return h("label.field", {}, h("span", {}, "Format"), select);
  };

  // ------------------------------------------------------------------ export
  const out = h("textarea.code", { readonly: true, rows: 8, "aria-label": "Exported text", spellcheck: "false" });
  const whatBox = h("div.segmented", { role: "group", "aria-label": "What to export" });
  let what = format.writes[0];
  let file = null;
  const fetchText = async () => {
    if (!format.writes.includes(what)) what = format.writes[0];
    clear(whatBox, format.writes.map((w) => h("button", { type: "button", class: w === what ? "seg on" : "seg", onclick: () => { what = w; fetchText(); } }, WHAT[w] || w)));
    out.value = "";
    try {
      const r = await screen.net.request("notation.export", { table_id: screen.id, notation_id: format.notation_id, what });
      out.value = r.text;
      file = r.filename;
    } catch (e) {
      out.value = "";
      toast(e.message, "warn");
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(out.value); toast("Copied."); } catch { out.select(); document.execCommand("copy"); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([out.value], { type: "text/plain" }));
    const a = h("a", { href: url, download: file || `${screen.snap?.table?.name || "game"}.${format.extension}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // ------------------------------------------------------------------ load
  const m = screen.state?.match || {};
  const seated = screen.seat != null && (m.status === "running" || m.status === "ready_to_end");
  const allowed = seated && (screen.state?.settings?.["notation.loaders"] !== "gm" || screen.isGM());
  const input = h("textarea.code", { rows: 6, "aria-label": "Text to load", spellcheck: "false", placeholder: "Paste a game or a position here, or open a file." });
  const reason = h("p.small.warn", { role: "status" });
  const fileInput = h("input", { type: "file", accept: ".pdn,.txt,text/plain", hidden: true });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (f) input.value = await f.text();
    fileInput.value = "";
  });
  const load = async () => {
    reason.textContent = "";
    if (!input.value.trim()) { reason.textContent = "There is nothing to load."; return; }
    const ack = await screen.net.action(screen.id, "notation.load", { notation_id: format.notation_id, text: input.value });
    if (ack.outcome === "rejected") { reason.textContent = ack.reason || "That was refused."; return; }
    const mode = screen.state?.settings?.["notation.load_mode"];
    toast(mode && mode !== "rules" ? "Sent: the table decides whether to load it." : "Loaded.");
    input.value = "";
    fetchText();
  };
  const mode = screen.state?.settings?.["notation.load_mode"] || "majority";
  const how = { rules: "It loads at once.", gm: "The GM decides.", majority: "The table votes on it.", unanimous: "Everyone seated must agree." }[mode];
  const loadPart = allowed
    ? [h("h3", {}, "Load"),
       h("p.muted.small", {}, `A position replaces the one on the table; a game's moves are played through the rules, so a move they refuse stops the load. ${how}`),
       input, fileInput,
       h("div.row", {}, h("button.ghost", { type: "button", onclick: () => fileInput.click() }, "Open file…"),
         h("button.primary", { type: "button", onclick: load }, "Load")), reason]
    : [h("p.muted.small", {}, seated ? "Only the GM may load a game or a position at this table."
      : "A seated player can load a game or a position while a match is running.")];

  const picker = pick(fetchText);
  dialog(`Notation: ${screen.snap?.game?.name || ""}`, h("div.form.notation", {},
    picker,
    h("h3", {}, "Export"),
    h("p.muted.small", {}, `What you can see, as ${format.name}.`),
    whatBox, out,
    h("div.row", {}, h("button.ghost", { type: "button", onclick: copy }, "Copy"), h("button.ghost", { type: "button", onclick: download }, "Download")),
    loadPart), [["Close", true]]);
  fetchText();
}
