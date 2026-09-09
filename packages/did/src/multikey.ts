/**
 * Multikey encoding for issuer public keys (W3C Data Integrity).
 *
 * Supported key types mirror the architecture's crypto-agility requirement
 * (DataIntegrityProof, ECDSA/EdDSA): Ed25519 and ECDSA P-256. P-256 is the
 * expected production type — managed KMS offerings sign with ECC_NIST_P256
 * but generally do not offer Ed25519.
 */

/** Structural subset of a public JWK (what KeyObject.export({format:"jwk"}) yields). */
export interface PublicJwk {
  kty?: string | undefined;
  crv?: string | undefined;
  x?: string | undefined;
  y?: string | undefined;
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** multicodec varint prefixes for public keys */
const PREFIX_ED25519 = Uint8Array.from([0xed, 0x01]); // ed25519-pub (0xed)
const PREFIX_P256 = Uint8Array.from([0x80, 0x24]); // p256-pub (0x1200)

export type SupportedKeyType = "Ed25519" | "P-256";

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const x = (digits[i]! << 8) + carry;
      digits[i] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]!];
  }
  return out;
}

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

function fromBase64Url(value: string, field: string, length: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (bytes.length !== length) {
    throw new Error(`JWK field "${field}" must decode to ${length} bytes`);
  }
  return bytes;
}

/**
 * Encode a public JWK as a multibase(base58btc) Multikey string.
 * Ed25519 keys produce "z6Mk…", compressed P-256 keys produce "zDn…".
 */
export function publicKeyMultibaseFromJwk(jwk: PublicJwk): string {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    if (!jwk.x) throw new Error("Ed25519 JWK is missing \"x\"");
    const raw = fromBase64Url(jwk.x, "x", 32);
    const prefixed = new Uint8Array(PREFIX_ED25519.length + raw.length);
    prefixed.set(PREFIX_ED25519, 0);
    prefixed.set(raw, PREFIX_ED25519.length);
    return `z${base58btcEncode(prefixed)}`;
  }

  if (jwk.kty === "EC" && jwk.crv === "P-256") {
    if (!jwk.x || !jwk.y) throw new Error("P-256 JWK is missing \"x\"/\"y\"");
    const x = fromBase64Url(jwk.x, "x", 32);
    const y = fromBase64Url(jwk.y, "y", 32);
    // SEC1 compressed point: 0x02/0x03 by y parity, then the x coordinate.
    const compressed = new Uint8Array(1 + x.length);
    compressed[0] = (y[31]! & 1) === 1 ? 0x03 : 0x02;
    compressed.set(x, 1);
    const prefixed = new Uint8Array(PREFIX_P256.length + compressed.length);
    prefixed.set(PREFIX_P256, 0);
    prefixed.set(compressed, PREFIX_P256.length);
    return `z${base58btcEncode(prefixed)}`;
  }

  throw new Error(
    `Unsupported JWK (kty=${String(jwk.kty)}, crv=${String(jwk.crv)}); ` +
      "expected Ed25519 (OKP) or P-256 (EC)",
  );
}

export interface DecodedMultikey {
  type: SupportedKeyType;
  /** Ed25519: 32 raw bytes. P-256: 33-byte SEC1 compressed point. */
  publicKey: Uint8Array;
}

export function decodeMultikey(multibase: string): DecodedMultikey {
  if (!multibase.startsWith("z")) {
    throw new Error("Multikey must be multibase base58btc (\"z\" prefix)");
  }
  const bytes = base58btcDecode(multibase.slice(1));

  if (bytes[0] === 0xed && bytes[1] === 0x01 && bytes.length === 2 + 32) {
    return { type: "Ed25519", publicKey: bytes.slice(2) };
  }
  if (bytes[0] === 0x80 && bytes[1] === 0x24 && bytes.length === 2 + 33) {
    return { type: "P-256", publicKey: bytes.slice(2) };
  }
  throw new Error("Unsupported or malformed Multikey value");
}
