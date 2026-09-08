import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appendAuditEvent,
  credentialEvents,
  credentials,
  lifecycleCases,
  type Db,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  Role,
} from "@diplommn/shared";
import { requireRole } from "../../plugins/auth.js";
import { applyRevocation } from "../credentials/service.js";

const CreateCaseBody = z.object({
  credentialId: z.string().uuid(),
  caseType: z.enum(["REVOKE", "CORRECT", "REISSUE"]),
  reasonCode: z.string().min(2).max(100),
  reasonDetail: z.string().min(10).max(4000),
});

const DecisionBody = z.object({ note: z.string().max(4000).optional() });
const IdParams = z.object({ id: z.string().uuid() });

/**
 * Lifecycle cases: revoke / correct / reissue are never immediate row actions
 * (design doc §9.7). Dual control — the requester can never be the decider.
 */
export function registerLifecycleRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/v1/lifecycle-cases", async (request, reply) => {
    const user = requireRole(request, Role.LifecycleAdmin);
    const body = CreateCaseBody.parse(request.body);

    const [credential] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, body.credentialId))
      .limit(1);
    if (!credential) throw AppError.notFound("Credential not found");
    if (credential.lifecycleStatus !== "ISSUED") {
      throw AppError.conflict("Lifecycle cases apply to issued credentials only");
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(lifecycleCases)
        .values({
          credentialId: body.credentialId,
          caseType: body.caseType,
          reasonCode: body.reasonCode,
          reasonDetail: body.reasonDetail,
          requestedBy: user.id,
        })
        .returning({ id: lifecycleCases.id });
      if (!row) throw new Error("failed to create case");
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.LifecycleCaseCreated,
        resourceType: AuditResource.LifecycleCase,
        resourceId: row.id,
        result: AuditResult.Success,
        correlationId: request.id,
        details: {
          credentialId: body.credentialId,
          caseType: body.caseType,
          reasonCode: body.reasonCode,
        },
      });
      return row;
    });

    return reply.status(201).send({ id: created.id });
  });

  app.get("/api/v1/lifecycle-cases", async (request) => {
    requireRole(request, Role.LifecycleAdmin, Role.Approver, Role.Auditor, Role.PlatformAdmin);
    const items = await db
      .select()
      .from(lifecycleCases)
      .orderBy(desc(lifecycleCases.createdAt))
      .limit(100);
    return { items };
  });

  app.post("/api/v1/lifecycle-cases/:id/approve", async (request) => {
    const user = requireRole(request, Role.LifecycleAdmin, Role.Approver);
    const { id } = IdParams.parse(request.params);
    const { note } = DecisionBody.parse(request.body ?? {});

    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(lifecycleCases)
        .where(eq(lifecycleCases.id, id))
        .for("update")
        .limit(1);
      const lifecycleCase = rows[0];
      if (!lifecycleCase) throw AppError.notFound("Case not found");
      if (lifecycleCase.status !== "OPEN") {
        throw AppError.conflict("Case is not open");
      }
      if (lifecycleCase.requestedBy === user.id) {
        await appendAuditEvent(tx, {
          actorType: "USER",
          actorUserId: user.id,
          action: AuditAction.LifecycleCaseApproved,
          resourceType: AuditResource.LifecycleCase,
          resourceId: id,
          result: AuditResult.Denied,
          correlationId: request.id,
          details: { reason: "dual_control_violation" },
        });
        throw AppError.forbidden("Requester cannot decide their own case");
      }

      const actor = { userId: user.id, correlationId: request.id };

      if (lifecycleCase.caseType === "REVOKE") {
        await tx
          .update(lifecycleCases)
          .set({
            status: "COMPLETED",
            decidedBy: user.id,
            decidedAt: new Date(),
            decisionNote: note ?? null,
            updatedAt: new Date(),
          })
          .where(eq(lifecycleCases.id, id));
        await applyRevocation(
          tx,
          lifecycleCase.credentialId,
          actor,
          `${lifecycleCase.reasonCode}: ${lifecycleCase.reasonDetail}`,
          id,
        );
        return;
      }

      // CORRECT / REISSUE: approve the case and open a linked replacement
      // draft. The old credential is superseded when the replacement issues.
      const [original] = await tx
        .select()
        .from(credentials)
        .where(eq(credentials.id, lifecycleCase.credentialId))
        .for("update")
        .limit(1);
      if (!original) throw AppError.notFound("Credential not found");

      const [replacement] = await tx
        .insert(credentials)
        .values({
          credentialTypeId: original.credentialTypeId,
          institutionId: original.institutionId,
          holderId: original.holderId,
          credentialNumber: original.credentialNumber,
          claims: original.claims,
          schemaVersion: original.schemaVersion,
          createdBy: user.id,
        })
        .returning({ id: credentials.id });
      if (!replacement) throw new Error("failed to create replacement");

      await tx.insert(credentialEvents).values({
        credentialId: replacement.id,
        eventType: "replacement_draft_created",
        toStatus: "DRAFT",
        actorUserId: user.id,
        details: { caseId: id, replaces: original.id },
      });
      await tx
        .update(lifecycleCases)
        .set({
          status: "APPROVED",
          decidedBy: user.id,
          decidedAt: new Date(),
          decisionNote: note ?? null,
          replacementCredentialId: replacement.id,
          updatedAt: new Date(),
        })
        .where(eq(lifecycleCases.id, id));
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.LifecycleCaseApproved,
        resourceType: AuditResource.LifecycleCase,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
        details: {
          caseType: lifecycleCase.caseType,
          replacementCredentialId: replacement.id,
        },
      });
    });

    return { ok: true };
  });

  app.post("/api/v1/lifecycle-cases/:id/reject", async (request) => {
    const user = requireRole(request, Role.LifecycleAdmin, Role.Approver);
    const { id } = IdParams.parse(request.params);
    const body = z
      .object({ note: z.string().min(3).max(4000) })
      .parse(request.body);

    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(lifecycleCases)
        .where(eq(lifecycleCases.id, id))
        .for("update")
        .limit(1);
      const lifecycleCase = rows[0];
      if (!lifecycleCase) throw AppError.notFound("Case not found");
      if (lifecycleCase.status !== "OPEN") throw AppError.conflict("Case is not open");
      if (lifecycleCase.requestedBy === user.id) {
        throw AppError.forbidden("Requester cannot decide their own case");
      }
      await tx
        .update(lifecycleCases)
        .set({
          status: "REJECTED",
          decidedBy: user.id,
          decidedAt: new Date(),
          decisionNote: body.note,
          updatedAt: new Date(),
        })
        .where(eq(lifecycleCases.id, id));
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.LifecycleCaseRejected,
        resourceType: AuditResource.LifecycleCase,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
      });
    });

    return { ok: true };
  });
}
