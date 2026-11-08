// SHA-256 and AES-GCM decryption in plain JavaScript, for pages that are
// not a secure context.
//
// Browsers expose Web Crypto (crypto.subtle) only on a secure page: https,
// localhost or 127.0.0.1. A server reached over plain http at a LAN
// address (http://192.168.1.20:8150/) is not one, so the client could not
// check or open the files it downloads there. sha256Hex and openSealed use
// Web Crypto when it is there and fall back to this code when it is not.
//
// What the fallback gives up is not here but in the transport: a page that
// needs it was loaded over plain http, so its sign-in and the per-file keys
// crossed the network unencrypted, and anyone on that network could read
// them or change the page. This code only makes the client work there.
//
// Sources: FIPS 180-4 (SHA-256), FIPS 197 (AES), NIST SP 800-38D (GCM).
// The GHASH multiply uses Shoup's 4-bit tables, as in mbed TLS's gcm.c.
// This code only decrypts and makes no attempt at constant time: a page
// that needs it has already sent its keys in the clear.

// The SHA-256 round constants (FIPS 180-4, 4.2.2).
const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// The SHA-256 starting hash (FIPS 180-4, 5.3.3).
const SHA256_START = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_BLOCK_BYTES = 64;
const SHA256_LENGTH_BYTES = 8;

const AES_BLOCK_BYTES = 16;

// The AES field polynomial, x^8 + x^4 + x^3 + x + 1, and the S-box's
// affine constant (FIPS 197, 5.1.1).
const AES_POLYNOMIAL = 0x11b;
const AES_AFFINE = 0x63;

// GCM: the nonce length this code takes (the only one the server uses),
// the tag length, and the reduction for each 4-bit remainder in GHASH
// (mbed TLS's last4 table).
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const GHASH_REDUCE = new Uint32Array([
  0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
  0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
]);

// The AES tables, built once when the module loads: the S-box, the four
// round tables that fold SubBytes, ShiftRows and MixColumns into lookups,
// and the round constants.
const AES_TABLES = buildAesTables();

/**
 * An AES-GCM key, for opening sealed chunks.
 *
 * It uses Web Crypto when the page has it and this module's own code when
 * it does not. Make one with GcmKey.create.
 */
export class GcmKey {
  /**
   * Hold a key. Use GcmKey.create instead.
   *
   * @param {CryptoKey|null} webKey the Web Crypto key, or null without it
   * @param {SoftGcm|null} softKey this module's key, or null with Web
   *   Crypto
   */
  constructor(webKey, softKey) {
    this.webKey = webKey;
    this.softKey = softKey;
  }

  /**
   * Make a key from its raw bytes.
   *
   * @param {Uint8Array} raw the key: 16, 24 or 32 bytes
   * @returns {Promise<GcmKey>} the key
   */
  static async create(raw) {
    let ret = null;

    // Prefer Web Crypto when the page has it.
    if (hasWebCrypto()) {
      ret = new GcmKey(
        await crypto.subtle.importKey(
          "raw",
          raw,
          "AES-GCM",
          false,
          ["decrypt"],
        ),
        null,
      );
    } else {
      ret = new GcmKey(null, new SoftGcm(raw));
    }

    return ret;
  }

  /**
   * Open one sealed chunk: check its tag and decrypt it.
   *
   * @param {Uint8Array} iv the 12-byte nonce
   * @param {Uint8Array} sealed the ciphertext followed by its 16-byte tag
   * @returns {Promise<Uint8Array>} the plaintext
   * @throws {Error} when the tag does not match (Web Crypto throws its own
   *   OperationError instead)
   */
  async open(iv, sealed) {
    let ret = null;

    // Decrypt with whichever key this is.
    if (this.webKey !== null) {
      ret = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          this.webKey,
          sealed,
        ),
      );
    } else {
      ret = this.softKey.open(iv, sealed);
    }

    return ret;
  }
}

/**
 * AES-GCM decryption in plain JavaScript (NIST SP 800-38D), for a 12-byte
 * nonce and no additional data.
 */
export class SoftGcm {
  /**
   * Expand the key and build the GHASH table for it.
   *
   * @param {Uint8Array} raw the key: 16, 24 or 32 bytes
   * @throws {RangeError} when the key is another length
   */
  constructor(raw) {
    const zero = new Uint32Array(4);

    // Room for the work of each block, kept so blocks allocate nothing.
    this.state = new Uint32Array(4);
    this.next = new Uint32Array(4);
    this.product = new Uint32Array(4);

    // Expand the key, then hash key H = AES(0) and its table.
    this.roundKeys = expandAesKey(raw);
    this.rounds = (this.roundKeys.length / 4) - 1;
    this.hashTable = buildGhashTable(
      this.encryptWords(zero, new Uint32Array(4)),
    );
  }

  /**
   * Open one sealed chunk: check its tag, then decrypt it.
   *
   * @param {Uint8Array} iv the 12-byte nonce
   * @param {Uint8Array} sealed the ciphertext followed by its 16-byte tag
   * @returns {Uint8Array} the plaintext
   * @throws {Error} when the tag does not match, the nonce is another
   *   length, or the chunk is shorter than a tag
   */
  open(iv, sealed) {
    const length = sealed.length - GCM_TAG_BYTES;
    const counter = new Uint32Array(4);
    let difference = 0;

    // Check the inputs.
    if (iv.length !== GCM_IV_BYTES) {
      throw new Error(`AES-GCM needs a ${GCM_IV_BYTES}-byte nonce`);
    }
    if (length < 0) {
      throw new Error("the sealed chunk is shorter than its tag");
    }
    const cipher = sealed.subarray(0, length);
    const tag = sealed.subarray(length);

    // The first counter block is the nonce then 1 (SP 800-38D, 7.2).
    counter[0] = readWord(iv, 0);
    counter[1] = readWord(iv, 4);
    counter[2] = readWord(iv, 8);
    counter[3] = 1;

    // Check the tag before decrypting anything: AES(counter 1) XOR the
    // GHASH of the ciphertext.
    const expected = this.encryptWords(
      counter,
      new Uint32Array(4),
    );
    const hash = this.ghash(cipher);
    for (let i = 0; i < 4; i++) {
      expected[i] ^= hash[i];
    }
    for (let i = 0; i < GCM_TAG_BYTES; i++) {
      difference |= tag[i] ^ ((expected[i >> 2] >>> (24 - 8 * (i & 3))) &
        0xff);
    }
    if (difference !== 0) {
      throw new Error("the sealed chunk failed its check (wrong key, or " +
        "damaged)");
    }

    return this.counterMode(cipher, counter);
  }

  /**
   * Decrypt in counter mode, starting from the counter after the first.
   *
   * @param {Uint8Array} cipher the ciphertext
   * @param {Uint32Array} first the first counter block (left unchanged)
   * @returns {Uint8Array} the plaintext
   */
  counterMode(cipher, first) {
    const ret = new Uint8Array(cipher.length);
    const counter = Uint32Array.from(first);
    const stream = new Uint32Array(4);
    let position = 0;

    // XOR each block with AES of the next counter (32-bit increment).
    while (position < cipher.length) {
      counter[3] = (counter[3] + 1) >>> 0;
      this.encryptWords(counter, stream);
      const end = Math.min(position + AES_BLOCK_BYTES, cipher.length);
      for (let i = position; i < end; i++) {
        const k = i - position;
        ret[i] = cipher[i] ^ ((stream[k >> 2] >>> (24 - 8 * (k & 3))) &
          0xff);
      }
      position = end;
    }

    return ret;
  }

  /**
   * GHASH over the ciphertext, with no additional data (SP 800-38D, 6.4).
   *
   * @param {Uint8Array} cipher the ciphertext
   * @returns {Uint32Array} the hash, as four big-endian words
   */
  ghash(cipher) {
    const ret = new Uint32Array(4);
    const block = new Uint8Array(AES_BLOCK_BYTES);
    const bits = cipher.length * 8;
    let position = 0;

    // Fold in each whole block, then the last part padded with zeros.
    while (position + AES_BLOCK_BYTES <= cipher.length) {
      for (let i = 0; i < 4; i++) {
        ret[i] ^= readWord(cipher, position + 4 * i);
      }
      ghashMultiply(ret, this.hashTable, this.product);
      position += AES_BLOCK_BYTES;
    }
    if (position < cipher.length) {
      block.set(cipher.subarray(position));
      for (let i = 0; i < 4; i++) {
        ret[i] ^= readWord(block, 4 * i);
      }
      ghashMultiply(ret, this.hashTable, this.product);
    }

    // Fold in the lengths in bits: none of additional data, then the
    // ciphertext's.
    ret[2] ^= Math.floor(bits / 0x100000000);
    ret[3] ^= bits >>> 0;
    ghashMultiply(ret, this.hashTable, this.product);

    return ret;
  }

  /**
   * Encrypt one block with the expanded key (FIPS 197, 5.1).
   *
   * @param {Uint32Array} input the block, as four big-endian words
   * @param {Uint32Array} output where the encrypted block goes, as four
   *   big-endian words (not input)
   * @returns {Uint32Array} output
   */
  encryptWords(input, output) {
    const ret = output;
    const keys = this.roundKeys;
    const box = AES_TABLES.substitution;
    const last = 4 * this.rounds;
    const state = this.state;

    // Add the first round key, then the full rounds, then the last round,
    // which has no MixColumns: the S-box alone.
    for (let i = 0; i < 4; i++) {
      state[i] = input[i] ^ keys[i];
    }
    for (let round = 1; round < this.rounds; round++) {
      fullRound(state, this.next, keys, 4 * round);
    }
    for (let i = 0; i < 4; i++) {
      ret[i] = lastRoundWord(
        box,
        state[i],
        state[(i + 1) & 3],
        state[(i + 2) & 3],
        state[(i + 3) & 3],
      ) ^ keys[last + i];
    }

    return ret;
  }
}

/**
 * Whether this page has Web Crypto (it does only in a secure context).
 *
 * @returns {boolean} true when crypto.subtle is there
 */
export function hasWebCrypto() {
  return (
    (globalThis.crypto !== undefined) &&
    (globalThis.crypto.subtle !== undefined) &&
    (globalThis.crypto.subtle !== null)
  );
}

/**
 * The SHA-256 of some bytes, as lowercase hex.
 *
 * Uses Web Crypto when the page has it, and sha256 below when it does not.
 *
 * @param {Uint8Array} bytes the bytes to hash
 * @returns {Promise<string>} the hash, 64 hex digits
 */
export async function sha256Hex(bytes) {
  let digest = null;

  // Hash with whichever the page has.
  if (hasWebCrypto()) {
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  } else {
    digest = sha256(bytes);
  }

  return Array.from(
    digest,
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The SHA-256 of some bytes, in plain JavaScript (FIPS 180-4, 6.2).
 *
 * @param {Uint8Array} bytes the bytes to hash
 * @returns {Uint8Array} the 32-byte hash
 */
export function sha256(bytes) {
  const ret = new Uint8Array(32);
  const state = Uint32Array.from(SHA256_START);
  const schedule = new Uint32Array(64);
  const whole = bytes.length - (bytes.length % SHA256_BLOCK_BYTES);
  let position = 0;

  // Hash the whole blocks in place.
  while (position < whole) {
    sha256Block(state, schedule, bytes, position);
    position += SHA256_BLOCK_BYTES;
  }

  // Pad the rest: a 1 bit, zeros, then the length in bits as 64 bits.
  let tailLength = (bytes.length - whole) + 1 + SHA256_LENGTH_BYTES;
  if (tailLength > SHA256_BLOCK_BYTES) {
    tailLength = 2 * SHA256_BLOCK_BYTES;
  } else {
    tailLength = SHA256_BLOCK_BYTES;
  }
  const tail = new Uint8Array(tailLength);
  const bits = bytes.length * 8;
  tail.set(bytes.subarray(whole));
  tail[bytes.length - whole] = 0x80;
  writeWord(tail, tailLength - 8, Math.floor(bits / 0x100000000));
  writeWord(tail, tailLength - 4, bits >>> 0);
  for (let i = 0; i < tailLength; i += SHA256_BLOCK_BYTES) {
    sha256Block(state, schedule, tail, i);
  }

  // Write the state out big-endian.
  for (let i = 0; i < 8; i++) {
    writeWord(ret, 4 * i, state[i]);
  }

  return ret;
}

/**
 * Hash one 64-byte block into the state (FIPS 180-4, 6.2.2).
 *
 * @param {Uint32Array} state the eight hash words, updated in place
 * @param {Uint32Array} schedule room for the 64-word message schedule
 * @param {Uint8Array} bytes the message
 * @param {number} at where the block starts in the message
 */
function sha256Block(state, schedule, bytes, at) {
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];

  // The message schedule.
  for (let i = 0; i < 16; i++) {
    schedule[i] = readWord(bytes, at + 4 * i);
  }
  for (let i = 16; i < 64; i++) {
    const early = schedule[i - 15];
    const late = schedule[i - 2];
    const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^
      (early >>> 3);
    const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^
      (late >>> 10);
    schedule[i] = schedule[i - 16] + sigma0 + schedule[i - 7] + sigma1;
  }

  // The 64 rounds. The single letters are the standard's working
  // variables.
  for (let i = 0; i < 64; i++) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^
      rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const first = (h + sum1 + choose + SHA256_ROUND[i] + schedule[i]) | 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^
      rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const second = (sum0 + majority) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + first) | 0;
    d = c;
    c = b;
    b = a;
    a = (first + second) | 0;
  }

  // Add the block's result into the state.
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

/**
 * Build the AES tables from the field arithmetic (FIPS 197, 5.1.1 and
 * 5.1.3), so no 256-entry literals are needed.
 *
 * @returns {{substitution: Uint8Array, round: Uint32Array[],
 *   constants: Uint32Array}} the tables
 */
function buildAesTables() {
  const ret = {
    substitution: new Uint8Array(256),
    round:        [
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
    ],
    constants:    new Uint32Array(15),
  };
  const powers = new Uint8Array(256);
  const logarithms = new Uint8Array(256);
  let value = 1;

  // Powers and logarithms of the generator 3, for inverses.
  for (let i = 0; i < 255; i++) {
    powers[i] = value;
    logarithms[value] = i;
    value ^= double(value);
  }

  // The S-box: the inverse, then the affine transform.
  for (let i = 0; i < 256; i++) {
    let inverse = 0;
    if (i !== 0) {
      inverse = powers[(255 - logarithms[i]) % 255];
    }
    ret.substitution[i] = inverse ^ rotateByte(inverse, 1) ^
      rotateByte(inverse, 2) ^ rotateByte(inverse, 3) ^
      rotateByte(inverse, 4) ^ AES_AFFINE;
  }

  // The round tables: the S-box byte times the MixColumns column
  // (2, 1, 1, 3), then that word rotated for each row.
  for (let i = 0; i < 256; i++) {
    const substituted = ret.substitution[i];
    const word = (
      (double(substituted) << 24) |
      (substituted << 16) |
      (substituted << 8) |
      (double(substituted) ^ substituted)
    ) >>> 0;
    ret.round[0][i] = word;
    ret.round[1][i] = rotateRight(word, 8);
    ret.round[2][i] = rotateRight(word, 16);
    ret.round[3][i] = rotateRight(word, 24);
  }

  // The round constants: successive powers of 2, in the top byte.
  value = 1;
  for (let i = 1; i < ret.constants.length; i++) {
    ret.constants[i] = (value << 24) >>> 0;
    value = double(value);
  }

  return ret;
}

/**
 * Expand an AES key into its round keys (FIPS 197, 5.2).
 *
 * @param {Uint8Array} raw the key: 16, 24 or 32 bytes
 * @returns {Uint32Array} the round keys, four words per round plus one
 * @throws {RangeError} when the key is another length
 */
function expandAesKey(raw) {
  const words = raw.length / 4;
  let ret = null;

  // Check the length and size the schedule (Nr = Nk + 6).
  if ((raw.length !== 16) && (raw.length !== 24) && (raw.length !== 32)) {
    throw new RangeError("an AES key is 16, 24 or 32 bytes");
  }
  ret = new Uint32Array(4 * (words + 7));

  // The key itself, then each word from the one a key length back.
  for (let i = 0; i < words; i++) {
    ret[i] = readWord(raw, 4 * i);
  }
  for (let i = words; i < ret.length; i++) {
    let temporary = ret[i - 1];
    if (i % words === 0) {
      temporary = substituteWord(rotateRight(temporary, 24)) ^
        AES_TABLES.constants[i / words];
    } else if ((words > 6) && (i % words === 4)) {
      temporary = substituteWord(temporary);
    } else {
      // The other words take the previous word as it is.
      temporary = ret[i - 1];
    }
    ret[i] = ret[i - words] ^ temporary;
  }

  return ret;
}

/**
 * Build the 4-bit GHASH table for a hash key: the products of H with
 * every 4-bit value (mbed TLS's gcm_gen_table).
 *
 * @param {Uint32Array} key the hash key H, as four big-endian words
 * @returns {Uint32Array} 16 entries of four words each
 */
function buildGhashTable(key) {
  const ret = new Uint32Array(64);
  const value = Uint32Array.from(key);

  // Entry 8 is H; entries 4, 2 and 1 are H halved again and again in the
  // field, which in GCM's reflected bit order is a shift right with the
  // reduction folded into the top.
  ret.set(value, 4 * 8);
  for (let i = 4; i > 0; i >>= 1) {
    const carry = value[3] & 1;
    value[3] = (value[3] >>> 1) | (value[2] << 31);
    value[2] = (value[2] >>> 1) | (value[1] << 31);
    value[1] = (value[1] >>> 1) | (value[0] << 31);
    value[0] = value[0] >>> 1;
    if (carry === 1) {
      value[0] ^= 0xe1000000;
    }
    ret.set(value, 4 * i);
  }

  // The rest are sums (XORs) of those four.
  for (let i = 2; i <= 8; i *= 2) {
    for (let j = 1; j < i; j++) {
      for (let k = 0; k < 4; k++) {
        ret[4 * (i + j) + k] = ret[4 * i + k] ^ ret[4 * j + k];
      }
    }
  }

  return ret;
}

/**
 * Multiply a GHASH value by H in place, a nibble at a time from the last
 * byte (mbed TLS's gcm_mult).
 *
 * @param {Uint32Array} value the value, as four big-endian words
 * @param {Uint32Array} table the hash key's 4-bit table
 * @param {Uint32Array} product room for the product, four words
 */
function ghashMultiply(value, table, product) {
  let low = value[3] & 0xf;

  // Start from the last nibble's entry.
  product.set(table.subarray(4 * low, 4 * low + 4));

  // Then for every other nibble, from the end: shift the product right
  // four bits, reduce, and add that nibble's entry.
  for (let i = 15; i >= 0; i--) {
    const byte = (value[i >> 2] >>> (24 - 8 * (i & 3))) & 0xff;
    low = byte & 0xf;
    const high = byte >>> 4;
    if (i !== 15) {
      shiftNibble(product);
      addEntry(product, table, low);
    }
    shiftNibble(product);
    addEntry(product, table, high);
  }

  value.set(product);
}

/**
 * Shift a GHASH product right four bits and fold the bits shifted out back
 * in with the reduction table.
 *
 * @param {Uint32Array} product the product, as four big-endian words
 */
function shiftNibble(product) {
  const remainder = product[3] & 0xf;

  // Shift across the words, then reduce into the top.
  product[3] = (product[3] >>> 4) | (product[2] << 28);
  product[2] = (product[2] >>> 4) | (product[1] << 28);
  product[1] = (product[1] >>> 4) | (product[0] << 28);
  product[0] = (product[0] >>> 4) ^ (GHASH_REDUCE[remainder] << 16);
}

/**
 * Add (XOR) one entry of the GHASH table into a product.
 *
 * @param {Uint32Array} product the product, as four big-endian words
 * @param {Uint32Array} table the hash key's 4-bit table
 * @param {number} index the entry, 0 to 15
 */
function addEntry(product, table, index) {
  // Each entry is four words.
  for (let k = 0; k < 4; k++) {
    product[k] ^= table[4 * index + k];
  }
}

/**
 * One full AES round in place: SubBytes, ShiftRows, MixColumns and
 * AddRoundKey, as one table lookup per byte.
 *
 * @param {Uint32Array} state the state, as four big-endian words
 * @param {Uint32Array} next room for the new state, four words
 * @param {Uint32Array} keys the round keys
 * @param {number} at where this round's four key words start
 */
function fullRound(state, next, keys, at) {
  const [table0, table1, table2, table3] = AES_TABLES.round;

  // Each new word takes a byte from each old word, along its diagonal.
  for (let i = 0; i < 4; i++) {
    next[i] = table0[state[i] >>> 24] ^
      table1[(state[(i + 1) & 3] >>> 16) & 0xff] ^
      table2[(state[(i + 2) & 3] >>> 8) & 0xff] ^
      table3[state[(i + 3) & 3] & 0xff] ^
      keys[at + i];
  }
  state.set(next);
}

/**
 * One word of the last AES round: the S-box of one byte from each of four
 * state words (SubBytes and ShiftRows).
 *
 * @param {Uint8Array} box the S-box
 * @param {number} first the word the top byte comes from
 * @param {number} second the word the second byte comes from
 * @param {number} third the word the third byte comes from
 * @param {number} fourth the word the bottom byte comes from
 * @returns {number} the word, unsigned
 */
function lastRoundWord(box, first, second, third, fourth) {
  return (
    (box[first >>> 24] << 24) |
    (box[(second >>> 16) & 0xff] << 16) |
    (box[(third >>> 8) & 0xff] << 8) |
    box[fourth & 0xff]
  ) >>> 0;
}

/**
 * Put each byte of a word through the S-box (FIPS 197, SubWord).
 *
 * @param {number} word the word
 * @returns {number} the substituted word, unsigned
 */
function substituteWord(word) {
  return lastRoundWord(AES_TABLES.substitution, word, word, word, word);
}

/**
 * Multiply a byte by 2 in the AES field (FIPS 197, xtime).
 *
 * @param {number} value the byte
 * @returns {number} the product, a byte
 */
function double(value) {
  let ret = value << 1;

  // Reduce when the top bit carried out.
  if (ret > 0xff) {
    ret ^= AES_POLYNOMIAL;
  }

  return ret;
}

/**
 * Rotate a byte left.
 *
 * @param {number} value the byte
 * @param {number} count how many bits, 0 to 7
 * @returns {number} the rotated byte
 */
function rotateByte(value, count) {
  return ((value << count) | (value >>> (8 - count))) & 0xff;
}

/**
 * Rotate a 32-bit word right.
 *
 * @param {number} value the word
 * @param {number} count how many bits, 1 to 31
 * @returns {number} the rotated word, unsigned
 */
function rotateRight(value, count) {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

/**
 * Read a big-endian 32-bit word.
 *
 * @param {Uint8Array} bytes the bytes
 * @param {number} at where the word starts
 * @returns {number} the word, unsigned
 */
function readWord(bytes, at) {
  return (
    (bytes[at] << 24) |
    (bytes[at + 1] << 16) |
    (bytes[at + 2] << 8) |
    bytes[at + 3]
  ) >>> 0;
}

/**
 * Write a big-endian 32-bit word.
 *
 * @param {Uint8Array} bytes the bytes to write into
 * @param {number} at where the word goes
 * @param {number} word the word
 */
function writeWord(bytes, at, word) {
  // Most significant byte first.
  bytes[at] = word >>> 24;
  bytes[at + 1] = word >>> 16;
  bytes[at + 2] = word >>> 8;
  bytes[at + 3] = word;
}
