import { eq } from "drizzle-orm";
import {
  appendAuditEvent,
  credentialEvents,
  credentials,
  credentialTypes,
  holders,
  institutions,
  type Db,
} from "@diplommn/db";
import {
  AuditAction,
  AuditResource,
  AuditResult,
  formatCertificateId,
  sha256Hex,
} from "@diplommn/shared";
import type { Storage } from "@diplommn/storage";
import { renderCredentialPdf } from "../pdf/credential-pdf.js";

export interface GeneratePdfResult {
  objectKey: string;
  sha256: string;
  skipped?: string;
}

/**
 * Idempotent PDF artifact generation. Re-running overwrites the object and
 * updates the stored checksum — safe after retries or ops regeneration.
 * PDF failure never touches lifecycle status (availability ≠ integrity).
 */
export async function generatePdfArtifact(
  db: Db,
  storage: Storage,
  webOrigin: string,
  credentialId: string,
): Promise<GeneratePdfResult> {
  const rows = await db
    .select({
      id: credentials.id,
      certificateId: credentials.certificateId,
      credentialNumber: credentials.credentialNumber,
      lifecycleStatus: credentials.lifecycleStatus,
      issuedAt: credentials.issuedAt,
      claims: credentials.claims,
      submittedSnapshot: credentials.submittedSnapshot,
      holderLastName: holders.lastName,
      holderFirstName: holders.firstName,
      institutionMn: institutions.nameMn,
      institutionEn: institutions.nameEn,
      typeMn: credentialTypes.nameMn,
      typeEn: credentialTypes.nameEn,
    })
    .from(credentials)
    .innerJoin(holders, eq(credentials.holderId, holders.id))
    .innerJoin(institutions, eq(credentials.institutionId, institutions.id))
    .innerJoin(credentialTypes, eq(credentials.credentialTypeId, credentialTypes.id))
    .where(eq(credentials.id, credentialId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`credential ${credentialId} not found`);
  if (!row.certificateId) {
    // Not issued (or issuance rolled back) — nothing to render; don't retry forever.
    return { objectKey: "", sha256: "", skipped: "no certificate id" };
  }

  const claims = (row.submittedSnapshot ?? row.claims ?? {}) as Record<string, unknown>;
  const certFormatted = formatCertificateId(row.certificateId);
  const verifyUrl = `${webOrigin}/verify/${row.certificateId}`;

  const pdf = await renderCredentialPdf({
    holderName: `${row.holderLastName} ${row.holderFirstName}`,
    institutionMn: row.institutionMn,
    institutionEn: row.institutionEn,
    credentialTypeMn: row.typeMn,
    credentialTypeEn: row.typeEn,
    credentialNumber: row.credentialNumber,
    certificateIdFormatted: certFormatted,
    program: typeof claims.program === "string" ? claims.program : null,
    degree: typeof claims.degree === "string" ? claims.degree : null,
    awardedDate: typeof claims.awardedDate === "string" ? claims.awardedDate : null,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString().slice(0, 10) : "—",
    verifyUrl,
  });

  const checksum = sha256Hex(pdf);
  const objectKey = `credentials/${row.id}/certificate-${row.certificateId}.pdf`;
  await storage.putObject(objectKey, pdf, "application/pdf");

  await db.transaction(async (tx) => {
    await tx
      .update(credentials)
      .set({ pdfObjectKey: objectKey, pdfSha256: checksum, updatedAt: new Date() })
      .where(eq(credentials.id, row.id));
    await tx.insert(credentialEvents).values({
      credentialId: row.id,
      eventType: "artifact_generated",
      details: { objectKey, sha256: checksum },
    });
    await appendAuditEvent(tx, {
      actorType: "SYSTEM",
      action: AuditAction.ArtifactGenerated,
      resourceType: AuditResource.Credential,
      resourceId: row.id,
      source: "JOB",
      result: AuditResult.Success,
      details: { objectKey, sha256: checksum },
    });
  });

  return { objectKey, sha256: checksum };
}
