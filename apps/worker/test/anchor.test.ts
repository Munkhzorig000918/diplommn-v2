import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  anchorBatches,
  createDb,
  credentials,
  credentialTypes,
  holders,
  institutions,
  users,
  type Db,
} from "@diplommn/db";
import {
  computeContentHash,
  computeMerkleRoot,
  generateCertificateId,
  generateSaltHex,
  normalizeLeafHex,
} from "@diplommn/shared";
import {
  computeBatchWindow,
  runAnchorBatch,
  type AnchorChain,
} from "../src/jobs/anchor-batch.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";

const ZERO_ROOT = `0x${"0".repeat(64)}`;

/** In-memory AnchorRegistry mimicking the real contract's semantics. */
function fakeChain(overrides: Partial<AnchorChain> = {}) {
  const anchored = new Map<bigint, string>();
  let txCounter = 0;
  const calls = { anchorRoot: 0 };
  const chain: AnchorChain = {
    chainId: 31337,
    contractAddress: "0xfakefakefakefakefakefakefakefakefakefake",
    async rootOf(batchId) {
      return anchored.get(batchId) ?? ZERO_ROOT;
    },
    async anchorRoot(batchId, root) {
      calls.anchorRoot += 1;
      if (anchored.has(batchId)) throw new Error("AlreadyAnchored");
      anchored.set(batchId, root);
      txCounter += 1;
      return { txHash: `0xtx${txCounter}` };
    },
    async waitForReceipt() {
      return { status: "success", blockNumber: 123n };
    },
    ...overrides,
  };
  return { chain, anchored, calls };
}

describe("anchor batch job (integration)", () => {
  let db: Db;
  let fixtureIds: { userId: string; instId: string; typeId: string };

  beforeAll(async () => {
    ({ db } = createDb(DATABASE_URL));
    // The dev DB is shared: earlier runs / API tests leave AWAITING_BATCH
    // credentials behind, and the job correctly sweeps such stragglers into
    // the next batch. Neutralize them so counts in this suite stay exact.
    await db
      .update(credentials)
      .set({ anchorStatus: "NOT_ELIGIBLE" })
      .where(eq(credentials.anchorStatus, "AWAITING_BATCH"));
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        email: `anchor-test-${suffix}@test.diplom.mn`,
        fullName: "Anchor Test",
        status: "ACTIVE",
      })
      .returning({ id: users.id });
    const [inst] = await db
      .insert(institutions)
      .values({ code: `AT-${suffix}`, nameMn: "Тест ИС", nameEn: "Test U" })
      .returning({ id: institutions.id });
    const [type] = await db
      .insert(credentialTypes)
      .values({
        code: `AT_DIPLOMA_${suffix}`,
        kind: "DIPLOMA",
        nameMn: "Тест диплом",
        nameEn: "Test diploma",
      })
      .returning({ id: credentialTypes.id });
    fixtureIds = { userId: user!.id, instId: inst!.id, typeId: type!.id };
  });

  async function seedIssuedCredential(issuedAt: Date): Promise<{
    id: string;
    contentHash: string;
  }> {
    const suffix = randomUUID().slice(0, 8);
    const [holder] = await db
      .insert(holders)
      .values({
        lastName: "Тест",
        firstName: `Holder ${suffix}`,
        registrationNumber: `AT${randomUUID().slice(0, 10)}`,
      })
      .returning({ id: holders.id });
    const claims = { program: `Program ${suffix}` };
    const salt = generateSaltHex();
    const { hash, alg, canonicalization } = computeContentHash(claims, salt);
    const [cred] = await db
      .insert(credentials)
      .values({
        credentialTypeId: fixtureIds.typeId,
        institutionId: fixtureIds.instId,
        holderId: holder!.id,
        claims,
        certificateId: generateCertificateId(),
        lifecycleStatus: "ISSUED",
        anchorStatus: "AWAITING_BATCH",
        contentSalt: salt,
        contentHash: hash,
        contentHashAlg: alg,
        canonicalization,
        issuedAt,
        createdBy: fixtureIds.userId,
      })
      .returning({ id: credentials.id, contentHash: credentials.contentHash });
    return { id: cred!.id, contentHash: cred!.contentHash! };
  }

  /** Fresh, never-used batch days: random far-future start per run, so
   * reruns against the same dev database never collide on batch ids. */
  let dayCursor =
    new Date("2100-01-01T12:00:00Z").getTime() +
    Math.floor(Math.random() * 900_000) * 24 * 60 * 60 * 1000;
  function nextBatchDay(): { batchDate: string; issuedAt: Date; now: Date } {
    const day = new Date(dayCursor);
    dayCursor += 3 * 24 * 60 * 60 * 1000;
    const batchDate = day.toISOString().slice(0, 10);
    // Issued mid-day UB; "now" is well after that day closed.
    return {
      batchDate,
      issuedAt: new Date(day.getTime()),
      now: new Date(day.getTime() + 2 * 24 * 60 * 60 * 1000),
    };
  }

  it("computes the closed UB day window", () => {
    // 2026-09-09 18:30 UTC = 2026-09-10 02:30 UB → closed day is 2026-09-09.
    const w = computeBatchWindow(new Date("2026-09-09T18:30:00Z"));
    expect(w.batchDate).toBe("2026-09-09");
    expect(w.batchId).toBe(20260909n);
    // Cutoff = 2026-09-10 00:00 UB = 2026-09-09 16:00 UTC.
    expect(w.cutoff.toISOString()).toBe("2026-09-09T16:00:00.000Z");

    // 2026-09-09 15:59 UTC is still 2026-09-09 UB → closed day is the 8th.
    expect(computeBatchWindow(new Date("2026-09-09T15:59:00Z")).batchDate).toBe(
      "2026-09-08",
    );
  });

  it("anchors eligible credentials and confirms them", async () => {
    const { batchDate, issuedAt, now } = nextBatchDay();
    const a = await seedIssuedCredential(issuedAt);
    const b = await seedIssuedCredential(issuedAt);
    const { chain, anchored } = fakeChain();

    const result = await runAnchorBatch(db, chain, { now, batchDate });
    expect(result.outcome).toBe("confirmed");
    if (result.outcome !== "confirmed") throw new Error("unreachable");
    // Two credential leaves + (when the audit log is non-empty) the audit
    // chain head — the log is the anchoring basis (architecture §8).
    expect(result.leafCount).toBeGreaterThanOrEqual(2);
    expect(result.leafCount).toBeLessThanOrEqual(3);
    expect(anchored.get(result.batchId)).toBe(result.merkleRoot);

    const rows = await db
      .select({
        anchorStatus: credentials.anchorStatus,
        anchorBatchId: credentials.anchorBatchId,
      })
      .from(credentials)
      .where(inArray(credentials.id, [a.id, b.id]));
    expect(rows.map((r) => r.anchorStatus)).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(rows[0]?.anchorBatchId).toBeTruthy();

    const [batch] = await db
      .select()
      .from(anchorBatches)
      .where(eq(anchorBatches.id, rows[0]!.anchorBatchId!));
    expect(batch?.status).toBe("CONFIRMED");
    expect(batch?.blockNumber).toBe(123n);
    // Both credential leaves are in the batch and the root recomputes from
    // the stored leaf set (which may also carry the audit-chain head).
    const leaves = batch!.leaves as string[];
    expect(leaves).toContain(normalizeLeafHex(a.contentHash));
    expect(leaves).toContain(normalizeLeafHex(b.contentHash));
    expect(batch!.leafCount).toBe(leaves.length);
    expect(batch!.merkleRoot).toBe(computeMerkleRoot(leaves));
  });

  it("skips days with nothing to anchor", async () => {
    const { batchDate, now } = nextBatchDay();
    const { chain, calls } = fakeChain();
    const result = await runAnchorBatch(db, chain, { now, batchDate });
    expect(result.outcome).toBe("empty");
    expect(calls.anchorRoot).toBe(0);
  });

  it("re-running a confirmed batch does not re-anchor", async () => {
    const { batchDate, issuedAt, now } = nextBatchDay();
    await seedIssuedCredential(issuedAt);
    const { chain, calls } = fakeChain();

    const first = await runAnchorBatch(db, chain, { now, batchDate });
    expect(first.outcome).toBe("confirmed");
    const second = await runAnchorBatch(db, chain, { now, batchDate });
    expect(second.outcome).toBe("already-confirmed");
    expect(calls.anchorRoot).toBe(1);
  });

  it("recovers when the root landed on-chain but the DB missed it", async () => {
    const { batchDate, issuedAt, now } = nextBatchDay();
    const cred = await seedIssuedCredential(issuedAt);
    const { chain, anchored } = fakeChain({
      async waitForReceipt() {
        throw new Error("rpc lost the receipt");
      },
    });

    await expect(
      runAnchorBatch(db, chain, { now, batchDate }),
    ).rejects.toThrow(/rpc lost the receipt/);

    // The tx actually landed (fake chain recorded it). Retry with a healthy
    // RPC: the rootOf() guard must confirm without a second transaction.
    const healthy = fakeChain();
    healthy.anchored.set(
      computeBatchWindow(now, batchDate).batchId,
      anchored.get(computeBatchWindow(now, batchDate).batchId)!,
    );
    const retry = await runAnchorBatch(db, healthy.chain, { now, batchDate });
    expect(retry.outcome).toBe("confirmed");
    expect(healthy.calls.anchorRoot).toBe(0);

    const [row] = await db
      .select({ anchorStatus: credentials.anchorStatus })
      .from(credentials)
      .where(eq(credentials.id, cred.id));
    expect(row?.anchorStatus).toBe("CONFIRMED");
  });

  it("flags a divergent on-chain root and never overwrites it", async () => {
    const { batchDate, issuedAt, now } = nextBatchDay();
    await seedIssuedCredential(issuedAt);
    const evilRoot = normalizeLeafHex("ab".repeat(32));
    const { chain, calls } = fakeChain();
    // Someone already anchored a different root under our batch id.
    await chain.anchorRoot(computeBatchWindow(now, batchDate).batchId, evilRoot);
    calls.anchorRoot = 0;

    const result = await runAnchorBatch(db, chain, { now, batchDate });
    expect(result.outcome).toBe("root-mismatch");
    expect(calls.anchorRoot).toBe(0);

    const { batchId } = computeBatchWindow(now, batchDate);
    const [batch] = await db
      .select()
      .from(anchorBatches)
      .where(eq(anchorBatches.batchId, batchId));
    expect(batch?.status).toBe("FAILED");
    expect(batch?.lastError).toMatch(/differs/);
  });

  it("marks the batch FAILED and rethrows when submission fails", async () => {
    const { batchDate, issuedAt, now } = nextBatchDay();
    await seedIssuedCredential(issuedAt);
    const { chain } = fakeChain({
      async anchorRoot() {
        throw new Error("rpc down");
      },
    });

    await expect(
      runAnchorBatch(db, chain, { now, batchDate }),
    ).rejects.toThrow(/rpc down/);

    const { batchId } = computeBatchWindow(now, batchDate);
    const [batch] = await db
      .select()
      .from(anchorBatches)
      .where(eq(anchorBatches.batchId, batchId));
    expect(batch?.status).toBe("FAILED");
    expect(batch?.lastError).toMatch(/rpc down/);

    // Retry with a healthy chain succeeds using the same batch row.
    const healthy = fakeChain();
    const retry = await runAnchorBatch(db, healthy.chain, { now, batchDate });
    expect(retry.outcome).toBe("confirmed");
  });
});
