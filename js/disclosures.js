// The hidden-data panel: a match's hidden data you may know of, where owners and the GM release it or change its
// disclosure class (spec section 11).
import { dialog, h, toast } from "./ui.js";

export const CLASS_TEXT = {
  eventually_public: "public once the release rule says so",
  owner: "its owner releases it",
  owner_and_gm: "its owner or the GM releases it",
  gm_fudged: "the GM releases it",
  sealed: "never released",
};

export const POLICY_TEXT = {
  immediately: "at once",
  on_end: "when the match ends",
  delay: "a while after the match ends",
  turns: "a few turns after it happened",
  gm: "when the GM releases it",
  never: "never",
};


function datumText(d, seatName) {
  if (d.kind === "state") {
    if (d.part === "seat") return `What ${seatName(d.owner)} alone saw (their hand, their private corner)`;
    if (d.part === "gm") return "What the GM's own seat held";
    return "What no one saw (a deck's order, face-down cards, the server's secrets)";
  }
  if (d.kind === "journal") return `A journal note of ${seatName(d.owner)} (seen by: ${d.visibility})`;
  const owner = d.owner != null ? seatName(d.owner) : "the table";
  const to = { named: "chosen seats", gm: "the GM", self: "only themself", party: "their party", scene: "their scene" }[d.privacy] || d.privacy;
  if (d.event_type?.startsWith("msg.")) return `A ${d.event_type.slice(4)} from ${owner}, to ${to} · event ${d.seq}`;
  return `${d.event_type} for ${owner} · event ${d.seq}`;
}

/** List a match's hidden data you may know of, and release or reclassify what you may. `after` runs after a change. */
export async function openDisclosures(app, tableId, number, { seatName = (n) => `seat ${n}`, after } = {}) {
  let r;
  try {
    r = await app.net.request("disclosure.list", { table_id: tableId, number });
  } catch (e) {
    return toast(e.message, "warn");
  }
  const change = async (method, params) => {
    try {
      await app.net.request(method, { table_id: tableId, number, ...params });
      toast("Done. It is logged at the table.");
      document.querySelector("dialog[open]")?.close();
      if (after) after(); else openDisclosures(app, tableId, number, { seatName });
    } catch (e) {
      toast(e.message, "warn");
    }
  };
  const row = (d) => {
    const cls = h("select", { disabled: !d.may_reclassify, "aria-label": "Disclosure class" },
      Object.entries(CLASS_TEXT).map(([k, label]) => h("option", { value: k, selected: k === d.class }, label)));
    cls.addEventListener("change", () => change("disclosure.set", { data: [{ key: d.key, class: cls.value }] }));
    return h("tr", { class: d.released ? "released" : "" },
      h("td", {}, datumText(d, seatName), d.mine ? h("span.badge", {}, "yours") : null),
      h("td", {}, cls),
      h("td", {}, d.released ? h("span.ok", {}, "released") : d.may_release
        ? h("button.small", { onclick: () => change("disclosure.set", { data: [{ key: d.key, released: true }] }) }, "Release") : h("span.muted", {}, "hidden")));
  };
  const policy = POLICY_TEXT[r.policy] || r.policy;
  const authority = { owner_and_gm: "each datum's owner, or the GM, as its class says", owner: "owners only", gm: "the GM only" }[r.authority] || r.authority;
  const body = h("div.disclosures-panel", {},
    h("p", {}, `What every player may eventually see is released ${policy}. Releasing anything else is up to ${authority}.`),
    r.archived ? h("p.notice", {}, "This table is archived: what is released stays as it was.") : null,
    r.data.length ? h("table.admin-table", {}, h("tbody", {}, r.data.map(row))) : h("p.muted", {}, "Nothing hidden that you may know of."),
    r.withheld ? h("p.muted.small", {}, `${r.withheld} more item(s) belong to others; they appear here once released.`) : null,
    r.gm && !r.released_match && !r.archived && r.policy !== "never"
      ? h("div.row", {}, h("button", { onclick: () => change("disclosure.release", {}) }, "Release the match's public data now")) : null);
  dialog(`Hidden data of match ${number}`, body, [["Close", true]]);
}
