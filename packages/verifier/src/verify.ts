/**
 * Open stateless verifier core (architecture §11, Phase 2). Given a proof
 * bundle (signed VC + salt + Merkle proof) and injectable fetchers, verify
 * WITHOUT trusting diplom.mn servers:
 *
 *   1. issuer signature — resolve did:web, check DataIntegrityProof;
 *   2. revocation — fetch the Bitstring Status List, verify ITS signature,
 *      read one bit;
 *   3. public proof — recompute the salted VC hash, check the Merkle proof
 *      against the root anchored on Ethereum.
 *
 * Results are exactly VALID / REVOKED / NOT_VALID / INDETERMINATE.
 * Outages are never fraud: an unreachable DID document or status list makes
 * the outcome INDETERMINATE, and a not-yet-anchored credential stays VALID
 * with the anchor check reported as PENDING ("public proof pending").
 * Tampering (signature, hash or root mismatch) is NOT_VALID.
 */
import type { DidWebDocument } from "@diplommn/did";
import {
  canonicalJson,
  sha256Hex,
  verifyMerkleProof,
} from "@diplommn/shared";
import {
  isRevokedInStatusList,
  verifyCredential,
  type DataIntegrityProof,
  type Signed,
  type StatusListCredential,
} from "@diplommn/vc";

export interface ProofBundleAnchor {
  batchId: string;
  merkleRoot: string;
  merkleProof: string[];
  chainId: number;
  contractAddress: string;
  txHash: string | null;
  blockNumber: string | null;
  status: string;
}

export interface ProofBundle {
  bundleVersion: string;
  vc: Signed<{
    "@context": string[];
    issuer: string;
    credentialStatus?: {
      statusListIndex: string;
      statusListCredential: string;
    };
  }> &
    Record<string, unknown>;
  leaf: {
    salt: string | null;
    source: "vc" | "claims";
    hashAlg: string | null;
  };
  anchor: ProofBundleAnchor | null;
}

export interface VerifierOptions {
  /** Resolve the issuer DID document; null = could not resolve. */
  resolveDidDocument: (did: string) => Promise<DidWebDocument | null>;
  /** Fetch a status list credential by URL; null = unavailable. */
  fetchStatusList?: (url: string) => Promise<Signed<StatusListCredential> | null>;
  /** Read the anchored root for a batch id; null = chain unavailable. */
  fetchAnchoredRoot?: (anchor: ProofBundleAnchor) => Promise<string | null>;
}

export type CheckOutcome = "PASS" | "FAIL" | "UNAVAILABLE" | "PENDING" | "SKIPPED";

export interface VerificationReport {
  result: "VALID" | "REVOKED" | "NOT_VALID" | "INDETERMINATE";
  checks: {
    signature: CheckOutcome;
    revocation: CheckOutcome;
    anchor: CheckOutcome;
  };
  details: string[];
}

function keyForMethod(
  didDocument: DidWebDocument,
  verificationMethod: string,
): string | null {
  const method = didDocument.verificationMethod.find(
    (m) => m.id === verificationMethod,
  );
  return method?.publicKeyMultibase ?? null;
}

export async function verifyProofBundle(
  bundle: ProofBundle,
  opts: VerifierOptions,
): Promise<VerificationReport> {
  const details: string[] = [];
  const checks: VerificationReport["checks"] = {
    signature: "FAIL",
    revocation: "SKIPPED",
    anchor: "SKIPPED",
  };

  const proof = (bundle.vc as { proof?: DataIntegrityProof }).proof;
  if (!proof || typeof bundle.vc.issuer !== "string") {
    details.push("Bundle is missing a signed credential");
    return { result: "NOT_VALID", checks, details };
  }

  // 1 — issuer signature via the DID document.
  let didDocument: DidWebDocument | null = null;
  try {
    didDocument = await opts.resolveDidDocument(bundle.vc.issuer);
  } catch {
    didDocument = null;
  }
  if (!didDocument) {
    checks.signature = "UNAVAILABLE";
    details.push(`Could not resolve issuer DID ${bundle.vc.issuer}`);
    return { result: "INDETERMINATE", checks, details };
  }
  const publicKeyMultibase = keyForMethod(didDocument, proof.verificationMethod);
  if (!publicKeyMultibase) {
    details.push(
      `Verification method ${proof.verificationMethod} not in DID document`,
    );
    return { result: "NOT_VALID", checks, details };
  }
  const signatureOutcome = verifyCredential(bundle.vc, { publicKeyMultibase });
  if (!signatureOutcome.verified) {
    details.push(`Signature check failed: ${signatureOutcome.reason}`);
    return { result: "NOT_VALID", checks, details };
  }
  checks.signature = "PASS";

  // 2 — revocation via the Bitstring Status List (the list is itself a
  // signed VC; a list with a bad signature counts as unavailable, because a
  // forged list must be able to neither revoke nor un-revoke anything).
  const status = bundle.vc.credentialStatus;
  if (status && opts.fetchStatusList) {
    let list: Signed<StatusListCredential> | null = null;
    try {
      list = await opts.fetchStatusList(status.statusListCredential);
    } catch {
      list = null;
    }
    if (!list) {
      checks.revocation = "UNAVAILABLE";
      details.push("Status list unavailable — revocation state unknown");
    } else {
      const listKey = keyForMethod(
        didDocument,
        (list.proof as DataIntegrityProof).verificationMethod,
      );
      const listSignature = listKey
        ? verifyCredential(list, { publicKeyMultibase: listKey })
        : { verified: false as const, reason: "unknown verification method" };
      if (!listSignature.verified) {
        checks.revocation = "UNAVAILABLE";
        details.push("Status list signature invalid — treated as unavailable");
      } else if (isRevokedInStatusList(list, status.statusListIndex)) {
        checks.revocation = "FAIL";
        details.push("Credential is revoked");
        return { result: "REVOKED", checks, details };
      } else {
        checks.revocation = "PASS";
      }
    }
  } else if (status) {
    checks.revocation = "UNAVAILABLE";
    details.push("No status list fetcher provided");
  }

  // 3 — public proof: salted VC hash → Merkle proof → anchored root.
  if (!bundle.anchor) {
    checks.anchor = "PENDING";
    details.push("Public proof pending — credential not anchored yet");
  } else if (bundle.leaf.source !== "vc" || !bundle.leaf.salt) {
    checks.anchor = "UNAVAILABLE";
    details.push("Bundle lacks VC-bound leaf material");
  } else {
    const salt = Buffer.from(bundle.leaf.salt, "hex");
    const leaf = sha256Hex(
      Buffer.concat([salt, Buffer.from(canonicalJson(bundle.vc), "utf8")]),
    );
    if (
      !verifyMerkleProof(leaf, bundle.anchor.merkleProof, bundle.anchor.merkleRoot)
    ) {
      details.push("Merkle proof does not connect this credential to the root");
      return { result: "NOT_VALID", checks, details };
    }
    let anchoredRoot: string | null = null;
    if (opts.fetchAnchoredRoot) {
      try {
        anchoredRoot = await opts.fetchAnchoredRoot(bundle.anchor);
      } catch {
        anchoredRoot = null;
      }
    }
    if (!anchoredRoot) {
      checks.anchor = "UNAVAILABLE";
      details.push("Anchored root unavailable — chain not reachable");
    } else if (
      anchoredRoot.toLowerCase() !== bundle.anchor.merkleRoot.toLowerCase()
    ) {
      details.push("On-chain root does not match the bundle's Merkle root");
      return { result: "NOT_VALID", checks, details };
    } else {
      checks.anchor = "PASS";
    }
  }

  // Result ranking: hard failures returned above. Revocation state unknown
  // → INDETERMINATE (cannot rule out revocation). Anchor pending or
  // unreachable does not invalidate a signed, unrevoked credential.
  if (checks.revocation === "UNAVAILABLE") {
    return { result: "INDETERMINATE", checks, details };
  }
  return { result: "VALID", checks, details };
}
