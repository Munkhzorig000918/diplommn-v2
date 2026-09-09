/**
 * did:web document construction for the single platform issuer
 * (`did:web:diplom.mn` — institutions are VC fields, never issuers).
 *
 * The DID document is always DERIVED from the key history:
 *  - ACTIVE keys appear in verificationMethod and assertionMethod;
 *  - RETIRED keys stay in verificationMethod (old credentials must remain
 *    verifiable) but are dropped from assertionMethod;
 *  - REVOKED keys are removed entirely.
 * Only assertionMethod is published — the issuer signs credentials; it does
 * not authenticate or encrypt as this DID.
 */

import {
  KeyStatus,
  assertValidHistory,
  type KeyHistory,
} from "./key-history.js";

export interface VerificationMethod {
  id: string;
  type: "Multikey";
  controller: string;
  publicKeyMultibase: string;
}

export interface DidWebDocument {
  "@context": string[];
  id: string;
  verificationMethod: VerificationMethod[];
  assertionMethod: string[];
}

/** `diplom.mn` → `did:web:diplom.mn`; ports are percent-encoded per spec. */
export function didWebFromDomain(domain: string): string {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) {
    throw new Error(`Not a bare domain[:port]: ${domain}`);
  }
  return `did:web:${domain.toLowerCase().replace(":", "%3A")}`;
}

/** Where the document must be served: https://<domain>/.well-known/did.json */
export function didWebDocumentUrl(domain: string): string {
  return `https://${domain}/.well-known/did.json`;
}

export function buildDidDocument(
  domain: string,
  history: KeyHistory,
): DidWebDocument {
  assertValidHistory(history);
  const did = didWebFromDomain(domain);
  if (history.issuer !== did) {
    throw new Error(
      `Key history issuer ${history.issuer} does not match ${did}`,
    );
  }

  const resolvable = history.keys.filter(
    (k) => k.status !== KeyStatus.Revoked,
  );
  if (!resolvable.some((k) => k.status === KeyStatus.Active)) {
    throw new Error("Cannot publish a DID document with no active key");
  }

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
    ],
    id: did,
    verificationMethod: resolvable.map((k) => ({
      id: `${did}#${k.keyId}`,
      type: "Multikey",
      controller: did,
      publicKeyMultibase: k.publicKeyMultibase,
    })),
    assertionMethod: resolvable
      .filter((k) => k.status === KeyStatus.Active)
      .map((k) => `${did}#${k.keyId}`),
  };
}
