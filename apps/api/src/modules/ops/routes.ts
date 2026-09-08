import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appendAuditEvent, credentials, type Db } from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  QUEUE_ARTIFACTS,
  QUEUE_NOTIFICATIONS,
  Role,
} from "@diplommn/shared";
import type { Storage } from "@diplommn/storage";
import { requireRole } from "../../plugins/auth.js";
import type { JobQueues } from "../../queues.js";

/**
 * Technical operations surface (OPS-001 / JOB-00x lite). Read access for
 * platform admins and auditors; mutating actions (retry, regenerate) are
 * platform-admin only and audited. The dedicated technical-ops role (R8)
 * arrives when V2 infrastructure lands — reusing platform_admin until then.
 *
 * Monitoring boundary (D2V2 §20.3): no secrets, endpoints, provider account
 * details or raw payloads are ever returned — only operational metadata.
 */

type Health = {
  status: "OPERATIONAL" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latencyMs?: number;
  error?: string;
};

async function timed(fn: () => Promise<unknown>): Promise<Health> {
  const start = Date.now();
  try {
    await fn();
    const latencyMs = Date.now() - start;
    return { status: latencyMs > 2000 ? "DEGRADED" : "OPERATIONAL", latencyMs };
  } catch (e) {
    return {
      status: "DOWN",
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : "unreachable",
    };
  }
}

const QueueParam = z.enum([QUEUE_ARTIFACTS, QUEUE_NOTIFICATIONS]);

export function registerOpsRoutes(
  app: FastifyInstance,
  db: Db,
  storage: Storage,
  queues: JobQueues | null,
): void {
  function queueByName(name: string) {
    if (!queues) return null;
    return name === QUEUE_ARTIFACTS ? queues.artifacts : queues.notifications;
  }

  app.get("/api/v1/ops/overview", async (request) => {
    requireRole(request, Role.PlatformAdmin, Role.Auditor);

    const [database, redis, objectStorage] = await Promise.all([
      timed(() => db.execute(sql`SELECT 1`)),
      queues
        ? timed(() => queues.connection.ping())
        : Promise.resolve<Health>({ status: "UNKNOWN", error: "queues not configured" }),
      timed(() => storage.ensureBucket()),
    ]);

    const queueCounts: Record<string, Record<string, number>> = {};
    if (queues) {
      for (const name of [QUEUE_ARTIFACTS, QUEUE_NOTIFICATIONS]) {
        const q = queueByName(name)!;
        queueCounts[name] = await q.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
        );
      }
    }

    return {
      checkedAt: new Date().toISOString(),
      integrations: {
        postgres: database,
        redis,
        objectStorage,
      },
      queues: queueCounts,
    };
  });

  app.get("/api/v1/ops/jobs/failed", async (request) => {
    requireRole(request, Role.PlatformAdmin, Role.Auditor);
    const { queue } = z
      .object({ queue: QueueParam })
      .parse(request.query);
    const q = queueByName(queue);
    if (!q) throw AppError.conflict("Job queues are not configured");

    const failed = await q.getFailed(0, 49);
    return {
      items: failed.map((j) => ({
        id: j.id,
        name: j.name,
        // Payload is limited metadata (credentialId) — safe to display.
        data: j.data as Record<string, unknown>,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason,
        timestamp: j.timestamp,
        finishedOn: j.finishedOn,
      })),
    };
  });

  app.post("/api/v1/ops/jobs/:queue/:jobId/retry", async (request) => {
    const user = requireRole(request, Role.PlatformAdmin);
    const { queue, jobId } = z
      .object({ queue: QueueParam, jobId: z.string().min(1).max(200) })
      .parse(request.params);
    const q = queueByName(queue);
    if (!q) throw AppError.conflict("Job queues are not configured");

    const job = await q.getJob(jobId);
    if (!job) throw AppError.notFound("Job not found");
    const state = await job.getState();
    if (state !== "failed") {
      throw AppError.conflict(`Only failed jobs can be retried (state: ${state})`);
    }
    await job.retry();
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.OpsJobRetried,
        resourceType: AuditResource.Credential,
        resourceId:
          typeof (job.data as { credentialId?: string }).credentialId === "string"
            ? (job.data as { credentialId: string }).credentialId
            : null,
        result: AuditResult.Success,
        correlationId: request.id,
        details: { queue, jobId, jobName: job.name },
      });
    });
    return { ok: true };
  });

  app.post("/api/v1/ops/credentials/:id/regenerate-artifacts", async (request) => {
    const user = requireRole(request, Role.PlatformAdmin);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!queues) throw AppError.conflict("Job queues are not configured");

    const rows = await db
      .select({ certificateId: credentials.certificateId })
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound("Credential not found");
    if (!row.certificateId) {
      throw AppError.conflict("Credential has not been issued");
    }

    await queues.enqueuePdf(id, { force: true });
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.OpsArtifactsRegenerated,
        resourceType: AuditResource.Credential,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
      });
    });
    return { ok: true };
  });
}
