import { eq } from "drizzle-orm";
import {
  appendAuditEvent,
  credentialEvents,
  credentials,
  credentialTypes,
  holders,
  type Db,
} from "@diplommn/db";
import {
  AuditAction,
  AuditResource,
  AuditResult,
  formatCertificateId,
} from "@diplommn/shared";
import type { Notifier } from "@diplommn/notify";

/**
 * Issuance notification to the holder. Notification failure must never affect
 * the credential (design gap #23 guidance) — BullMQ retries handle transient
 * provider errors; holders without contact details are skipped silently.
 * Message bodies carry no registration numbers or claims payloads.
 */
export async function notifyIssued(
  db: Db,
  notifier: Notifier,
  webOrigin: string,
  credentialId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const rows = await db
    .select({
      id: credentials.id,
      certificateId: credentials.certificateId,
      holderEmail: holders.email,
      holderFirstName: holders.firstName,
      typeMn: credentialTypes.nameMn,
    })
    .from(credentials)
    .innerJoin(holders, eq(credentials.holderId, holders.id))
    .innerJoin(credentialTypes, eq(credentials.credentialTypeId, credentialTypes.id))
    .where(eq(credentials.id, credentialId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`credential ${credentialId} not found`);
  if (!row.certificateId) return { sent: false, reason: "not issued" };
  if (!row.holderEmail) return { sent: false, reason: "no contact on file" };

  const certFormatted = formatCertificateId(row.certificateId);
  await notifier.sendEmail(
    row.holderEmail,
    "Таны баримт олгогдлоо — diplom.mn",
    [
      `Сайн байна уу, ${row.holderFirstName},`,
      "",
      `Таны "${row.typeMn}" баримт diplom.mn системд олгогдлоо.`,
      `Сертификатын дугаар: ${certFormatted}`,
      "",
      `Баталгаажуулах: ${webOrigin}/verify/${row.certificateId}`,
      `Портал: ${webOrigin}/portal`,
      "",
      "— diplom.mn",
      "",
      `Your "${row.typeMn}" credential has been issued. Verify it any time at ${webOrigin}/verify/${row.certificateId} or view it in your portal at ${webOrigin}/portal.`,
    ].join("\n"),
  );

  await db.transaction(async (tx) => {
    await tx.insert(credentialEvents).values({
      credentialId: row.id,
      eventType: "notification_sent",
      details: { channel: "email", kind: notifier.kind },
    });
    await appendAuditEvent(tx, {
      actorType: "SYSTEM",
      action: AuditAction.NotificationSent,
      resourceType: AuditResource.Credential,
      resourceId: row.id,
      source: "JOB",
      result: AuditResult.Success,
      details: { channel: "email", provider: notifier.kind },
    });
  });

  return { sent: true };
}
