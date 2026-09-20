/**
 * A dependency-free, synchronous SHA-256.
 *
 * The canonical org-policy grammar must bundle for the browser, so the digests
 * it computes at parse time cannot come from `node:crypto`. This module is the
 * one pure implementation those definitions share. It has no imports at all —
 * not even a type import — so nothing can pull a host module in behind it.
 *
 * `sha256HexOfUtf8` must agree with Node's `createHash("sha256").update(text,
 * "utf8")` for EVERY string, including ill-formed ones: Node's UTF-8 encoder
 * replaces an unpaired surrogate with U+FFFD, and so does `encodeUtf8` below.
 * `tests/contract/sha256-pure.test.ts` pins that agreement.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

/**
 * UTF-8 encode exactly as Node's `Buffer.from(text, "utf8")` does: a valid
 * surrogate pair becomes one 4-byte sequence, and any unpaired surrogate —
 * high or low, including one at the very end of the string — becomes the
 * 3-byte encoding of U+FFFD.
 */
function encodeUtf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out[at] = code;
      at += 1;
    } else if (code < 0x800) {
      out[at] = 0xc0 | (code >> 6);
      out[at + 1] = 0x80 | (code & 0x3f);
      at += 2;
    } else if (code < 0x10000) {
      out[at] = 0xe0 | (code >> 12);
      out[at + 1] = 0x80 | ((code >> 6) & 0x3f);
      out[at + 2] = 0x80 | (code & 0x3f);
      at += 3;
    } else {
      out[at] = 0xf0 | (code >> 18);
      out[at + 1] = 0x80 | ((code >> 12) & 0x3f);
      out[at + 2] = 0x80 | ((code >> 6) & 0x3f);
      out[at + 3] = 0x80 | (code & 0x3f);
      at += 4;
    }
  }
  return out.subarray(0, at);
}

/** Lowercase hex SHA-256 of raw bytes. */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  const length = bytes.length;
  // One padded message buffer: the data, the 0x80 terminator, zeroes, and the
  // 64-bit big-endian bit length, rounded up to whole 64-byte blocks.
  const blocks = Math.floor((length + 8) / 64) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  // JavaScript numbers carry the bit length exactly far past any practical
  // input, so the high word is derived by division rather than a shift.
  const bitLength = length * 8;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const tail = padded.length - 8;
  padded[tail] = (high >>> 24) & 0xff;
  padded[tail + 1] = (high >>> 16) & 0xff;
  padded[tail + 2] = (high >>> 8) & 0xff;
  padded[tail + 3] = high & 0xff;
  padded[tail + 4] = (low >>> 24) & 0xff;
  padded[tail + 5] = (low >>> 16) & 0xff;
  padded[tail + 6] = (low >>> 8) & 0xff;
  padded[tail + 7] = low & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] =
        (((padded[p] as number) << 24) |
          ((padded[p + 1] as number) << 16) |
          ((padded[p + 2] as number) << 8) |
          (padded[p + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  let hex = "";
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    for (let shift = 28; shift >= 0; shift -= 4) {
      hex += HEX.charAt((word >>> shift) & 0xf);
    }
  }
  return hex;
}

/**
 * Lowercase hex SHA-256 of a string's UTF-8 bytes — the pure equivalent of
 * `createHash("sha256").update(text, "utf8").digest("hex")`.
 */
export function sha256HexOfUtf8(text: string): string {
  return sha256HexOfBytes(encodeUtf8(text));
}
