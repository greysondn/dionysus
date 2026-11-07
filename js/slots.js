// Which asset a slot draws for this viewer (spec 23.5). Layers, highest first, for a viewer-scope slot: the viewer's
// binding for this table, their binding for every table, their theme, then the game's vanilla. A table-scope slot
// follows the table's setting slot.<key>, else vanilla; viewer layers never apply to it. A layer whose asset this
// client cannot draw (not downloaded yet, deleted) falls through to the next, so a slot never shows a hole.
// Pure: no DOM and no network, so the order can be tested on its own.

export const LAYER_NAMES = { table: "this table only", every: "yours", theme: "theme", setting: "set by the table", vanilla: "vanilla" };

function str(reference) {
  if (!reference) return null;
  if (typeof reference === "string") return reference;
  if (reference.pool_kind) return `${reference.pool_kind}:${reference.pool_id}/${reference.asset_key}`;
  return null;
}

/** The layers that could fill a slot, highest first: [[reference, layer], ...], ending with the vanilla. */
export function slotLayers(slot, look = {}, vanilla = null) {
  const key = slot?.key;
  const base = str(slot?.default_asset) || str(vanilla);
  const out = [];
  if (key && !look.peek) {
    if (slot.scope === "table") {
      const set = str(look.settings?.[`slot.${key}`]);
      if (set) out.push([set, "setting"]);
    } else {
      const here = str(look.bindings?.table?.[key]);
      const every = str(look.bindings?.every?.[key]);
      const themed = str(look.theme?.bindings?.[key]);
      if (here) out.push([here, "table"]);
      if (every) out.push([every, "every"]);
      if (themed) out.push([themed, "theme"]);
    }
  }
  if (base) out.push([base, "vanilla"]);
  return out;
}

/** The first layer this client can draw: {reference, layer}. `known(reference)` says whether an asset is drawable now. */
export function resolveSlot(slot, look, vanilla, known = () => true) {
  const layers = slotLayers(slot, look, vanilla);
  const hit = layers.find(([reference, layer]) => layer === "vanilla" || known(reference)) || layers[layers.length - 1];
  return hit ? { reference: hit[0], layer: hit[1] } : { reference: null, layer: "vanilla" };
}

/** Whether an asset suits a slot: its kind (audio or visual, by mime), and a shared tag when the slot has tags. */
export function suits(slot, asset) {
  const audio = (asset.mime || "").startsWith("audio/");
  if ((slot.kind === "audio") !== audio) return false;
  const tags = slot.tags || [];
  return !tags.length || (asset.tags || []).some((t) => tags.includes(t));
}

/** A warning when an asset's ratio is off the slot's size by more than its tolerance (23.2: encouraged, never refused). */
export function ratioWarning(slot, asset) {
  const size = slot.size;
  if (!size?.width || !size?.height || !asset.width || !asset.height) return null;
  const want = size.width / size.height, got = asset.width / asset.height;
  const tolerance = size.ratio_tolerance ?? 0.05;
  return Math.abs(got - want) / want > tolerance
    ? `${asset.width}×${asset.height} is off this slot's shape (${size.width}×${size.height}); it is fitted inside` : null;
}
