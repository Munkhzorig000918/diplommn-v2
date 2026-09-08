import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json.js";
import { computeContentHash, generateSaltHex } from "../src/hashing.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("is order-insensitive for objects but order-sensitive for arrays", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined object values, keeps nulls", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("handles unicode (Mongolian Cyrillic) deterministically", () => {
    const s = canonicalJson({ нэр: "Батболд", зэрэг: "Бакалавр" });
    expect(s).toBe(canonicalJson({ зэрэг: "Бакалавр", нэр: "Батболд" }));
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("computeContentHash", () => {
  const claims = { degree: "Бакалавр", holder: "Д.Батболд", year: 2026 };

  it("is deterministic for identical claims + salt", () => {
    const salt = generateSaltHex();
    expect(computeContentHash(claims, salt).hash).toBe(
      computeContentHash(claims, salt).hash,
    );
  });

  it("differs when salt differs (anti-guessing property)", () => {
    const h1 = computeContentHash(claims, generateSaltHex()).hash;
    const h2 = computeContentHash(claims, generateSaltHex()).hash;
    expect(h1).not.toBe(h2);
  });

  it("differs when any claim changes", () => {
    const salt = generateSaltHex();
    const h1 = computeContentHash(claims, salt).hash;
    const h2 = computeContentHash({ ...claims, year: 2027 }, salt).hash;
    expect(h1).not.toBe(h2);
  });

  it("records algorithm and canonicalization for crypto-agility", () => {
    const r = computeContentHash(claims, generateSaltHex());
    expect(r.alg).toBe("SHA-256");
    expect(r.canonicalization).toBe("sorted-keys-v1");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
