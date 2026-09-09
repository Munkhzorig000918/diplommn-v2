/**
 * BitstringStatusListCredential — the revocation status list, itself a VC
 * signed by the platform issuer, hosted off-chain (architecture: off-chain
 * hosted + hash-anchored). Consumers check one bit; unavailability of the
 * list is an INDETERMINATE condition, never "revoked" and never "fraud".
 */
import { Bitstring } from "./bitstring.js";
import { VC_CONTEXT } from "./credential.js";
import { signCredential, type Signed } from "./proof.js";
import type { VcSigner } from "./signer.js";

export interface StatusListCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  credentialSubject: {
    id: string;
    type: "BitstringStatusList";
    statusPurpose: "revocation";
    encodedList: string;
  };
}

export interface BuildStatusListInput {
  /** Public URL of this list, e.g. https://diplom.mn/status/1 */
  url: string;
  issuerDid: string;
  /** Indexes whose revocation bit is set. */
  revokedIndexes: readonly number[];
  now?: Date;
}

export function buildStatusListCredential(
  input: BuildStatusListInput,
): StatusListCredential {
  const bits = new Bitstring();
  for (const index of input.revokedIndexes) bits.set(index, true);
  return {
    "@context": [VC_CONTEXT],
    id: input.url,
    type: ["VerifiableCredential", "BitstringStatusListCredential"],
    issuer: input.issuerDid,
    validFrom: (input.now ?? new Date()).toISOString(),
    credentialSubject: {
      id: `${input.url}#list`,
      type: "BitstringStatusList",
      statusPurpose: "revocation",
      encodedList: bits.encode(),
    },
  };
}

export async function buildSignedStatusListCredential(
  input: BuildStatusListInput,
  signer: VcSigner,
): Promise<Signed<StatusListCredential>> {
  return signCredential(buildStatusListCredential(input), signer, {
    ...(input.now ? { created: input.now } : {}),
  });
}

/** Read one revocation bit out of a status list credential. */
export function isRevokedInStatusList(
  statusList: StatusListCredential,
  statusListIndex: number | string,
): boolean {
  const subject = statusList.credentialSubject;
  if (subject?.type !== "BitstringStatusList") {
    throw new Error("Not a BitstringStatusList credential");
  }
  return Bitstring.decode(subject.encodedList).get(Number(statusListIndex));
}
