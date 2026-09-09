import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyMultibaseFromJwk } from "@diplommn/did";
import {
  Bitstring,
  MIN_BITSTRING_LENGTH,
  buildSignedStatusListCredential,
  buildStatusListCredential,
  createLocalP256Signer,
  isRevokedInStatusList,
  verifyCredential,
} from "../src/index.js";

describe("Bitstring", () => {
  it("round-trips set bits through encode/decode", () => {
    const bits = new Bitstring();
    bits.set(0, true);
    bits.set(7, true);
    bits.set(131_071, true);
    const decoded = Bitstring.decode(bits.encode());
    expect(decoded.get(0)).toBe(true);
    expect(decoded.get(7)).toBe(true);
    expect(decoded.get(131_071)).toBe(true);
    expect(decoded.get(1)).toBe(false);
    expect(decoded.get(42)).toBe(false);
  });

  it("uses MSB-first bit order within a byte (spec bit 0 = left-most)", () => {
    const bits = new Bitstring();
    bits.set(0, true);
    const decoded = Bitstring.decode(bits.encode());
    // Only index 0 set — nothing else in the first byte.
    for (let i = 1; i < 8; i += 1) expect(decoded.get(i)).toBe(false);
  });

  it("enforces the minimum herd-privacy size", () => {
    expect(new Bitstring(8).length).toBe(MIN_BITSTRING_LENGTH);
  });

  it("rejects out-of-range indexes", () => {
    const bits = new Bitstring();
    expect(() => bits.get(MIN_BITSTRING_LENGTH)).toThrow(/out of range/);
    expect(() => bits.set(-1, true)).toThrow(/out of range/);
  });

  it("clears bits", () => {
    const bits = new Bitstring();
    bits.set(5, true);
    bits.set(5, false);
    expect(bits.get(5)).toBe(false);
  });
});

describe("status list credential", () => {
  it("builds a spec-shaped credential and reports revocation bits", () => {
    const credential = buildStatusListCredential({
      url: "https://diplom.mn/status/1",
      issuerDid: "did:web:diplom.mn",
      revokedIndexes: [3, 77],
      now: new Date("2026-09-09T10:00:00Z"),
    });
    expect(credential.type).toEqual([
      "VerifiableCredential",
      "BitstringStatusListCredential",
    ]);
    expect(credential.credentialSubject.statusPurpose).toBe("revocation");
    expect(isRevokedInStatusList(credential, 3)).toBe(true);
    expect(isRevokedInStatusList(credential, "77")).toBe(true);
    expect(isRevokedInStatusList(credential, 4)).toBe(false);
  });

  it("signs the list and it verifies like any credential", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const signed = await buildSignedStatusListCredential(
      {
        url: "https://diplom.mn/status/1",
        issuerDid: "did:web:diplom.mn",
        revokedIndexes: [42],
      },
      createLocalP256Signer(privateKey.export({ format: "jwk" }), "issuer-1"),
    );
    const outcome = verifyCredential(signed, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(
        publicKey.export({ format: "jwk" }),
      ),
    });
    expect(outcome).toEqual({ verified: true });
    expect(isRevokedInStatusList(signed, 42)).toBe(true);
  });
});
