/**
 * Daily anchor batch (architecture §4/§8): collect the closed issuance day's
 * salted content hashes, build the Merkle root, anchor it on-chain, track
 * per-credential anchor status BATCHED → SUBMITTED → CONFIRMED.
 *
 * Idempotent by construction — safe to re-run after any crash:
 *  - the batch row is keyed by the on-chain batch id (unique);
 *  - before submitting we read rootOf(batchId); a root already on-chain that
 *    matches ours means an earlier attempt succeeded (confirm, no new tx);
 *    a DIFFERENT root is a critical integrity signal, never overwritten.
 *
 * The chain is injected (AnchorChain) so the batching logic is testable
 * without an RPC endpoint. DB tx ≠ chain tx: batch rows exist before any
 * submission and survive chain failures for retry.
 */
import { and, asc, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { anchorBatches, auditEvents, credentials, type Db } from "@diplommn/db";
import { computeMerkleRoot, normalizeLeafHex } from "@diplommn/shared";

/** Asia/Ulaanbaatar is UTC+8 with no DST (since 2017) — fixed offset. */
const UB_OFFSET_MS = 8 * 60 * 60 * 1000;
const ZERO_ROOT = `0x${"0".repeat(64)}`;

export interface AnchorChain {
  chainId: number;
  contractAddress: string;
  /** Returns the anchored root for a batch id, or the zero hash if unset. */
  rootOf(batchId: bigint): Promise<string>;
  anchorRoot(batchId: bigint, root: string): Promise<{ txHash: string }>;
  waitForReceipt(
    txHash: string,
  ): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

export interface BatchWindow {
  /** On-chain batch id: YYYYMMDD of the closed Ulaanbaatar calendar day. */
  batchId: bigint;
  /** The closed day as "YYYY-MM-DD". */
  batchDate: string;
  /** Instant of the following UB midnight — credentials issued before this. */
  cutoff: Date;
}

/** Window for the UB day that has already closed at instant `now`. */
export function computeBatchWindow(now: Date, batchDate?: string): BatchWindow {
  if (batchDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(batchDate);
    if (!match) throw new Error(`batchDate must be YYYY-MM-DD: ${batchDate}`);
    const [, y, m, d] = match;
    const dayStartUtc = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const cutoff = new Date(dayStartUtc + 24 * 60 * 60 * 1000 - UB_OFFSET_MS);
    if (cutoff.getTime() > now.getTime()) {
      throw new Error(`Batch day ${batchDate} has not closed yet (UB time)`);
    }
    return { batchId: BigInt(`${y}${m}${d}`), batchDate, cutoff };
  }

  const ub = new Date(now.getTime() + UB_OFFSET_MS);
  const todayStartUtc = Date.UTC(
    ub.getUTCFullYear(),
    ub.getUTCMonth(),
    ub.getUTCDate(),
  );
  const closed = new Date(todayStartUtc - 24 * 60 * 60 * 1000);
  const y = closed.getUTCFullYear();
  const m = String(closed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(closed.getUTCDate()).padStart(2, "0");
  return {
    batchId: BigInt(`${y}${m}${d}`),
    batchDate: `${y}-${m}-${d}`,
    cutoff: new Date(todayStartUtc - UB_OFFSET_MS),
  };
}

export type AnchorBatchResult =
  | { outcome: "empty"; batchDate: string }
  | { outcome: "already-confirmed"; batchDate: string; batchId: bigint }
  | {
      outcome: "confirmed";
      batchDate: string;
      batchId: bigint;
      merkleRoot: string;
      leafCount: number;
      txHash: string | null;
      blockNumber: bigint | null;
    }
  | {
      outcome: "root-mismatch";
      batchDate: string;
      batchId: bigint;
      ourRoot: string;
      onChainRoot: string;
    };

export async function runAnchorBatch(
  db: Db,
  chain: AnchorChain,
  opts: { now?: Date; batchDate?: string } = {},
): Promise<AnchorBatchResult> {
  const window = computeBatchWindow(opts.now ?? new Date(), opts.batchDate);

  // Phase A — assemble (or reload) the batch row atomically.
  const batch = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(anchorBatches)
      .where(eq(anchorBatches.batchId, window.batchId))
      .for("update");
    if (existing) return existing;

    const eligible = await tx
      .select({
        id: credentials.id,
        contentHash: credentials.contentHash,
        vcHash: credentials.vcHash,
      })
      .from(credentials)
      .where(
        and(
          eq(credentials.anchorStatus, "AWAITING_BATCH"),
          isNotNull(credentials.contentHash),
          lt(credentials.issuedAt, window.cutoff),
        ),
      )
      .orderBy(asc(credentials.issuedAt))
      .for("update");
    if (eligible.length === 0) return null;

    // Leaf = salted hash of the signed VC when one exists (architecture §2);
    // claims-hash fallback covers kinds without a VC schema yet (gap #29
    // labels these "database-verified" rather than independently verifiable).
    const leaves = eligible.map((c) =>
      normalizeLeafHex(c.vcHash ?? c.contentHash!),
    );

    // The hash-chained audit log is the basis for anchoring (architecture
    // §8): committing the current chain head to the public root makes the
    // entire audit history up to this batch tamper-evident. Retention and
    // cadence details remain open decision #24.
    const [auditHead] = await tx
      .select({ eventHash: auditEvents.eventHash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    if (auditHead) leaves.push(normalizeLeafHex(auditHead.eventHash));

    const sortedLeaves = [...new Set(leaves)].sort();
    const merkleRoot = computeMerkleRoot(sortedLeaves);
    const [created] = await tx
      .insert(anchorBatches)
      .values({
        batchId: window.batchId,
        merkleRoot,
        leafCount: sortedLeaves.length,
        leaves: sortedLeaves,
        chainId: chain.chainId,
        contractAddress: chain.contractAddress,
      })
      .returning();
    await tx
      .update(credentials)
      .set({
        anchorStatus: "BATCHED",
        anchorBatchId: created!.id,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          credentials.id,
          eligible.map((c) => c.id),
        ),
      );
    return created!;
  });

  if (!batch) return { outcome: "empty", batchDate: window.batchDate };
  if (batch.status === "CONFIRMED") {
    return {
      outcome: "already-confirmed",
      batchDate: window.batchDate,
      batchId: window.batchId,
    };
  }

  const memberIds = db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.anchorBatchId, batch.id));

  async function setCredentialStatus(status: "SUBMITTED" | "CONFIRMED") {
    await db
      .update(credentials)
      .set({ anchorStatus: status, updatedAt: new Date() })
      .where(inArray(credentials.id, memberIds));
  }

  async function markConfirmed(
    txHash: string | null,
    blockNumber: bigint | null,
  ): Promise<AnchorBatchResult> {
    await db
      .update(anchorBatches)
      .set({
        status: "CONFIRMED",
        ...(txHash ? { txHash } : {}),
        ...(blockNumber !== null ? { blockNumber } : {}),
        confirmedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(anchorBatches.id, batch!.id));
    await setCredentialStatus("CONFIRMED");
    return {
      outcome: "confirmed",
      batchDate: window.batchDate,
      batchId: window.batchId,
      merkleRoot: batch!.merkleRoot,
      leafCount: batch!.leafCount,
      txHash,
      blockNumber,
    };
  }

  // Phase B — submit, guarded by the on-chain state.
  const onChainRoot = normalizeLeafHex(await chain.rootOf(window.batchId));
  if (onChainRoot !== ZERO_ROOT) {
    if (onChainRoot === batch.merkleRoot) {
      // A previous attempt landed; we crashed before recording it.
      return markConfirmed(batch.txHash, batch.blockNumber);
    }
    await db
      .update(anchorBatches)
      .set({
        status: "FAILED",
        lastError: `On-chain root ${onChainRoot} differs from computed ${batch.merkleRoot}`,
        updatedAt: new Date(),
      })
      .where(eq(anchorBatches.id, batch.id));
    return {
      outcome: "root-mismatch",
      batchDate: window.batchDate,
      batchId: window.batchId,
      ourRoot: batch.merkleRoot,
      onChainRoot,
    };
  }

  try {
    const { txHash } = await chain.anchorRoot(window.batchId, batch.merkleRoot);
    await db
      .update(anchorBatches)
      .set({
        status: "SUBMITTED",
        txHash,
        attempts: batch.attempts + 1,
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(anchorBatches.id, batch.id));
    await setCredentialStatus("SUBMITTED");

    const receipt = await chain.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      throw new Error(`Anchor transaction ${txHash} reverted`);
    }
    return await markConfirmed(txHash, receipt.blockNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(anchorBatches)
      .set({
        status: "FAILED",
        attempts: batch.attempts + 1,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(anchorBatches.id, batch.id));
    // Credentials stay BATCHED/SUBMITTED; BullMQ retries re-enter here and
    // the rootOf() guard prevents double-anchoring.
    throw err;
  }
}
