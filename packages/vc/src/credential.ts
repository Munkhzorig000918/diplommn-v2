/**
 * W3C VC 2.0 envelope for diploma credentials. The credential id derives
 * from the random certificate ID (no PII in URLs); the status entry points
 * at the Bitstring Status List slot allocated at signing time — included
 * from day one because adding it later would change the signed bytes.
 */
import {
  DIPLOMA_CREDENTIAL_TYPE,
  DIPLOMA_SCHEMA_URL,
  DiplomaSubjectSchema,
  type DiplomaSubject,
} from "./schema.js";

export const VC_CONTEXT = "https://www.w3.org/ns/credentials/v2";

export interface BitstringStatusEntry {
  id: string;
  type: "BitstringStatusListEntry";
  statusPurpose: "revocation";
  statusListIndex: string;
  statusListCredential: string;
}

export interface UnsignedDiplomaCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  credentialSchema: { id: string; type: "JsonSchema" };
  credentialStatus?: BitstringStatusEntry;
  credentialSubject: DiplomaSubject;
}

export interface BuildCredentialInput {
  /** Random public certificate ID (Crockford base32). */
  certificateId: string;
  issuerDid: string;
  /** Public base URL, e.g. https://diplom.mn */
  baseUrl: string;
  issuedAt: Date;
  subject: DiplomaSubject;
  status?: {
    statusListIndex: number;
    statusListCredential: string;
  };
}

export function buildDiplomaCredential(
  input: BuildCredentialInput,
): UnsignedDiplomaCredential {
  const subject = DiplomaSubjectSchema.parse(input.subject);
  return {
    "@context": [VC_CONTEXT],
    id: `${input.baseUrl}/credentials/${input.certificateId}`,
    type: ["VerifiableCredential", DIPLOMA_CREDENTIAL_TYPE],
    issuer: input.issuerDid,
    validFrom: input.issuedAt.toISOString(),
    credentialSchema: { id: DIPLOMA_SCHEMA_URL, type: "JsonSchema" },
    ...(input.status
      ? {
          credentialStatus: {
            id: `${input.status.statusListCredential}#${input.status.statusListIndex}`,
            type: "BitstringStatusListEntry",
            statusPurpose: "revocation",
            statusListIndex: String(input.status.statusListIndex),
            statusListCredential: input.status.statusListCredential,
          },
        }
      : {}),
    credentialSubject: subject,
  };
}
