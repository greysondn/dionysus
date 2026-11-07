// How long an animated image runs, read from its own frame timings: animated WebP, APNG and GIF. Browsers give a
// page no "ended" event for an animated image (and Safari lacks the ImageDecoder API), so a cue reads the file.

const MIN_FRAME_MS = 100;    // browsers show a frame of 10 ms or less for 100 ms, so timings below that are raised

const frame = (ms) => (ms <= 10 ? MIN_FRAME_MS : ms);

/** {ms, plays} for an animated image: one pass in milliseconds, and how many passes it plays (0: forever). Null for
 * a still image, or a file this cannot read. */
export function animationOf(bytes) {
  try {
    const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return webp(bytes, ascii);
    if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return apng(bytes, ascii);
    if (ascii(0, 4) === "GIF8") return gif(bytes);
  } catch { /* a damaged file is a still image */ }
  return null;
}

// RIFF chunks: ANIM holds the loop count, each ANMF frame its duration (24 bits, little-endian, at byte 12).
function webp(b, ascii) {
  let at = 12, ms = 0, frames = 0, plays = 0;
  while (at + 8 <= b.length) {
    const kind = ascii(at, 4), size = b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24);
    const data = at + 8;
    if (kind === "ANIM") plays = b[data + 4] | (b[data + 5] << 8);
    if (kind === "ANMF") { ms += frame(b[data + 12] | (b[data + 13] << 8) | (b[data + 14] << 16)); frames++; }
    at = data + size + (size & 1);
  }
  return frames > 1 ? { ms, plays } : null;
}

// PNG chunks: acTL makes it animated and holds the play count, each fcTL a frame's delay as a fraction of a second.
function apng(b, ascii) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8, ms = 0, frames = 0, plays = 0, animated = false;
  while (at + 8 <= b.length) {
    const size = view.getUint32(at), kind = ascii(at + 4, 4), data = at + 8;
    if (kind === "acTL") { animated = true; plays = view.getUint32(data + 4); }
    if (kind === "fcTL") {
      const num = view.getUint16(data + 20), den = view.getUint16(data + 22) || 100;
      ms += frame((num / den) * 1000);
      frames++;
    }
    if (kind === "IEND") break;
    at = data + size + 4;
  }
  return animated && frames > 1 ? { ms, plays } : null;
}

// GIF blocks: a graphic control extension gives the next frame's delay in hundredths of a second, and the NETSCAPE2.0
// application extension the loop count (no extension: it plays once).
function gif(b) {
  const skipSubBlocks = (at) => { while (b[at]) at += b[at] + 1; return at + 1; };
  let at = 13, ms = 0, frames = 0, plays = 1, delay = 0;
  if (b[10] & 0x80) at += 3 * (1 << ((b[10] & 7) + 1));
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = b[at + 1];
      if (label === 0xf9) delay = (b[at + 4] | (b[at + 5] << 8)) * 10;
      if (label === 0xff && String.fromCharCode(...b.subarray(at + 3, at + 14)) === "NETSCAPE2.0") plays = b[at + 16] | (b[at + 17] << 8);
      at = skipSubBlocks(at + 2);
    } else if (block === 0x2c) {
      ms += frame(delay);
      frames++;
      delay = 0;
      const packed = b[at + 9];
      at += 10;
      if (packed & 0x80) at += 3 * (1 << ((packed & 7) + 1));
      at = skipSubBlocks(at + 1);
    } else {
      break;
    }
  }
  return frames > 1 ? { ms, plays } : null;
}
