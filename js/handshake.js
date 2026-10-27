// The challenge and response codes of the WebRTC handshake: "dny1c." or "dny1r." followed by a JSON envelope,
// compressed in the zlib format (CompressionStream "deflate", which Python's zlib reads) and encoded as base64url
// without padding. The server's handshake.py is the other half; the two must agree byte for byte.

export const VERSION = 1;
export const TARGET_CHARS = 2000;
const KINDS = { c: "challenge", r: "response" };

export class CodeError extends Error {}

function toBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encode(kind, envelope) {
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  return `dny${VERSION}${kind}.` + toBase64url(await pipe(json, new CompressionStream("deflate")));
}

export async function decode(code, expect) {
  let text = String(code || "").replace(/\s+/g, "");
  if (text.includes("#join=")) text = text.split("#join=")[1];
  const m = text.match(/^dny(\d+)([a-z])\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new CodeError("That is not a Dionysus code. It should start with dny1c. (from the host) or dny1r.");
  const [, version, kind, payload] = m;
  if (Number(version) !== VERSION) throw new CodeError(`That code is version ${version}; this client understands version ${VERSION}.`);
  if (kind !== expect) throw new CodeError(`That is a ${KINDS[kind] || "different"} code, but a ${KINDS[expect]} is needed here.`);
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(await pipe(fromBase64url(payload), new DecompressionStream("deflate"))));
  } catch {
    throw new CodeError("That code is damaged or incomplete. Copy it again, all of it.");
  }
  if (!envelope || envelope.v !== VERSION || envelope.k !== kind || typeof envelope.id !== "string" || typeof envelope.sdp !== "string") {
    throw new CodeError("That code is missing its connection details; it may be damaged.");
  }
  return envelope;
}
