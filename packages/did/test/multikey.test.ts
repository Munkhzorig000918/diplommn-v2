import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base58btcDecode,
  base58btcEncode,
  decodeMultikey,
  publicKeyMultibaseFromJwk,
} from "../src/multikey.js";

describe("base58btc", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 0, 255, 1, 128, 42, 0, 7]);
    expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes);
  });

  it("preserves leading zero bytes as '1' characters", () => {
    const bytes = Uint8Array.from([0, 0, 0, 1]);
    const encoded = base58btcEncode(bytes);
    expect(encoded.startsWith("111")).toBe(true);
    expect(base58btcDecode(encoded)).toEqual(bytes);
  });

  it("rejects invalid characters", () => {
    expect(() => base58btcDecode("0OIl")).toThrow(/Invalid base58btc/);
  });
});

describe("publicKeyMultibaseFromJwk", () => {
  it("encodes Ed25519 keys with the z6Mk prefix", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const multibase = publicKeyMultibaseFromJwk(
      publicKey.export({ format: "jwk" }),
    );
    expect(multibase.startsWith("z6Mk")).toBe(true);

    const decoded = decodeMultikey(multibase);
    expect(decoded.type).toBe("Ed25519");
    expect(decoded.publicKey).toHaveLength(32);
  });

  it("encodes P-256 keys with the zDn prefix and correct point parity", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const multibase = publicKeyMultibaseFromJwk(jwk);
    expect(multibase.startsWith("zDn")).toBe(true);

    const decoded = decodeMultikey(multibase);
    expect(decoded.type).toBe("P-256");
    expect(decoded.publicKey).toHaveLength(33);

    const y = new Uint8Array(Buffer.from(jwk.y!, "base64url"));
    const expectedParity = (y[31]! & 1) === 1 ? 0x03 : 0x02;
    expect(decoded.publicKey[0]).toBe(expectedParity);
    expect(Buffer.from(decoded.publicKey.slice(1)).toString("base64url")).toBe(
      jwk.x,
    );
  });

  it("rejects unsupported key types", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    expect(() =>
      publicKeyMultibaseFromJwk(publicKey.export({ format: "jwk" })),
    ).toThrow(/Unsupported JWK/);
  });

  it("rejects malformed multikey values", () => {
    expect(() => decodeMultikey("abc")).toThrow(/multibase/);
    expect(() => decodeMultikey(`z${base58btcEncode(Uint8Array.from([1, 2, 3]))}`)).toThrow(
      /malformed/,
    );
  });
});
