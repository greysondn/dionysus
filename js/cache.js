// Content-addressed file cache. The served (encrypted) bytes are stored by their plaintext hash in IndexedDB,
// across every table and game, with nothing to invalidate. A file is opened only with the key the server
// delivers once that file is visible to this viewer. Least recently used files are evicted past a budget,
// and the current table's files are pinned.
import { hex } from "./net.js";
import { GcmKey, sha256Hex } from "./softcrypto.js";

const DB_NAME = "dionysus-cache";
const STORE = "served";
const DEFAULT_BUDGET = 512 * 1024 * 1024;

// Bulk frames (see src/dionysus_server/media.py): the kinds, where the
// offset starts (after the kind and the 32-byte hash), and the header's
// length (with the 8-byte offset).
const FRAME_CHUNK = 1;
const FRAME_END = 2;
const FRAME_OFFSET_AT = 33;
const FRAME_HEADER_BYTES = 41;

// Served files: the magic, the format version, the header's length, and
// the AES-GCM nonce and tag lengths.
const FILE_MAGIC = "DNYF";
const FILE_VERSION = 1;
const FILE_HEADER_BYTES = 10;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

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
    if (this.urls.has(hash)) this.urls.get(hash).then((u) => URL.revokeObjectURL(u), () => {});
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

  /**
   * Take one bulk frame for a download: a chunk, the end of the file, or
   * an error.
   *
   * Frames for a file this cache is not downloading are ignored.
   *
   * @param {Uint8Array} frame the frame: kind (1 byte), the plaintext hash
   *   (32 bytes), the offset in the served file (8 bytes), then the payload
   */
  async onFrame(frame) {
    const kind = frame[0];
    const hash = hex(frame.subarray(1, FRAME_OFFSET_AT));
    const offsetView = new DataView(
      frame.buffer,
      frame.byteOffset + FRAME_OFFSET_AT,
      8,
    );
    const offset = Number(offsetView.getBigUint64(0));
    const download = this.downloads.get(hash);
    let message = "";

    // Hand the frame to the download it belongs to, if there is one.
    if (download !== undefined) {
      switch (kind) {
        case FRAME_CHUNK:
          this.receiveChunk(
            download,
            offset,
            frame.subarray(FRAME_HEADER_BYTES),
          );
          break;
        case FRAME_END:
          this.downloads.delete(hash);
          await this.finishDownload(hash, download, offset);
          break;
        default:
          this.downloads.delete(hash);
          message = new TextDecoder().decode(
            frame.subarray(FRAME_HEADER_BYTES),
          );
          if (message === "") {
            message = "transfer failed";
          }
          download.reject(new Error(message));
          break;
      }
    }
  }

  /**
   * Put one chunk of a download in place, growing the buffer if the file
   * turns out longer than it said.
   *
   * @param {object} download the download the chunk belongs to
   * @param {number} offset where the chunk goes in the served file
   * @param {Uint8Array} payload the chunk's bytes
   */
  receiveChunk(download, offset, payload) {
    const end = offset + payload.length;
    let bigger = null;

    // Grow the buffer when the chunk runs past it.
    if (end > download.chunks.length) {
      bigger = new Uint8Array(end);
      bigger.set(download.chunks);
      download.chunks = bigger;
    }

    // Copy the chunk in and report the progress.
    download.chunks.set(payload, offset);
    download.got += payload.length;
    download.onProgress?.(payload.length);
  }

  /**
   * Finish a download: check the served bytes against their hash, store
   * them, and settle the download's promise.
   *
   * @param {string} hash the file's plaintext hash
   * @param {object} download the download to finish
   * @param {number} length how many bytes the served file has
   */
  async finishDownload(hash, download, length) {
    const bytes = download.chunks.subarray(0, length);
    const digest = await sha256Hex(bytes);

    // Keep the file only if it arrived whole.
    if (digest !== download.file.cipher_hash) {
      download.reject(
        new Error(`file ${hash.slice(0, 8)} arrived damaged`),
      );
    } else {
      await this.write(hash, bytes);
      download.resolve();
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
    const { parts, compressed } = await this.decryptChunks(hash);
    let body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { body.set(p, at); at += p.length; }
    if (compressed) {
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"));
      body = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return body;
  }

  /**
   * The file's plaintext as its decrypted chunks, not yet joined, and
   * whether they still need inflating.
   *
   * The served format is described in src/dionysus_server/media.py: a
   * header, then chunks sealed with AES-GCM, each with its counter as the
   * nonce. Without Web Crypto (a page that is not a secure context, such
   * as plain http at a LAN address), softcrypto.js opens the chunks.
   *
   * @param {string} hash the file's plaintext hash
   * @returns {Promise<{parts: Uint8Array[], compressed: number}>} the
   *   chunks, and 1 when they still need inflating (0 when not)
   * @throws {Error} when there is no key, the file is not cached, a chunk
   *   fails its check, or the file is not in a format this client reads
   */
  async decryptChunks(hash) {
    const keyBase64 = this.keys.get(hash);
    const parts = [];
    let served = null;
    let position = FILE_HEADER_BYTES;
    let i = 0;

    // Make sure there is a key and a cached file to open with it.
    if ((keyBase64 === undefined) || (keyBase64 === "")) {
      throw new Error("no key for that file yet");
    }
    served = await this.read(hash);
    if (served === null) {
      throw new Error("that file is not cached");
    }

    // Read the header.
    const magic = new TextDecoder().decode(served.subarray(0, 4));
    if ((magic !== FILE_MAGIC) || (served[4] !== FILE_VERSION)) {
      throw new Error("unknown file format");
    }
    const compressed = served[5] & 1;
    const size = new DataView(
      served.buffer,
      served.byteOffset + 6,
      4,
    ).getUint32(0);

    // Open each chunk with the file's key.
    const raw = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
    const key = await GcmKey.create(raw);
    while (position < served.length) {
      const sealed = served.subarray(
        position,
        position + size + GCM_TAG_BYTES,
      );
      const iv = new Uint8Array(GCM_IV_BYTES);
      new DataView(iv.buffer).setBigUint64(4, BigInt(i));
      parts.push(await key.open(iv, sealed));
      position += sealed.length;
      i++;
    }

    return { parts, compressed };
  }

  async text(hash) {
    return new TextDecoder().decode(await this.plaintext(hash));
  }

  async json(hash) {
    return JSON.parse(await this.text(hash));
  }

  /** An object URL for the file. Media (precompressed, like audio and video) goes straight from its decrypted chunks
   * into the Blob, and the plaintext is not kept beside it: a 200 MB video costs its served copy and the Blob (which
   * the browser may page to disk), not two more joined copies held for the session. */
  url(hash, mime) {
    if (!this.urls.has(hash)) {
      const p = (async () => {
        const type = mime || "application/octet-stream";
        if (this.plain.has(hash)) return URL.createObjectURL(new Blob([await this.plain.get(hash)], { type }));
        const { parts, compressed } = await this.decryptChunks(hash);
        return URL.createObjectURL(new Blob(compressed ? [await this.plaintext(hash)] : parts, { type }));
      })();
      this.urls.set(hash, p);
      p.catch(() => this.urls.delete(hash));
    }
    return this.urls.get(hash);
  }
}
