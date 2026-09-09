/**
 * Browser-safe primitives for the open verifier. This module (and everything
 * it pulls in) MUST stay free of Node-only APIs — no node:crypto, no Buffer,
 * no zlib. Everything here runs identically in evergreen browsers and in
 * Node ≥ 20 (WebCrypto, DecompressionStream, atob are all global).
 *
 * The canonicalization and Merkle rules deliberately mirror
 * @diplommn/shared — the two implementations must stay in lockstep.
 */

/* ---------------- canonical JSON (JCS-style, sorted keys) -------------- */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/* ---------------- bytes / hex / base64url / base58 -------------------- */

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btcDecode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (const char of text) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(`Invalid base58btc character: ${JSON.stringify(char)}`);
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      const x = bytes[i]! * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[zeros + i] = bytes[bytes.length - 1 - i]!;
  }
  return out;
}

/** Multikey ("z…") → 33-byte SEC1 compressed P-256 point. */
export function p256PointFromMultikey(multibase: string): Uint8Array {
  if (!multibase.startsWith("z")) {
    throw new Error("Multikey must be multibase base58btc (\"z\" prefix)");
  }
  const bytes = base58btcDecode(multibase.slice(1));
  if (bytes[0] === 0x80 && bytes[1] === 0x24 && bytes.length === 2 + 33) {
    return bytes.slice(2);
  }
  throw new Error("Expected a P-256 Multikey (zDn…)");
}

/* ---------------- hashing / Merkle ------------------------------------ */

/** ArrayBuffer-backed view — what WebCrypto/Blob accept in strict TS. */
type Bytes = Uint8Array<ArrayBuffer>;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as Bytes),
  );
}

function normalizeLeafHex(value: string): string {
  const lower = value.toLowerCase();
  const prefixed = lower.startsWith("0x") ? lower : `0x${lower}`;
  if (!/^0x[0-9a-f]{64}$/.test(prefixed)) {
    throw new Error("Merkle leaf must be a sha256 hex string");
  }
  return prefixed;
}

async function hashPair(a: string, b: string): Promise<string> {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const joined = new Uint8Array(64);
  joined.set(hexToBytes(lo), 0);
  joined.set(hexToBytes(hi), 32);
  return `0x${bytesToHex(await sha256(joined))}`;
}

/** Sorted-pair Merkle proof check — mirror of @diplommn/shared merkle.ts. */
export async function verifyMerkleProof(
  leaf: string,
  proof: readonly string[],
  root: string,
): Promise<boolean> {
  try {
    let current = normalizeLeafHex(leaf);
    for (const sibling of proof) {
      current = await hashPair(current, normalizeLeafHex(sibling));
    }
    return current === normalizeLeafHex(root);
  } catch {
    return false;
  }
}

/* ---------------- P-256 point decompression + signature check --------- */

const P = BigInt(
  "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const B = BigInt(
  "0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** SEC1 compressed (33B) → uncompressed (65B). p ≡ 3 (mod 4) → y = c^((p+1)/4). */
export function decompressP256(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33 || (compressed[0] !== 2 && compressed[0] !== 3)) {
    throw new Error("Not a compressed P-256 point");
  }
  const x = BigInt(`0x${bytesToHex(compressed.slice(1))}`);
  if (x >= P) throw new Error("Point x out of range");
  const a = P - 3n;
  const rhs = (((x * x) % P) * x + a * x + B) % P;
  let y = modPow(rhs, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhs) throw new Error("Point is not on the curve");
  const wantOdd = compressed[0] === 3;
  if ((y & 1n) === 1n !== wantOdd) y = P - y;

  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(hexToBytes(x.toString(16).padStart(64, "0")), 1);
  out.set(hexToBytes(y.toString(16).padStart(64, "0")), 33);
  return out;
}

/** ECDSA P-256/SHA-256 verify; signature is raw r||s (64 bytes). */
export async function verifyP256(
  compressedPoint: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    decompressP256(compressedPoint) as Bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature as Bytes,
    data as Bytes,
  );
}

/* ---------------- gzip + Bitstring Status List ------------------------ */

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read one bit (MSB-first) out of a W3C Bitstring encodedList ("u…"). */
export async function bitAt(
  encodedList: string,
  index: number,
): Promise<boolean> {
  if (!encodedList.startsWith("u")) {
    throw new Error("encodedList must be multibase base64url (\"u\" prefix)");
  }
  const bits = await gunzip(base64urlToBytes(encodedList.slice(1)));
  if (!Number.isInteger(index) || index < 0 || index >= bits.length * 8) {
    throw new Error(`Bitstring index out of range: ${index}`);
  }
  const byte = bits[Math.floor(index / 8)]!;
  return ((byte >> (7 - (index % 8))) & 1) === 1;
}
