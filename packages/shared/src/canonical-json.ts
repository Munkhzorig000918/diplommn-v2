/**
 * Deterministic JSON serialization used for content hashing and the audit hash
 * chain. Object keys are sorted recursively; undefined values are dropped
 * (matching JSON.stringify semantics); arrays keep order.
 *
 * This is the MVP canonicalization. V2 will record the algorithm per credential
 * (crypto-agility) — the identifier for this scheme is "JCS-like/sorted-keys-v1"
 * and is stored alongside every hash so future migrations stay verifiable.
 */
export const CANONICALIZATION_VERSION = "sorted-keys-v1";

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}
