import { describe, expect, it } from "vitest";
import {
  Cryptosuite,
  KeyStatus,
  activeSigningKey,
  buildDidDocument,
  didWebDocumentUrl,
  didWebFromDomain,
  keyValidAt,
  signingKeysAt,
  type KeyHistory,
  type KeyHistoryEntry,
} from "../src/index.js";

function key(overrides: Partial<KeyHistoryEntry>): KeyHistoryEntry {
  return {
    keyId: "issuer-1",
    type: "P-256",
    cryptosuite: Cryptosuite["P-256"],
    publicKeyMultibase: "zDnaTest",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: null,
    status: KeyStatus.Active,
    kmsKeyRef: null,
    ...overrides,
  };
}

function history(keys: KeyHistoryEntry[]): KeyHistory {
  return { issuer: "did:web:diplom.mn", updated: "2026-09-09T00:00:00Z", keys };
}

describe("didWebFromDomain", () => {
  it("maps a bare domain", () => {
    expect(didWebFromDomain("diplom.mn")).toBe("did:web:diplom.mn");
  });

  it("percent-encodes ports and lowercases", () => {
    expect(didWebFromDomain("Localhost:3000")).toBe("did:web:localhost%3A3000");
  });

  it("rejects paths and schemes", () => {
    expect(() => didWebFromDomain("https://diplom.mn")).toThrow();
    expect(() => didWebFromDomain("diplom.mn/issuer")).toThrow();
  });

  it("resolves to the well-known URL", () => {
    expect(didWebDocumentUrl("diplom.mn")).toBe(
      "https://diplom.mn/.well-known/did.json",
    );
  });
});

describe("buildDidDocument", () => {
  it("publishes active keys in verificationMethod and assertionMethod", () => {
    const doc = buildDidDocument("diplom.mn", history([key({})]));
    expect(doc.id).toBe("did:web:diplom.mn");
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.verificationMethod).toEqual([
      {
        id: "did:web:diplom.mn#issuer-1",
        type: "Multikey",
        controller: "did:web:diplom.mn",
        publicKeyMultibase: "zDnaTest",
      },
    ]);
    expect(doc.assertionMethod).toEqual(["did:web:diplom.mn#issuer-1"]);
  });

  it("keeps retired keys resolvable but not signing-capable", () => {
    const doc = buildDidDocument(
      "diplom.mn",
      history([
        key({
          keyId: "issuer-1",
          status: KeyStatus.Retired,
          validUntil: "2026-06-01T00:00:00Z",
        }),
        key({ keyId: "issuer-2", validFrom: "2026-06-01T00:00:00Z" }),
      ]),
    );
    expect(doc.verificationMethod.map((m) => m.id)).toEqual([
      "did:web:diplom.mn#issuer-1",
      "did:web:diplom.mn#issuer-2",
    ]);
    expect(doc.assertionMethod).toEqual(["did:web:diplom.mn#issuer-2"]);
  });

  it("removes revoked keys entirely", () => {
    const doc = buildDidDocument(
      "diplom.mn",
      history([
        key({ keyId: "issuer-1", status: KeyStatus.Revoked }),
        key({ keyId: "issuer-2" }),
      ]),
    );
    expect(doc.verificationMethod.map((m) => m.id)).toEqual([
      "did:web:diplom.mn#issuer-2",
    ]);
  });

  it("refuses to publish without an active key", () => {
    expect(() =>
      buildDidDocument(
        "diplom.mn",
        history([
          key({ status: KeyStatus.Retired, validUntil: "2026-06-01T00:00:00Z" }),
        ]),
      ),
    ).toThrow(/no active key/);
  });

  it("refuses a history whose issuer does not match the domain", () => {
    expect(() =>
      buildDidDocument("example.com", history([key({})])),
    ).toThrow(/does not match/);
  });

  it("rejects retired keys without validUntil", () => {
    expect(() =>
      buildDidDocument("diplom.mn", history([key({ status: KeyStatus.Retired })])),
    ).toThrow(/validUntil/);
  });
});

describe("valid-at-time verification", () => {
  const rotated = history([
    key({
      keyId: "issuer-1",
      status: KeyStatus.Retired,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2026-06-01T00:00:00Z",
    }),
    key({ keyId: "issuer-2", validFrom: "2026-06-01T00:00:00Z" }),
  ]);

  it("accepts the old key only inside its window", () => {
    expect(keyValidAt(rotated, "issuer-1", new Date("2026-03-01T00:00:00Z"))).toBe(true);
    expect(keyValidAt(rotated, "issuer-1", new Date("2026-07-01T00:00:00Z"))).toBe(false);
    expect(keyValidAt(rotated, "issuer-1", new Date("2025-12-31T23:59:59Z"))).toBe(false);
  });

  it("selects the signing key for a given instant across rotation", () => {
    expect(
      signingKeysAt(rotated, new Date("2026-03-01T00:00:00Z")).map((k) => k.keyId),
    ).toEqual(["issuer-1"]);
    expect(
      signingKeysAt(rotated, new Date("2026-07-01T00:00:00Z")).map((k) => k.keyId),
    ).toEqual(["issuer-2"]);
  });

  it("treats revoked keys as never valid, even for past instants", () => {
    const compromised = history([
      key({ keyId: "issuer-1", status: KeyStatus.Revoked }),
      key({ keyId: "issuer-2", validFrom: "2026-06-01T00:00:00Z" }),
    ]);
    expect(keyValidAt(compromised, "issuer-1", new Date("2026-03-01T00:00:00Z"))).toBe(false);
  });

  it("returns the single active key and rejects ambiguity", () => {
    expect(activeSigningKey(rotated).keyId).toBe("issuer-2");
    expect(() =>
      activeSigningKey(
        history([key({ keyId: "issuer-1" }), key({ keyId: "issuer-2" })]),
      ),
    ).toThrow(/multiple/);
  });
});
