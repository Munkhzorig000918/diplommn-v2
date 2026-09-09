/**
 * DataIntegrityProof with the ecdsa-jcs-2019 cryptosuite (W3C Data
 * Integrity, JCS variant — chosen over the RDF variant so the open
 * stateless verifier needs no JSON-LD machinery, only deterministic JSON
 * canonicalization and WebCrypto).
 *
 * Signing input (per the JCS suites):
 *   sha256(canon(proofConfig)) || sha256(canon(document-without-proof))
 * signed with ECDSA P-256/SHA-256, proofValue = multibase base58btc(r||s).
 *
 * The verifier half lives here too — it is the reference for the Phase 2
 * open-source verifier and must stay dependency-light.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { base58btcDecode, base58btcEncode, decodeMultikey } from "@diplommn/did";
import { canonicalJson } from "@diplommn/shared";
import type { VcSigner } from "./signer.js";

export const CRYPTOSUITE = "ecdsa-jcs-2019";

export interface DataIntegrityProof {
  "@context": string[];
  type: "DataIntegrityProof";
  cryptosuite: typeof CRYPTOSUITE;
  created: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  proofValue: string;
}

export type Signed<T> = T & { proof: DataIntegrityProof };

function sha256(data: string): Buffer {
  return createHash("sha256").update(data, "utf8").digest();
}

function hashData(
  proofConfig: Omit<DataIntegrityProof, "proofValue">,
  document: Record<string, unknown>,
): Buffer {
  return Buffer.concat([
    sha256(canonicalJson(proofConfig)),
    sha256(canonicalJson(document)),
  ]);
}

export async function signCredential<
  T extends { "@context": string[]; issuer: string },
>(
  credential: T,
  signer: VcSigner,
  opts: { created?: Date } = {},
): Promise<Signed<T>> {
  if ("proof" in credential) {
    throw new Error("Credential already carries a proof");
  }
  const proofConfig: Omit<DataIntegrityProof, "proofValue"> = {
    "@context": credential["@context"],
    type: "DataIntegrityProof",
    cryptosuite: signer.cryptosuite,
    created: (opts.created ?? new Date()).toISOString(),
    verificationMethod: `${credential.issuer}#${signer.keyId}`,
    proofPurpose: "assertionMethod",
  };
  const signature = await signer.sign(
    hashData(proofConfig, credential as Record<string, unknown>),
  );
  return {
    ...credential,
    proof: { ...proofConfig, proofValue: `z${base58btcEncode(signature)}` },
  };
}

export interface VerifyOptions {
  /** Issuer public key as Multikey ("zDn…") — e.g. from the DID document. */
  publicKeyMultibase: string;
  /** Expected verificationMethod (did#keyId); rejected when different. */
  expectedVerificationMethod?: string;
}

export type VerificationOutcome =
  | { verified: true }
  | { verified: false; reason: string };

export function verifyCredential<T extends { "@context": string[] }>(
  signed: Signed<T>,
  opts: VerifyOptions,
): VerificationOutcome {
  const { proof, ...document } = signed as Signed<T> &
    Record<string, unknown>;
  if (proof?.type !== "DataIntegrityProof" || proof.cryptosuite !== CRYPTOSUITE) {
    return { verified: false, reason: "Unsupported proof type/cryptosuite" };
  }
  if (
    opts.expectedVerificationMethod &&
    proof.verificationMethod !== opts.expectedVerificationMethod
  ) {
    return { verified: false, reason: "Unexpected verification method" };
  }

  let decoded;
  try {
    decoded = decodeMultikey(opts.publicKeyMultibase);
  } catch {
    return { verified: false, reason: "Malformed issuer public key" };
  }
  if (decoded.type !== "P-256") {
    return { verified: false, reason: "ecdsa-jcs-2019 requires a P-256 key" };
  }

  let signature: Uint8Array;
  try {
    if (!proof.proofValue?.startsWith("z")) throw new Error("not multibase");
    signature = base58btcDecode(proof.proofValue.slice(1));
  } catch {
    return { verified: false, reason: "Malformed proofValue" };
  }

  const { proofValue: _dropped, ...proofConfig } = proof;
  const data = hashData(
    proofConfig as Omit<DataIntegrityProof, "proofValue">,
    document,
  );

  // Rebuild an SPKI public key from the SEC1 compressed point via JWK is
  // nontrivial without EC math; Node accepts the compressed point through
  // the DER SPKI wrapper below.
  const spki = spkiFromCompressedP256(decoded.publicKey);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  const ok = cryptoVerify(
    "sha256",
    data,
    { key, dsaEncoding: "ieee-p1363" },
    signature,
  );
  return ok ? { verified: true } : { verified: false, reason: "Signature mismatch" };
}

/** Wrap a 33-byte compressed P-256 point in a DER SubjectPublicKeyInfo. */
function spkiFromCompressedP256(point: Uint8Array): Buffer {
  if (point.length !== 33) throw new Error("Expected 33-byte compressed point");
  // SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING point }
  const header = Buffer.from([
    0x30, 0x39, // SEQUENCE, 57 bytes
    0x30, 0x13, // SEQUENCE, 19 bytes
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // 1.2.840.10045.2.1
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // prime256v1
    0x03, 0x22, 0x00, // BIT STRING, 34 bytes, 0 unused bits
  ]);
  return Buffer.concat([header, Buffer.from(point)]);
}
