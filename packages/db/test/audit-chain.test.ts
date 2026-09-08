import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  appendAuditEvent,
  AUDIT_GENESIS_HASH,
  createDb,
  auditEvents,
  verifyAuditChain,
  type Db,
} from "../src/index.js";
import type pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("audit chain (integration)", () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    ({ db, pool } = createDb(DATABASE_URL));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("appends linked events and verifies the whole chain", async () => {
    for (let i = 0; i < 5; i++) {
      await db.transaction(async (tx) => {
        await appendAuditEvent(tx, {
          actorType: "SYSTEM",
          action: `test.chain.${i}`,
          resourceType: "credential",
          resourceId: `test-${i}`,
          source: "SYSTEM",
          result: "SUCCESS",
          details: { i, nested: { бичиг: "тест" } },
        });
      });
    }
    const res = await verifyAuditChain(db);
    expect(res.ok).toBe(true);
    expect(res.checked).toBeGreaterThanOrEqual(5);
  });

  it("survives concurrent appends without forking the chain", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.transaction(async (tx) => {
          await appendAuditEvent(tx, {
            actorType: "SYSTEM",
            action: "test.concurrent",
            resourceType: "credential",
            resourceId: `conc-${i}`,
            source: "SYSTEM",
            result: "SUCCESS",
          });
        }),
      ),
    );
    const res = await verifyAuditChain(db);
    expect(res.ok).toBe(true);
  });

  it("detects tampering with a stored event", async () => {
    // Tamper directly (simulating a DB-level attacker), then verify.
    await db.execute(
      sql`UPDATE audit_events SET result = 'FORGED' WHERE seq = (SELECT max(seq) FROM audit_events)`,
    );
    const res = await verifyAuditChain(db);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("event_hash mismatch");
    // Restore so later runs stay clean.
    await db.execute(
      sql`UPDATE audit_events SET result = 'SUCCESS' WHERE seq = (SELECT max(seq) FROM audit_events)`,
    );
    const res2 = await verifyAuditChain(db);
    expect(res2.ok).toBe(true);
  });

  it("uses the documented genesis hash for the first event", async () => {
    const first = await db
      .select({ prevHash: auditEvents.prevHash })
      .from(auditEvents)
      .orderBy(auditEvents.seq)
      .limit(1);
    expect(first[0]?.prevHash).toBe(AUDIT_GENESIS_HASH);
  });
});
