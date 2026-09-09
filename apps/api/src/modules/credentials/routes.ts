import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
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
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  CredentialLifecycle,
  maskRegistrationNumber,
  Role,
} from "@diplommn/shared";
import {
  buildValidationEvidence,
  matchAgainstHemis,
  toSourceValidationStatus,
  type HemisClient,
  type HemisMatchResult,
} from "@diplommn/hemis";
import {
  requireInstitutionScope,
  requireRole,
  requireUser,
  type AuthenticatedUser,
} from "../../plugins/auth.js";
import {
  approveCredential,
  cancelCredential,
  issueApprovedCredential,
  rejectCredential,
  returnCredential,
  submitCredential,
} from "./service.js";

const CreateBody = z.object({
  credentialTypeId: z.string().uuid(),
  institutionId: z.string().uuid(),
  holder: z.object({
    lastName: z.string().min(1).max(100),
    firstName: z.string().min(1).max(100),
    registrationNumber: z.string().min(4).max(20),
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
  }),
  credentialNumber: z.string().max(100).optional(),
  claims: z.record(z.string(), z.unknown()).default({}),
});

const UpdateBody = z.object({
  credentialNumber: z.string().max(100).nullish(),
  claims: z.record(z.string(), z.unknown()).optional(),
});

const ReasonBody = z.object({ reason: z.string().min(3).max(2000) });

const ListQuery = z.object({
  status: z.enum(CredentialLifecycle).optional(),
  institutionId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  offset: z.coerce.number().min(0).default(0),
});

const IdParams = z.object({ id: z.string().uuid() });

/** Institutions a scoped user may see; null = unrestricted (global grant). */
function visibleInstitutions(user: AuthenticatedUser): string[] | null {
  if (user.roles.some((r) => r.institutionId === null)) return null;
  return [...new Set(user.roles.flatMap((r) => (r.institutionId ? [r.institutionId] : [])))];
}

export function registerCredentialRoutes(
  app: FastifyInstance,
  db: Db,
  queues: import("../../queues.js").JobQueues | null,
  hemis: HemisClient | null = null,
): void {
  /** Enqueue after commit; failure is recoverable via ops, never blocks issuance. */
  async function enqueueArtifacts(
    request: { id: string; log: { error: (o: unknown, m: string) => void } },
    credentialId: string,
  ) {
    if (!queues) return;
    try {
      await queues.enqueuePdf(credentialId);
    } catch (err) {
      request.log.error(
        { err, credentialId },
        "failed to enqueue artifact job (recover via ops regenerate)",
      );
    }
    try {
      await queues.enqueueSignVc(credentialId);
    } catch (err) {
      request.log.error(
        { err, credentialId },
        "failed to enqueue VC signing job (idempotent — re-enqueue via ops)",
      );
    }
  }
  app.post("/api/v1/credentials", async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const user = requireInstitutionScope(
      request,
      body.institutionId,
      Role.Operator,
    );

    const [institution] = await db
      .select()
      .from(institutions)
      .where(and(eq(institutions.id, body.institutionId), eq(institutions.active, true)))
      .limit(1);
    if (!institution) throw AppError.validation("Unknown or inactive institution");

    const [credType] = await db
      .select()
      .from(credentialTypes)
      .where(and(eq(credentialTypes.id, body.credentialTypeId), eq(credentialTypes.active, true)))
      .limit(1);
    if (!credType) throw AppError.validation("Unknown or inactive credential type");

    const created = await db.transaction(async (tx) => {
      // Reuse holder identity by registration number, or create it.
      let [holder] = await tx
        .select()
        .from(holders)
        .where(eq(holders.registrationNumber, body.holder.registrationNumber))
        .limit(1);
      if (!holder) {
        [holder] = await tx
          .insert(holders)
          .values({
            lastName: body.holder.lastName,
            firstName: body.holder.firstName,
            registrationNumber: body.holder.registrationNumber,
            email: body.holder.email ?? null,
            phone: body.holder.phone ?? null,
          })
          .returning();
      }
      if (!holder) throw new Error("failed to resolve holder");

      const [row] = await tx
        .insert(credentials)
        .values({
          credentialTypeId: body.credentialTypeId,
          institutionId: body.institutionId,
          holderId: holder.id,
          credentialNumber: body.credentialNumber ?? null,
          claims: body.claims,
          schemaVersion: credType.schemaVersion,
          createdBy: user.id,
        })
        .returning({ id: credentials.id });
      if (!row) throw new Error("failed to create credential");

      await tx.insert(credentialEvents).values({
        credentialId: row.id,
        eventType: "draft_created",
        toStatus: "DRAFT",
        actorUserId: user.id,
      });
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.CredentialDraftCreated,
        resourceType: AuditResource.Credential,
        resourceId: row.id,
        result: AuditResult.Success,
        correlationId: request.id,
        details: {
          institutionId: body.institutionId,
          credentialTypeId: body.credentialTypeId,
        },
      });
      return row;
    });

    return reply.status(201).send({ id: created.id });
  });

  app.patch("/api/v1/credentials/:id", async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateBody.parse(request.body);
    const user = requireUser(request);

    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(credentials)
        .where(eq(credentials.id, id))
        .for("update")
        .limit(1);
      const credential = rows[0];
      if (!credential) throw AppError.notFound("Credential not found");
      requireInstitutionScope(request, credential.institutionId, Role.Operator);
      if (
        credential.lifecycleStatus !== "DRAFT" &&
        credential.lifecycleStatus !== "RETURNED"
      ) {
        // Signed/submitted claims are immutable — corrections use lifecycle cases.
        throw AppError.conflict("Only drafts and returned requests are editable");
      }
      await tx
        .update(credentials)
        .set({
          ...(body.claims !== undefined ? { claims: body.claims } : {}),
          ...(body.credentialNumber !== undefined
            ? { credentialNumber: body.credentialNumber }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(credentials.id, id));
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.CredentialDraftUpdated,
        resourceType: AuditResource.Credential,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
      });
    });
    return { ok: true };
  });

  app.get("/api/v1/credentials", async (request) => {
    const user = requireRole(
      request,
      Role.Operator,
      Role.Approver,
      Role.LifecycleAdmin,
      Role.PlatformAdmin,
      Role.Auditor,
    );
    const query = ListQuery.parse(request.query);

    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(credentials.lifecycleStatus, query.status));
    if (query.institutionId) conditions.push(eq(credentials.institutionId, query.institutionId));
    const scope = visibleInstitutions(user);
    if (scope !== null) {
      if (scope.length === 0) return { items: [], total: 0 };
      conditions.push(
        sql`${credentials.institutionId} IN (${sql.join(scope.map((s) => sql`${s}`), sql`, `)})`,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const items = await db
      .select({
        id: credentials.id,
        certificateId: credentials.certificateId,
        credentialNumber: credentials.credentialNumber,
        lifecycleStatus: credentials.lifecycleStatus,
        sourceValidationStatus: credentials.sourceValidationStatus,
        issuedAt: credentials.issuedAt,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
        institution: { code: institutions.code, nameMn: institutions.nameMn },
        credentialType: { code: credentialTypes.code, nameMn: credentialTypes.nameMn },
        holderLastName: holders.lastName,
        holderFirstName: holders.firstName,
        holderRegNum: holders.registrationNumber,
      })
      .from(credentials)
      .innerJoin(institutions, eq(credentials.institutionId, institutions.id))
      .innerJoin(credentialTypes, eq(credentials.credentialTypeId, credentialTypes.id))
      .innerJoin(holders, eq(credentials.holderId, holders.id))
      .where(where)
      .orderBy(desc(credentials.updatedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(credentials)
      .where(where);

    return {
      items: items.map((i) => ({
        ...i,
        holderName: `${i.holderLastName} ${i.holderFirstName}`,
        holderRegNum: maskRegistrationNumber(i.holderRegNum),
        holderLastName: undefined,
        holderFirstName: undefined,
      })),
      total: count?.total ?? 0,
    };
  });

  app.get("/api/v1/credentials/:id", async (request) => {
    const { id } = IdParams.parse(request.params);
    const user = requireRole(
      request,
      Role.Operator,
      Role.Approver,
      Role.LifecycleAdmin,
      Role.PlatformAdmin,
      Role.Auditor,
    );

    const rows = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);
    const credential = rows[0];
    if (!credential) throw AppError.notFound("Credential not found");

    const scope = visibleInstitutions(user);
    if (scope !== null && !scope.includes(credential.institutionId)) {
      // Do not reveal existence outside scope.
      throw AppError.notFound("Credential not found");
    }

    const [holder] = await db
      .select()
      .from(holders)
      .where(eq(holders.id, credential.holderId))
      .limit(1);
    const events = await db
      .select({
        eventType: credentialEvents.eventType,
        fromStatus: credentialEvents.fromStatus,
        toStatus: credentialEvents.toStatus,
        actorUserId: credentialEvents.actorUserId,
        reason: credentialEvents.reason,
        createdAt: credentialEvents.createdAt,
      })
      .from(credentialEvents)
      .where(eq(credentialEvents.credentialId, id))
      .orderBy(desc(credentialEvents.createdAt));

    // Latest HEMIS validation evidence for the approval evidence panel.
    // The raw upstream payload stays server-side; the panel gets the
    // normalized record + per-field diffs.
    const [validationEvent] = await db
      .select({
        toStatus: credentialEvents.toStatus,
        details: credentialEvents.details,
        createdAt: credentialEvents.createdAt,
      })
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.credentialId, id),
          eq(credentialEvents.eventType, "source-validation"),
        ),
      )
      .orderBy(desc(credentialEvents.createdAt))
      .limit(1);
    let sourceValidation: Record<string, unknown> | null = null;
    if (validationEvent) {
      const { raw: _raw, ...evidence } =
        (validationEvent.details ?? {}) as Record<string, unknown>;
      sourceValidation = {
        status: validationEvent.toStatus,
        checkedAt: validationEvent.createdAt,
        ...evidence,
      };
    }

    // Never expose the content salt (anchoring confidentiality).
    const { contentSalt: _salt, ...safe } = credential;
    return {
      credential: {
        ...safe,
        holder: holder
          ? {
              id: holder.id,
              lastName: holder.lastName,
              firstName: holder.firstName,
              registrationNumber: maskRegistrationNumber(holder.registrationNumber),
            }
          : null,
      },
      sourceValidation,
      events,
    };
  });

  /* ---------------- workflow actions ---------------- */

  const workflowActor = (request: { id: string }, userId: string) => ({
    userId,
    correlationId: request.id,
  });

  app.post("/api/v1/credentials/:id/submit", async (request) => {
    const { id } = IdParams.parse(request.params);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(request, credential.institutionId, Role.Operator);
    await submitCredential(db, id, workflowActor(request, user.id));
    return { ok: true };
  });

  app.post("/api/v1/credentials/:id/approve", async (request) => {
    const { id } = IdParams.parse(request.params);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(request, credential.institutionId, Role.Approver);
    const { certificateId } = await approveCredential(db, id, workflowActor(request, user.id));
    await enqueueArtifacts(request, id);
    return { ok: true, certificateId };
  });

  app.post("/api/v1/credentials/:id/return", async (request) => {
    const { id } = IdParams.parse(request.params);
    const { reason } = ReasonBody.parse(request.body);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(request, credential.institutionId, Role.Approver);
    await returnCredential(db, id, workflowActor(request, user.id), reason);
    return { ok: true };
  });

  app.post("/api/v1/credentials/:id/reject", async (request) => {
    const { id } = IdParams.parse(request.params);
    const { reason } = ReasonBody.parse(request.body);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(request, credential.institutionId, Role.Approver);
    await rejectCredential(db, id, workflowActor(request, user.id), reason);
    return { ok: true };
  });

  app.post("/api/v1/credentials/:id/cancel", async (request) => {
    const { id } = IdParams.parse(request.params);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(request, credential.institutionId, Role.Operator);
    await cancelCredential(db, id, workflowActor(request, user.id));
    return { ok: true };
  });

  /**
   * Source validation against HEMIS (architecture §12). Operator-triggered;
   * stores the fetch + match evidence as a credential event for the
   * approver's evidence panel. Mismatch/not-found block approval by default
   * (open decision #9); UNAVAILABLE is an outage, never presented as fraud.
   */
  app.post("/api/v1/credentials/:id/validate-source", async (request) => {
    const { id } = IdParams.parse(request.params);
    const loaded = await mustLoad(db, id);
    const user = requireInstitutionScope(request, loaded.institutionId, Role.Operator);
    if (!hemis) {
      throw AppError.conflict("HEMIS integration is not configured");
    }

    const [row] = await db
      .select({
        lifecycleStatus: credentials.lifecycleStatus,
        credentialNumber: credentials.credentialNumber,
        sourceValidationStatus: credentials.sourceValidationStatus,
        holderFirstName: holders.firstName,
        holderRegistrationNumber: holders.registrationNumber,
      })
      .from(credentials)
      .innerJoin(holders, eq(credentials.holderId, holders.id))
      .where(eq(credentials.id, id))
      .limit(1);
    if (!row) throw AppError.notFound("Credential not found");
    if (!["DRAFT", "PENDING_APPROVAL", "RETURNED"].includes(row.lifecycleStatus)) {
      throw AppError.conflict(
        "Source validation only applies before issuance",
      );
    }
    const degreeNumber = row.credentialNumber;
    if (!degreeNumber) {
      throw AppError.validation(
        "Credential has no credential number (HEMIS degree number)",
      );
    }

    await db
      .update(credentials)
      .set({ sourceValidationStatus: "CHECKING", updatedAt: new Date() })
      .where(eq(credentials.id, id));

    const fetchResult = await hemis.fetchDiploma(degreeNumber);
    let match: HemisMatchResult | null = null;
    if (fetchResult.status === "found") {
      match = matchAgainstHemis(fetchResult.record, {
        degreeNumber,
        primaryIdentifierNumber: row.holderRegistrationNumber,
        firstName: row.holderFirstName,
      });
    }
    const status = toSourceValidationStatus(fetchResult, match);
    const evidence = buildValidationEvidence(degreeNumber, fetchResult, match);

    await db.transaction(async (tx) => {
      await tx
        .update(credentials)
        .set({ sourceValidationStatus: status, updatedAt: new Date() })
        .where(eq(credentials.id, id));
      await tx.insert(credentialEvents).values({
        credentialId: id,
        eventType: "source-validation",
        toStatus: status,
        actorUserId: user.id,
        details: evidence,
      });
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.CredentialSourceValidated,
        resourceType: AuditResource.Credential,
        resourceId: id,
        result:
          status === "MATCHED" ? AuditResult.Success : AuditResult.Failure,
        correlationId: request.id,
        details: { degreeNumber, status, outcome: fetchResult.status },
      });
    });

    return {
      status,
      outcome: fetchResult.status,
      ...(match ? { match } : {}),
    };
  });

  /** Retry issuance for APPROVED credentials whose issuance step failed. */
  app.post("/api/v1/credentials/:id/issue", async (request) => {
    const { id } = IdParams.parse(request.params);
    const credential = await mustLoad(db, id);
    const user = requireInstitutionScope(
      request,
      credential.institutionId,
      Role.Approver,
      Role.PlatformAdmin,
    );
    const { certificateId } = await issueApprovedCredential(
      db,
      id,
      workflowActor(request, user.id),
    );
    await enqueueArtifacts(request, id);
    return { ok: true, certificateId };
  });
}

async function mustLoad(db: Db, id: string) {
  const rows = await db
    .select({ id: credentials.id, institutionId: credentials.institutionId })
    .from(credentials)
    .where(eq(credentials.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw AppError.notFound("Credential not found");
  return row;
}
