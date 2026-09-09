import { and, eq } from "drizzle-orm";
import {
  appendAuditEvent,
  credentialEvents,
  credentials,
  lifecycleCases,
  type Db,
  type DbTx,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  canTransition,
  computeContentHash,
  generateCertificateId,
  generateSaltHex,
  type CredentialLifecycle,
} from "@diplommn/shared";

export interface ActorContext {
  userId: string;
  correlationId: string;
}

type CredentialRow = typeof credentials.$inferSelect;

async function loadForUpdate(
  tx: DbTx,
  credentialId: string,
): Promise<CredentialRow> {
  // Row lock so concurrent workflow actions serialize per credential.
  const rows = await tx
    .select()
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (!row) throw AppError.notFound("Credential not found");
  return row;
}

function assertTransition(
  from: CredentialLifecycle,
  to: CredentialLifecycle,
): void {
  if (!canTransition(from, to)) {
    throw AppError.conflict(
      `Transition ${from} → ${to} is not allowed`,
      { from, to },
    );
  }
}

async function recordTransition(
  tx: DbTx,
  opts: {
    credential: CredentialRow;
    to: CredentialLifecycle;
    eventType: string;
    auditAction: string;
    actor: ActorContext | null;
    reason?: string;
    extraValues?: Partial<typeof credentials.$inferInsert>;
    auditDetails?: Record<string, unknown>;
  },
): Promise<void> {
  assertTransition(opts.credential.lifecycleStatus, opts.to);
  await tx
    .update(credentials)
    .set({
      lifecycleStatus: opts.to,
      updatedAt: new Date(),
      ...opts.extraValues,
    })
    .where(eq(credentials.id, opts.credential.id));
  await tx.insert(credentialEvents).values({
    credentialId: opts.credential.id,
    eventType: opts.eventType,
    fromStatus: opts.credential.lifecycleStatus,
    toStatus: opts.to,
    actorUserId: opts.actor?.userId ?? null,
    reason: opts.reason ?? null,
  });
  await appendAuditEvent(tx, {
    actorType: opts.actor ? "USER" : "SYSTEM",
    actorUserId: opts.actor?.userId ?? null,
    action: opts.auditAction,
    resourceType: AuditResource.Credential,
    resourceId: opts.credential.id,
    result: AuditResult.Success,
    correlationId: opts.actor?.correlationId ?? null,
    details: {
      from: opts.credential.lifecycleStatus,
      to: opts.to,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...opts.auditDetails,
    },
  });
}

/** Operator submits a draft: claims are snapshotted immutably. */
export async function submitCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    await recordTransition(tx, {
      credential,
      to: "PENDING_APPROVAL",
      eventType: "submitted",
      auditAction: AuditAction.CredentialSubmitted,
      actor,
      extraValues: {
        submittedSnapshot: credential.claims,
        submittedBy: actor.userId,
        submittedAt: new Date(),
      },
    });
  });
}

/**
 * Approval — separation of duties: the submitter can never approve their own
 * request (design doc §4 permission principles). On approval the credential is
 * issued in-line (M1; moves to the worker pipeline with M4).
 */
export async function approveCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
): Promise<{ certificateId: string }> {
  return db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    if (credential.submittedBy === actor.userId) {
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: actor.userId,
        action: AuditAction.CredentialApproved,
        resourceType: AuditResource.Credential,
        resourceId: credential.id,
        result: AuditResult.Denied,
        correlationId: actor.correlationId,
        details: { reason: "self_approval_forbidden" },
      });
      throw AppError.forbidden("Submitter cannot approve their own request");
    }
    await recordTransition(tx, {
      credential,
      to: "APPROVED",
      eventType: "approved",
      auditAction: AuditAction.CredentialApproved,
      actor,
      extraValues: { approvedBy: actor.userId, approvedAt: new Date() },
    });

    const approved = await loadForUpdate(tx, credentialId);
    return issueWithinTransaction(tx, approved, actor);
  });
}

/**
 * Issuance: assign the public random certificate ID, compute the salted
 * content hash over the submitted snapshot (Phase-2 anchoring input), stamp
 * issuance time. Immutable from here on.
 */
async function issueWithinTransaction(
  tx: DbTx,
  credential: CredentialRow,
  actor: ActorContext | null,
): Promise<{ certificateId: string }> {
  const claims = credential.submittedSnapshot ?? credential.claims;
  const salt = generateSaltHex();
  const { hash, alg, canonicalization } = computeContentHash(claims, salt);
  const certificateId = generateCertificateId();

  await recordTransition(tx, {
    credential,
    to: "ISSUED",
    eventType: "issued",
    auditAction: AuditAction.CredentialIssued,
    actor,
    extraValues: {
      certificateId,
      contentSalt: salt,
      contentHash: hash,
      contentHashAlg: alg,
      canonicalization,
      issuedAt: new Date(),
      // Eligible for the next daily Merkle anchor batch (Phase 1).
      anchorStatus: "AWAITING_BATCH",
    },
    auditDetails: { certificateId },
  });

  // If this credential replaces another (correction/reissue case), the old
  // credential becomes SUPERSEDED now that its replacement is authoritative.
  const linkedCases = await tx
    .select()
    .from(lifecycleCases)
    .where(
      and(
        eq(lifecycleCases.replacementCredentialId, credential.id),
        eq(lifecycleCases.status, "APPROVED"),
      ),
    );
  for (const c of linkedCases) {
    const oldCredential = await loadForUpdate(tx, c.credentialId);
    if (oldCredential.lifecycleStatus === "ISSUED") {
      await recordTransition(tx, {
        credential: oldCredential,
        to: "SUPERSEDED",
        eventType: "superseded",
        auditAction: AuditAction.CredentialSuperseded,
        actor,
        extraValues: { supersededById: credential.id },
        auditDetails: { replacementCredentialId: credential.id, caseId: c.id },
      });
    }
    await tx
      .update(lifecycleCases)
      .set({ status: "COMPLETED", updatedAt: new Date() })
      .where(eq(lifecycleCases.id, c.id));
  }

  return { certificateId };
}

/** Retry hook for an APPROVED credential whose issuance failed. */
export async function issueApprovedCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
): Promise<{ certificateId: string }> {
  return db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    if (credential.lifecycleStatus !== "APPROVED") {
      throw AppError.conflict("Credential is not awaiting issuance");
    }
    return issueWithinTransaction(tx, credential, actor);
  });
}

export async function returnCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    if (credential.submittedBy === actor.userId) {
      throw AppError.forbidden("Submitter cannot review their own request");
    }
    await recordTransition(tx, {
      credential,
      to: "RETURNED",
      eventType: "returned",
      auditAction: AuditAction.CredentialReturned,
      actor,
      reason,
    });
  });
}

export async function rejectCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    if (credential.submittedBy === actor.userId) {
      throw AppError.forbidden("Submitter cannot review their own request");
    }
    await recordTransition(tx, {
      credential,
      to: "REJECTED",
      eventType: "rejected",
      auditAction: AuditAction.CredentialRejected,
      actor,
      reason,
    });
  });
}

export async function cancelCredential(
  db: Db,
  credentialId: string,
  actor: ActorContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const credential = await loadForUpdate(tx, credentialId);
    await recordTransition(tx, {
      credential,
      to: "CANCELLED",
      eventType: "cancelled",
      auditAction: AuditAction.CredentialCancelled,
      actor,
    });
  });
}

/**
 * Revocation applied after a lifecycle case is approved (dual control lives in
 * the lifecycle module). Walks ISSUED → REVOCATION_PENDING → REVOKED in one
 * transaction — in the MVP the database *is* the public status source, so
 * "publishing" is atomic with the decision. V2 splits these around the status
 * list publication job.
 */
export async function applyRevocation(
  tx: DbTx,
  credentialId: string,
  actor: ActorContext,
  reason: string,
  caseId: string,
): Promise<void> {
  const credential = await loadForUpdate(tx, credentialId);
  await recordTransition(tx, {
    credential,
    to: "REVOCATION_PENDING",
    eventType: "revocation_approved",
    auditAction: AuditAction.LifecycleCaseApproved,
    actor,
    reason,
    auditDetails: { caseId },
  });
  const pending = await loadForUpdate(tx, credentialId);
  await recordTransition(tx, {
    credential: pending,
    to: "REVOKED",
    eventType: "revoked",
    auditAction: AuditAction.CredentialRevoked,
    actor,
    reason,
    auditDetails: { caseId },
  });
}
