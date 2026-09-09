/**
 * VC signing job (architecture §10). Runs after issuance: builds the
 * diploma credential from the immutable issued record, allocates the
 * Bitstring Status List slot, signs under did:web:diplom.mn and stores the
 * signed VC. Idempotent — an already-signed credential is never re-signed
 * (corrections issue replacement credentials instead).
 *
 * In production the VcSigner is KMS/HSM-backed and this worker runs
 * isolated from the API server (separation of duties); the dev signer only
 * exists for local work.
 */
import { eq, sql } from "drizzle-orm";
import {
  credentials,
  credentialTypes,
  holders,
  institutions,
  type Db,
} from "@diplommn/db";
import { computeContentHash } from "@diplommn/shared";
import {
  DiplomaSubjectSchema,
  buildDiplomaCredential,
  signCredential,
  type DiplomaSubject,
  type VcSigner,
} from "@diplommn/vc";

export interface VcSigningContext {
  signer: VcSigner;
  issuerDid: string;
  /** Public base URL used in the credential id, e.g. https://diplom.mn */
  baseUrl: string;
  /** Status list credential URL, e.g. https://diplom.mn/status/1 */
  statusListCredential: string;
}

export type SignVcResult =
  | { signed: true; credentialId: string; statusListIndex: number }
  | { signed: false; skipped: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export async function signVcForCredential(
  db: Db,
  ctx: VcSigningContext,
  credentialId: string,
): Promise<SignVcResult> {
  const [row] = await db
    .select({
      id: credentials.id,
      certificateId: credentials.certificateId,
      lifecycleStatus: credentials.lifecycleStatus,
      credentialNumber: credentials.credentialNumber,
      claims: credentials.claims,
      submittedSnapshot: credentials.submittedSnapshot,
      issuedAt: credentials.issuedAt,
      vc: credentials.vc,
      contentSalt: credentials.contentSalt,
      statusListIndex: credentials.statusListIndex,
      kind: credentialTypes.kind,
      holderLastName: holders.lastName,
      holderFirstName: holders.firstName,
      institutionCode: institutions.code,
      institutionNameMn: institutions.nameMn,
      institutionNameEn: institutions.nameEn,
    })
    .from(credentials)
    .innerJoin(credentialTypes, eq(credentials.credentialTypeId, credentialTypes.id))
    .innerJoin(holders, eq(credentials.holderId, holders.id))
    .innerJoin(institutions, eq(credentials.institutionId, institutions.id))
    .where(eq(credentials.id, credentialId))
    .limit(1);

  if (!row) return { signed: false, skipped: "not-found" };
  if (row.vc) return { signed: false, skipped: "already-signed" };
  if (row.lifecycleStatus !== "ISSUED" || !row.certificateId || !row.issuedAt) {
    return { signed: false, skipped: `not-issued (${row.lifecycleStatus})` };
  }
  if (row.kind !== "DIPLOMA") {
    // Certificate claim schema is a separate pending contract; the diploma
    // schema must not be silently reused for other kinds.
    return { signed: false, skipped: `no schema for kind ${row.kind}` };
  }

  const claims = (row.submittedSnapshot ?? row.claims ?? {}) as Record<
    string,
    unknown
  >;
  const diplomaNumber =
    optionalString(row.credentialNumber) ??
    optionalString(claims.diplomaNumber);
  if (!diplomaNumber) {
    throw new Error(
      `Credential ${credentialId} has no diploma number — cannot build subject`,
    );
  }

  const hemisIdRaw = Number(claims.institutionHemisId);
  const educationFieldCode = optionalString(claims.educationFieldCode);
  const educationFieldName = optionalString(claims.educationFieldName);
  const schoolId = optionalString(claims.schoolId);
  const schoolName = optionalString(claims.schoolName);
  const subject: DiplomaSubject = DiplomaSubjectSchema.parse({
    diplomaNumber,
    holder: { lastName: row.holderLastName, firstName: row.holderFirstName },
    institution: {
      code: row.institutionCode,
      nameMn: row.institutionNameMn,
      ...(optionalString(row.institutionNameEn)
        ? { nameEn: row.institutionNameEn }
        : {}),
      ...(Number.isInteger(hemisIdRaw) && hemisIdRaw > 0
        ? { hemisId: hemisIdRaw }
        : {}),
      ...(optionalString(claims.institutionStateRegister)
        ? { stateRegister: optionalString(claims.institutionStateRegister) }
        : {}),
    },
    ...(schoolId || schoolName
      ? {
          school: {
            ...(schoolId ? { id: schoolId } : {}),
            ...(schoolName ? { name: schoolName } : {}),
          },
        }
      : {}),
    ...(optionalString(claims.educationLevel)
      ? { educationLevel: optionalString(claims.educationLevel) }
      : {}),
    ...(educationFieldCode || educationFieldName
      ? {
          educationField: {
            ...(educationFieldCode ? { code: educationFieldCode } : {}),
            ...(educationFieldName ? { name: educationFieldName } : {}),
          },
        }
      : {}),
    ...(optionalString(claims.programName)
      ? { programName: optionalString(claims.programName) }
      : {}),
    ...(optionalString(claims.graduationYear)
      ? { graduationYear: optionalString(claims.graduationYear) }
      : {}),
  });

  // Allocate the status-list slot once; reuse on retry after a crash.
  let statusListIndex = row.statusListIndex;
  if (statusListIndex === null) {
    const alloc = await db.execute(
      sql`SELECT nextval('credentials_status_list_index_seq') AS idx`,
    );
    statusListIndex = Number((alloc.rows[0] as { idx: string }).idx);
    await db
      .update(credentials)
      .set({ statusListIndex, updatedAt: new Date() })
      .where(eq(credentials.id, credentialId));
  }

  const unsigned = buildDiplomaCredential({
    certificateId: row.certificateId,
    issuerDid: ctx.issuerDid,
    baseUrl: ctx.baseUrl,
    issuedAt: row.issuedAt,
    subject,
    status: {
      statusListIndex,
      statusListCredential: ctx.statusListCredential,
    },
  });
  const signed = await signCredential(unsigned, ctx.signer);

  // Salted hash over the signed VC — the anchor leaf (architecture §2).
  if (!row.contentSalt) {
    throw new Error(`Credential ${credentialId} has no content salt`);
  }
  const { hash: vcHash } = computeContentHash(signed, row.contentSalt);

  await db
    .update(credentials)
    .set({
      vc: signed,
      vcSignedAt: new Date(),
      vcKeyId: ctx.signer.keyId,
      vcHash,
      updatedAt: new Date(),
    })
    .where(eq(credentials.id, credentialId));

  return { signed: true, credentialId, statusListIndex };
}
