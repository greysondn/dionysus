// Applying a patch from the server to the state a client holds (wire protocol v0.2): what live play does with each
// event, and what a replay does with each step, again whenever it steps back and rebuilds. Every value goes in as a
// copy, as the server's apply_patch does: a replay keeps its steps' patches and applies them many times, and a value
// shared with the state would be changed by later steps, so an earlier step would come back holding a later value.
// A pure function, so it runs under Node too (tests/client/patch.test.mjs).

/** Apply a patch to a state in place. A set with no value deletes the key, as in effects. */
export const apply = (state, patch) => {
  for (const op of patch) {
    const parts = op.path.split("/");
    let node = state;
    for (const p of parts.slice(0, -1)) {
      if (Array.isArray(node)) node = node[Number(p)];
      else node = node[p] ??= {};
    }
    const key = parts[parts.length - 1];
    if (op.op === "set") {
      if (!("value" in op)) { if (!Array.isArray(node)) delete node[key]; }
      else if (Array.isArray(node)) node[Number(key)] = structuredClone(op.value);
      else node[key] = structuredClone(op.value);
    } else if (op.op === "add") {
      const list = Array.isArray(node) ? node[Number(key)] : (node[key] ??= []);
      list.splice(op.index ?? list.length, 0, structuredClone(op.value));
    } else if (op.op === "remove") {
      const list = Array.isArray(node) ? node[Number(key)] : node[key];
      list.splice(op.index ?? list.length - 1, 1);
    } else if (op.op === "increment") {
      node[key] = (node[key] || 0) + op.by;
    }
  }
};
