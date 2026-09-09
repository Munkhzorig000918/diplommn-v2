/**
 * Signing abstraction. Production signing happens inside KMS/HSM
 * (architecture §10 — the app server never holds the private key); the
 * local P-256 signer exists for development and tests only. Both produce
 * raw IEEE P1363 (r||s) signatures so proof encoding is implementation-
 * independent.
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

export interface VcSigner {
  /** DID fragment of the issuer key, e.g. "issuer-1". */
  keyId: string;
  cryptosuite: "ecdsa-jcs-2019";
  sign(data: Uint8Array): Promise<Uint8Array>;
}

interface PrivateJwk {
  kty?: string | undefined;
  crv?: string | undefined;
}

/** DEV/TEST ONLY — a KMS-backed implementation replaces this in production. */
export function createLocalP256Signer(
  privateJwk: PrivateJwk,
  keyId: string,
): VcSigner {
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256") {
    throw new Error("Local signer requires a P-256 (EC) private JWK");
  }
  const key = createPrivateKey({ key: privateJwk as object, format: "jwk" });
  return {
    keyId,
    cryptosuite: "ecdsa-jcs-2019",
    async sign(data) {
      return new Uint8Array(
        cryptoSign("sha256", data, { key, dsaEncoding: "ieee-p1363" }),
      );
    },
  };
}
