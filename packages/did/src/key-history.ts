/**
 * Issuer key history — the off-chain record that makes "verify with the key
 * valid at issuance time" possible after rotations. did:web has no built-in
 * versioning, so this history is the single source of truth for which key
 * was allowed to sign at any moment; the DID document is derived from it.
 *
 * Rotation/m-of-n governance itself is an open architecture question
 * (gaps #27/#9 custody decisions) — this module only defines the record
 * structure and time arithmetic, not who may perform a rotation.
 */

import type { SupportedKeyType } from "./multikey.js";

export const KeyStatus = {
  /** May sign new credentials now. */
  Active: "ACTIVE",
  /** Rotated out; still valid for verifying credentials issued while active. */
  Retired: "RETIRED",
  /** Compromised; never valid, not even for past issuance dates. */
  Revoked: "REVOKED",
} as const;
export type KeyStatus = (typeof KeyStatus)[keyof typeof KeyStatus];

/** Data Integrity cryptosuite per key type (crypto-agility field). */
export const Cryptosuite = {
  Ed25519: "eddsa-rdfc-2022",
  "P-256": "ecdsa-rdfc-2019",
} as const satisfies Record<SupportedKeyType, string>;
export type Cryptosuite = (typeof Cryptosuite)[keyof typeof Cryptosuite];

export interface KeyHistoryEntry {
  /** DID fragment, e.g. "issuer-1" → did:web:diplom.mn#issuer-1 */
  keyId: string;
  type: SupportedKeyType;
  cryptosuite: Cryptosuite;
  publicKeyMultibase: string;
  /** ISO 8601 UTC instant from which this key may sign. */
  validFrom: string;
  /** ISO 8601 UTC instant after which it may no longer sign; null = open. */
  validUntil: string | null;
  status: KeyStatus;
  /** KMS/HSM key reference (ARN/ID) — never key material. Null in dev. */
  kmsKeyRef: string | null;
}

export interface KeyHistory {
  issuer: string;
  updated: string;
  keys: KeyHistoryEntry[];
}

function parseInstant(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO 8601 instant in ${field}: ${value}`);
  }
  return ms;
}

/**
 * Was `keyId` allowed to sign at instant `at`? Used by verifiers to check a
 * credential's signature against the key that was valid when it was issued.
 * Revoked keys are never valid — a compromised key can forge backdated
 * signatures, so its whole validity window is void.
 */
export function keyValidAt(
  history: KeyHistory,
  keyId: string,
  at: Date,
): boolean {
  const entry = history.keys.find((k) => k.keyId === keyId);
  if (!entry || entry.status === KeyStatus.Revoked) return false;
  const t = at.getTime();
  if (t < parseInstant(entry.validFrom, `${keyId}.validFrom`)) return false;
  if (entry.validUntil === null) return true;
  return t < parseInstant(entry.validUntil, `${keyId}.validUntil`);
}

/** All keys that were allowed to sign at instant `at` (normally 0 or 1). */
export function signingKeysAt(history: KeyHistory, at: Date): KeyHistoryEntry[] {
  return history.keys.filter((k) => keyValidAt(history, k.keyId, at));
}

/** The key new credentials must be signed with right now. */
export function activeSigningKey(history: KeyHistory): KeyHistoryEntry {
  const active = history.keys.filter(
    (k) => k.status === KeyStatus.Active && keyValidAt(history, k.keyId, new Date()),
  );
  if (active.length === 0) {
    throw new Error("Key history has no active signing key");
  }
  if (active.length > 1) {
    throw new Error(
      "Key history has multiple simultaneously active keys; a rotation must retire the previous key",
    );
  }
  return active[0]!;
}

export function assertValidHistory(history: KeyHistory): void {
  const seen = new Set<string>();
  for (const key of history.keys) {
    if (seen.has(key.keyId)) {
      throw new Error(`Duplicate keyId in history: ${key.keyId}`);
    }
    seen.add(key.keyId);
    const from = parseInstant(key.validFrom, `${key.keyId}.validFrom`);
    if (key.validUntil !== null) {
      const until = parseInstant(key.validUntil, `${key.keyId}.validUntil`);
      if (until <= from) {
        throw new Error(`${key.keyId}: validUntil must be after validFrom`);
      }
    }
    if (key.status === KeyStatus.Retired && key.validUntil === null) {
      throw new Error(`${key.keyId}: retired keys must have validUntil set`);
    }
  }
}
