// Content-addressed file cache. The served (encrypted) bytes are stored by their plaintext hash in IndexedDB,
// across every table and game, with nothing to invalidate. A file is opened only with the key the server
// delivers once that file is visible to this viewer. Least recently used files are evicted past a budget,
// and the current table's files are pinned.
import { hex } from "./net.js";

const DB_NAME = "dionysus-cache";
const STORE = "served";
const DEFAULT_BUDGET = 512 * 1024 * 1024;

function idb(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class FileCache {
  constructor(net) {
    this.net = net;
    this.keys = new Map();          // hash -> base64 key (held in memory only)
    this.plain = new Map();         // hash -> Promise<Uint8Array>
    this.urls = new Map();          // hash -> object URL
    this.downloads = new Map();     // hash -> {chunks, size, resolve, reject, onProgress}
    this.pinned = new Set();
    this.budget = Number(localStorage.getItem("dionysus.cacheBudget")) || DEFAULT_BUDGET;
    net.frameHandlers.add((frame) => this.onFrame(frame));
  }

  async open() {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    this.db = await idb(req);
  }

  tx(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async inventory() {
    return (await idb(this.tx("readonly").getAllKeys())).map(String);
  }

  async read(hash) {
    const rec = await idb(this.tx("readonly").get(hash));
    if (rec) {
      rec.used = Date.now();
      this.tx("readwrite").put(rec, hash);
    }
    return rec ? new Uint8Array(rec.bytes) : null;
  }

  async write(hash, bytes) {
    await idb(this.tx("readwrite").put({ bytes: bytes.buffer, size: bytes.length, used: Date.now() }, hash));
    this.evict().catch(() => {});
  }

  async evict() {
    const store = this.tx("readonly");
    const [keys, recs] = await Promise.all([idb(store.getAllKeys()), idb(store.getAll())]);
    let total = recs.reduce((n, r) => n + r.size, 0);
    if (total <= this.budget) return;
    const order = keys.map((k, i) => ({ k: String(k), r: recs[i] })).sort((a, b) => a.r.used - b.r.used);
    const del = this.tx("readwrite");
    for (const { k, r } of order) {
      if (total <= this.budget) break;
      if (this.pinned.has(k)) continue;
      del.delete(k);
      total -= r.size;
    }
  }

  async purge(hash) {
    await idb(this.tx("readwrite").delete(hash));
    this.keys.delete(hash);
    this.plain.delete(hash);
    if (this.urls.has(hash)) URL.revokeObjectURL(this.urls.get(hash));
    this.urls.delete(hash);
  }

  setKeys(keys) {
    for (const [h, k] of Object.entries(keys || {})) this.keys.set(h, k);
  }

  // ---------------------------------------------------------------- transfers on the bulk channel

  download(file, onProgress) {
    if (this.downloads.has(file.hash)) return this.downloads.get(file.hash).promise;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.downloads.set(file.hash, { file, chunks: new Uint8Array(file.size_bytes), got: 0, resolve, reject, onProgress, promise });
    this.net.send({ type: "bulk_get", hash: file.hash, offset: 0 });
    return promise;
  }

  async onFrame(frame) {
    const kind = frame[0];
    const hash = hex(frame.subarray(1, 33));
    const offset = Number(new DataView(frame.buffer, frame.byteOffset + 33, 8).getBigUint64(0));
    const d = this.downloads.get(hash);
    if (!d) return;
    if (kind === 1) {
      const payload = frame.subarray(41);
      if (offset + payload.length > d.chunks.length) {
        const bigger = new Uint8Array(offset + payload.length);
        bigger.set(d.chunks);
        d.chunks = bigger;
      }
      d.chunks.set(payload, offset);
      d.got += payload.length;
      d.onProgress?.(payload.length);
    } else if (kind === 2) {
      this.downloads.delete(hash);
      const bytes = d.chunks.subarray(0, offset);
      const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
      if (digest !== d.file.cipher_hash) {
        d.reject(new Error(`file ${hash.slice(0, 8)} arrived damaged`));
        return;
      }
      await this.write(hash, bytes);
      d.resolve();
    } else {
      this.downloads.delete(hash);
      d.reject(new Error(new TextDecoder().decode(frame.subarray(41)) || "transfer failed"));
    }
  }

  // ---------------------------------------------------------------- opening files

  plaintext(hash) {
    if (!this.plain.has(hash)) {
      const p = this.decrypt(hash);
      this.plain.set(hash, p);
      p.catch(() => this.plain.delete(hash));
    }
    return this.plain.get(hash);
  }

  async decrypt(hash) {
    const keyB64 = this.keys.get(hash);
    if (!keyB64) throw new Error("no key for that file yet");
    const served = await this.read(hash);
    if (!served) throw new Error("that file is not cached");
    if (!crypto.subtle) throw new Error("this page needs a secure context (https, or localhost) to open files");
    const magic = new TextDecoder().decode(served.subarray(0, 4));
    if (magic !== "DNYF" || served[4] !== 1) throw new Error("unknown file format");
    const compressed = served[5] & 1;
    const size = new DataView(served.buffer, served.byteOffset + 6, 4).getUint32(0);
    const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const parts = [];
    let pos = 10, i = 0, total = 0;
    while (pos < served.length) {
      const sealed = served.subarray(pos, pos + size + 16);
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, BigInt(i));
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed));
      parts.push(plain);
      total += plain.length;
      pos += sealed.length;
      i++;
    }
    let body = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { body.set(p, at); at += p.length; }
    if (compressed) {
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"));
      body = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return body;
  }

  async text(hash) {
    return new TextDecoder().decode(await this.plaintext(hash));
  }

  async json(hash) {
    return JSON.parse(await this.text(hash));
  }

  async url(hash, mime) {
    if (!this.urls.has(hash)) {
      const bytes = await this.plaintext(hash);
      this.urls.set(hash, URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" })));
    }
    return this.urls.get(hash);
  }
}
