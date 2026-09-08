import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, CANONICALIZATION_VERSION } from "./canonical-json.js";

/**
 * Salted content hashing (architecture §8 "Leaf hashing").
 * Every credential gets a random salt so anchored hashes cannot be brute-forced
 * from low-entropy claim guesses. The salt is stored off-chain, never exposed
 * through any API or UI, and prepended to the canonical claim bytes.
 *
 * hashAlg is recorded per credential (crypto-agility, architecture §8) —
 * algorithms are configuration, never operator-selectable.
 */
export const CONTENT_HASH_ALG = "SHA-256";

export function generateSaltHex(): string {
  return randomBytes(32).toString("hex");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeContentHash(
  claims: unknown,
  saltHex: string,
): { hash: string; alg: typeof CONTENT_HASH_ALG; canonicalization: string } {
  const salt = Buffer.from(saltHex, "hex");
  const payload = Buffer.from(canonicalJson(claims), "utf8");
  return {
    hash: createHash("sha256").update(salt).update(payload).digest("hex"),
    alg: CONTENT_HASH_ALG,
    canonicalization: CANONICALIZATION_VERSION,
  };
}
