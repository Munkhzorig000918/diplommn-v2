import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, verifyAuditChain, type Db } from "@diplommn/db";
import { Role } from "@diplommn/shared";
import { requireRole } from "../../plugins/auth.js";

const ListQuery = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  beforeSeq: z.coerce.bigint().optional(),
  action: z.string().max(100).optional(),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(100).optional(),
});

export function registerAuditRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/v1/audit/events", async (request) => {
    requireRole(request, Role.Auditor, Role.PlatformAdmin, Role.LifecycleAdmin);
    const query = ListQuery.parse(request.query);

    const conditions: SQL[] = [];
    if (query.beforeSeq !== undefined) conditions.push(lt(auditEvents.seq, query.beforeSeq));
    if (query.action) conditions.push(eq(auditEvents.action, query.action));
    if (query.resourceType) conditions.push(eq(auditEvents.resourceType, query.resourceType));
    if (query.resourceId) conditions.push(eq(auditEvents.resourceId, query.resourceId));

    const rows = await db
      .select()
      .from(auditEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(query.limit);

    return {
      items: rows.map((r) => ({ ...r, seq: r.seq.toString() })),
    };
  });

  /**
   * Full-chain integrity verification. A failure here is a critical security
   * event (design doc §19.5) — the API reports it; alerting policy is ops-level.
   */
  app.post("/api/v1/audit/verify-integrity", async (request) => {
    requireRole(request, Role.Auditor, Role.PlatformAdmin);
    const result = await verifyAuditChain(db);
    return {
      ok: result.ok,
      checked: result.checked,
      ...(result.brokenAtSeq !== undefined
        ? { brokenAtSeq: result.brokenAtSeq.toString(), reason: result.reason }
        : {}),
    };
  });
}
