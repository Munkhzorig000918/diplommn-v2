import { randomUUID } from "node:crypto";
import { asc, desc, gt, sql } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "@diplommn/shared";
import type { DbLike, DbTx } from "./client.js";
import { auditEvents } from "./schema.js";

/**
 * Append-only, hash-chained audit log (architecture §8 — the future anchoring
 * basis). Every event's hash covers its own content plus the previous event's
 * hash; appends are serialized with a transaction-scoped advisory lock so the
 * chain never forks under concurrency. `seq` is DB-generated and intentionally
 * excluded from the hash (identity values can be burned by rolled-back
 * transactions); chain integrity comes from prev_hash linkage in seq order.
 */

const AUDIT_CHAIN_LOCK_KEY = 427_001; // arbitrary app-wide constant
export const AUDIT_GENESIS_HASH = sha256Hex("diplommn-audit-genesis-v1");

export interface AuditEventInput {
  actorType: "USER" | "SYSTEM" | "PUBLIC";
  actorUserId?: string | null;
  actorDisplay?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  source?: "UI" | "API" | "IMPORT" | "JOB" | "SYSTEM";
  result: string;
  correlationId?: string | null;
  ip?: string | null;
  /** Redacted structured payload — callers must not include raw PII/secrets. */
  details?: unknown;
}

function computeEventHash(fields: {
  id: string;
  ts: string;
  actorType: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  source: string;
  result: string;
  correlationId: string | null;
  details: unknown;
  prevHash: string;
}): string {
  return sha256Hex(canonicalJson(fields));
}

/** Must be called inside a transaction (the same one as the domain change). */
export async function appendAuditEvent(
  tx: DbTx,
  input: AuditEventInput,
): Promise<{ id: string; eventHash: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);

  const last = await tx
    .select({ eventHash: auditEvents.eventHash })
    .from(auditEvents)
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const prevHash = last[0]?.eventHash ?? AUDIT_GENESIS_HASH;

  const id = randomUUID();
  const ts = new Date();
  const normalized = {
    id,
    ts: ts.toISOString(),
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    source: input.source ?? "API",
    result: input.result,
    correlationId: input.correlationId ?? null,
    details: input.details ?? null,
    prevHash,
  };
  const eventHash = computeEventHash(normalized);

  await tx.insert(auditEvents).values({
    id,
    ts,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    actorDisplay: input.actorDisplay ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    source: input.source ?? "API",
    result: input.result,
    correlationId: input.correlationId ?? null,
    ip: input.ip ?? null,
    details: input.details ?? null,
    prevHash,
    eventHash,
  });

  return { id, eventHash };
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq?: bigint;
  reason?: string;
}

/**
 * Recompute every event hash and prev-hash linkage in seq order.
 * An integrity failure is a critical security event (design doc §19.5).
 */
export async function verifyAuditChain(db: DbLike): Promise<ChainVerification> {
  const batchSize = 1000;
  let lastSeq: bigint | null = null;
  let prevHash = AUDIT_GENESIS_HASH;
  let checked = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(lastSeq === null ? undefined : gt(auditEvents.seq, lastSeq))
      .orderBy(asc(auditEvents.seq))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.prevHash !== prevHash) {
        return {
          ok: false,
          checked,
          brokenAtSeq: row.seq,
          reason: "prev_hash does not match previous event_hash",
        };
      }
      const recomputed = computeEventHash({
        id: row.id,
        ts: row.ts.toISOString(),
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        source: row.source,
        result: row.result,
        correlationId: row.correlationId,
        details: row.details,
        prevHash: row.prevHash,
      });
      if (recomputed !== row.eventHash) {
        return {
          ok: false,
          checked,
          brokenAtSeq: row.seq,
          reason: "event_hash mismatch (record content altered)",
        };
      }
      prevHash = row.eventHash;
      lastSeq = row.seq;
      checked += 1;
    }
    if (rows.length < batchSize) break;
  }

  return { ok: true, checked };
}
