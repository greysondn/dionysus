// Small DOM helpers: element building, dialogs, toasts, and forms drawn from a JSON Schema.

export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastBox;
export function toast(text, kind = "info", ms = 4200) {
  if (!toastBox) {
    toastBox = h("div.toasts", { role: "status", "aria-live": "polite" });
    document.body.append(toastBox);
  }
  const t = h("div.toast", { class: kind }, text);
  toastBox.append(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function dialog(title, body, actions = []) {
  return new Promise((resolve) => {
    const d = h("dialog.dialog", {},
      h("header", {}, h("h2", {}, title)),
      h("div.dialog-body", {}, body),
      h("footer", {}, actions.map(([label, value, cls]) =>
        h("button", { class: cls || "", type: "button", onclick: () => { d.close(); resolve(typeof value === "function" ? value() : value); } }, label))));
    d.addEventListener("close", () => { setTimeout(() => d.remove(), 0); resolve(undefined); });
    document.body.append(d);
    d.showModal();
  });
}

// A form from a JSON Schema (object with properties), for controls and flow steps.
export function schemaForm(schema, initial = {}, label = (k) => k) {
  const fields = {};
  const props = schema?.properties || {};
  const box = h("div.schema-form");
  for (const [key, p] of Object.entries(props)) {
    let input;
    const value = initial[key];
    if (p.enum) {
      input = h("select", { name: key }, p.enum.map((v) => h("option", { value: JSON.stringify(v), selected: v === value }, String(v))));
      fields[key] = () => JSON.parse(input.value);
    } else if (p.type === "boolean") {
      input = h("input", { type: "checkbox", name: key, checked: !!value });
      fields[key] = () => input.checked;
    } else if (p.type === "number" || p.type === "integer") {
      input = h("input", { type: "number", name: key, value: value ?? "", min: p.minimum, max: p.maximum, step: p.type === "integer" ? 1 : "any" });
      fields[key] = () => (input.value === "" ? undefined : Number(input.value));
    } else if (p.type === "array" && p.items?.enum) {
      input = h("select", { name: key, multiple: true, size: Math.min(6, p.items.enum.length) },
        p.items.enum.map((v) => h("option", { value: JSON.stringify(v), selected: (value || []).includes(v) }, String(v))));
      fields[key] = () => Array.from(input.selectedOptions, (o) => JSON.parse(o.value));
    } else if (p.type === "object" || p.type === "array") {
      input = h("textarea", { name: key, rows: 3 }, value ? JSON.stringify(value) : "");
      fields[key] = () => (input.value.trim() ? JSON.parse(input.value) : undefined);
    } else {
      input = h("input", { type: "text", name: key, value: value ?? "" });
      fields[key] = () => (input.value === "" ? undefined : input.value);
    }
    box.append(h("label.field", {}, h("span", {}, p.title ? label(p.title) : label(key)), input));
  }
  box.values = () => {
    const out = {};
    for (const [k, get] of Object.entries(fields)) {
      const v = get();
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  return box;
}

export function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function bytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
