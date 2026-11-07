// The Look panel (spec 23.5, 23.7): the viewer's theme for this game, their own picture or sound for each slot, saving
// that as a theme of their own, and peeking at the game's vanilla. Everything here is the viewer's alone: never logged,
// never shared. Table-scope slots are shown, but the table chooses them (in Table settings).
import { LAYER_NAMES, ratioWarning, suits } from "./slots.js";
import { clear, dialog, h, toast } from "./ui.js";

/** A small picture of an asset, or a note for a sound; drawn when its file is here. */
function thumb(screen, reference, kind) {
  const box = h("span.look-thumb", { title: reference || "" });
  if (!reference) return box;
  if (kind === "audio") {
    box.append(h("button.ghost", { type: "button", onclick: () => screen.playSound(reference, "effects") }, "▶"));
    return box;
  }
  screen.look.urlFor(reference).then((url) => { if (url) box.append(h("img", { src: url, alt: "" })); }).catch(() => {});
  return box;
}

/** Fetch one candidate's file (and key) so it can be drawn and bound. */
async function fetchAsset(screen, a) {
  screen.app.cache.setKeys({ [a.hash]: a.key });
  if (!(await screen.app.cache.inventory()).includes(a.hash)) await screen.app.cache.download(a);
  if (!screen.look.assets.has(a.asset_reference)) screen.look.assets.set(a.asset_reference, { hash: a.hash, mime: a.mime, width: a.width, height: a.height, name: a.name });
}

export async function openLook(screen) {
  const preferences = screen.viewerPreferences;
  const look = screen.look;
  const gameName = screen.snap?.game?.name || "this game";
  const body = h("div.look");
  let candidates = null;
  const loadCandidates = async () => {
    if (!candidates) candidates = (await screen.net.request("themes.assets", { table_id: screen.id })).assets;
    return candidates;
  };

  const render = () => {
    const themes = screen.themesHere || [];
    const chosen = preferences.game.theme || "";
    const select = h("select", { "aria-label": "Theme" },
      h("option", { value: "" }, "Vanilla (the game's own)"),
      themes.map((t) => h("option", { value: t.reference, selected: t.reference === chosen }, t.origin === "saved" ? `${t.name} (yours)` : t.name)));
    const scope = h("select", { "aria-label": "Where it applies" },
      h("option", { value: "table" }, "this table"), h("option", { value: "game" }, `every ${gameName} table`));
    select.addEventListener("change", () => preferences.setGame("theme", select.value || null, scope.value).then(render).catch((e) => toast(e.message, "warn")));
    const stale = look.view.choice && !look.view.theme && chosen ? h("p.muted", {}, "Your theme is not one for this table's game now, so it draws vanilla.") : null;

    const rows = [...look.slots.values()].filter((sl) => sl.kind !== "text").map((sl) => {
      const now = look.slotReference(sl.key);
      const bound = preferences.bindings.table?.[sl.key] ? "table" : preferences.bindings.every?.[sl.key] ? "every" : null;
      const tableScope = sl.scope === "table";
      return h("tr", {},
        h("th", { scope: "row" }, sl.key, sl.tags?.length ? h("div.muted", {}, sl.tags.join(", ")) : null),
        h("td", {}, thumb(screen, sl.default_asset ? `${sl.default_asset.pool_kind}:${sl.default_asset.pool_id}/${sl.default_asset.asset_key}` : null, sl.kind)),
        h("td", {}, thumb(screen, now.reference, sl.kind), h("div.muted", {}, LAYER_NAMES[now.layer] + (now.layer === "theme" && look.view.theme ? ` ${look.view.theme.name}` : ""))),
        h("td", {}, tableScope ? h("span.muted", {}, "set by the table (Table settings)") : [
          h("button.ghost", { type: "button", onclick: () => pick(sl) }, "Change…"),
          bound ? h("button.ghost", { type: "button", onclick: () => preferences.bind(sl.key, null, bound === "table").then(render).catch((e) => toast(e.message, "warn")) }, "Reset") : null]));
    });

    const peek = h("input", { type: "checkbox", checked: preferences.peek });
    peek.addEventListener("change", () => preferences.setPeek(peek.checked).then(render).catch((e) => toast(e.message, "warn")));
    const name = h("input", { type: "text", placeholder: "Name", "aria-label": "Theme name" });
    const save = async () => {
      const bindings = {};
      for (const sl of look.slots.values()) {
        const now = look.slotReference(sl.key);
        if (sl.scope !== "table" && sl.kind !== "text" && now.layer !== "vanilla") bindings[sl.key] = now.reference;
      }
      if (!name.value.trim()) return toast("Give the theme a name.", "warn");
      if (!Object.keys(bindings).length) return toast("Nothing differs from vanilla yet.", "warn");
      try {
        await screen.net.request("themes.save", { name: name.value.trim(), bindings });
        screen.themesHere = (await screen.net.request("themes.list", { table_id: screen.id })).themes;
        toast(`Saved the theme ${name.value.trim()}.`);
        render();
      } catch (e) {
        toast(e.message, "warn");
      }
    };

    clear(body,
      h("label.field", {}, h("span", {}, "Theme"), select), h("label.field", {}, h("span", {}, "For"), scope), stale,
      rows.length ? h("table.settings-table.look-slots", {}, h("thead", {}, h("tr", {}, h("th", {}, "Slot"), h("th", {}, "Vanilla"), h("th", {}, "Now"), h("th", {}, ""))), h("tbody", {}, rows)) : null,
      h("label.field.inline", {}, peek, h("span", {}, "Peek at vanilla: draw the game's own everywhere")),
      h("div.look-save", {}, name, h("button.ghost", { type: "button", onclick: save }, "Save as theme")),
      h("p.muted", {}, "Your look is yours: never logged, never shown to anyone else."));
  };

  const pick = async (sl) => {
    let all;
    try {
      all = (await loadCandidates()).filter((a) => suits(sl, a));
    } catch (e) {
      return toast(e.message, "warn");
    }
    const here = h("input", { type: "checkbox" });
    const list = h("div.look-picks");
    const note = h("p.muted");
    for (const a of all) {
      const pic = h("span.look-thumb");
      const btn = h("button.look-pick", { type: "button", title: `${a.name} (${a.source})` }, pic, h("span", {}, a.name), h("span.muted", {}, a.source));
      btn.addEventListener("mouseenter", () => { note.textContent = ratioWarning(sl, a) || ""; });
      btn.addEventListener("click", async () => {
        try {
          await fetchAsset(screen, a);
          await preferences.bind(sl.key, a.asset_reference, here.checked);
          document.querySelectorAll("dialog.look-picker[open]").forEach((d) => d.close());
          const warn = ratioWarning(sl, a);
          if (warn) toast(warn, "warn");
          render();
        } catch (e) {
          toast(e.message, "warn");
        }
      });
      list.append(btn);
      if (sl.kind !== "audio") fetchAsset(screen, a).then(() => screen.look.urlFor(a.asset_reference)).then((url) => { if (url) pic.append(h("img", { src: url, alt: "" })); }).catch(() => {});
    }
    const p = dialog(`Choose for ${sl.key}`, h("div", {}, all.length ? list : h("p.muted", {}, "Nothing here suits this slot yet."), note,
      h("label.field.inline", {}, here, h("span", {}, "This table only"))), [["Cancel", null, "ghost"]]);
    document.querySelector("dialog:last-of-type")?.classList.add("look-picker");
    await p;
  };

  render();
  preferences.addEventListener("applied", render);
  await dialog("Look", body, [["Close", true]]);
  preferences.removeEventListener("applied", render);
}
