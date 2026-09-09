/**
 * Background worker (BullMQ over Redis).
 *
 * Jobs are idempotent, retried with exponential backoff, and dead-lettered
 * (kept in the failed set) for the ops console. Job state never replaces
 * credential lifecycle state; PDF/notification failures never roll back
 * issuance (availability ≠ integrity).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@diplommn/db";
import { createNotifier } from "@diplommn/notify";
import { createStorage } from "@diplommn/storage";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_ANCHOR_BATCH,
  JOB_GENERATE_PDF,
  JOB_NOTIFY_ISSUED,
  JOB_PUBLISH_STATUS_LIST,
  JOB_SIGN_VC,
  QUEUE_ANCHORS,
  QUEUE_ARTIFACTS,
  QUEUE_NOTIFICATIONS,
  QUEUE_SIGNING,
  type AnchorBatchJobData,
  type GeneratePdfJobData,
  type NotifyIssuedJobData,
  type SignVcJobData,
} from "@diplommn/shared";
import { UnrecoverableError } from "bullmq";
import { generatePdfArtifact } from "./jobs/generate-pdf.js";
import { notifyIssued } from "./jobs/notify-issued.js";
import { runAnchorBatch } from "./jobs/anchor-batch.js";
import { signVcForCredential, type VcSigningContext } from "./jobs/sign-vc.js";
import { publishStatusList } from "./jobs/publish-status-list.js";
import { anchorChainConfigFromEnv, createAnchorChain } from "./chain.js";
import { readFileSync } from "node:fs";
import { createLocalP256Signer } from "@diplommn/vc";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env"), quiet: true });

const connection = new Redis(
  process.env.REDIS_URL ?? "redis://localhost:6380",
  // BullMQ requirement: blocking commands must never give up retrying.
  { maxRetriesPerRequest: null },
);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const { db, pool } = createDb();
const storage = createStorage();
const notifier = createNotifier();
await storage.ensureBucket();

const notificationsQueue = new Queue(QUEUE_NOTIFICATIONS, {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const artifactsWorker = new Worker<GeneratePdfJobData>(
  QUEUE_ARTIFACTS,
  async (job) => {
    if (job.name !== JOB_GENERATE_PDF) {
      console.log(`[worker] ignoring unknown job ${job.name}`);
      return;
    }
    const result = await generatePdfArtifact(
      db,
      storage,
      webOrigin,
      job.data.credentialId,
    );
    if (result.skipped) {
      console.log(
        `[worker] pdf skipped for ${job.data.credentialId}: ${result.skipped}`,
      );
      return result;
    }
    console.log(
      `[worker] pdf generated for ${job.data.credentialId} → ${result.objectKey}`,
    );
    // Chain the holder notification once the artifact exists.
    // BullMQ forbids ":" in custom job IDs; include the parent job id so a
    // forced regeneration re-sends the notification for the fresh artifact.
    await notificationsQueue.add(
      JOB_NOTIFY_ISSUED,
      { credentialId: job.data.credentialId } satisfies NotifyIssuedJobData,
      { jobId: `notify-${job.data.credentialId}-${job.id}`.replaceAll(":", "-") },
    );
    return result;
  },
  { connection, concurrency: 4 },
);

const notificationsWorker = new Worker<NotifyIssuedJobData>(
  QUEUE_NOTIFICATIONS,
  async (job) => {
    if (job.name !== JOB_NOTIFY_ISSUED) return;
    const result = await notifyIssued(
      db,
      notifier,
      webOrigin,
      job.data.credentialId,
    );
    console.log(
      `[worker] notification for ${job.data.credentialId}: ${
        result.sent ? "sent" : `skipped (${result.reason})`
      }`,
    );
    return result;
  },
  { connection, concurrency: 4 },
);

// VC signing (Phase 1) is opt-in: enabled when a signing key is configured.
// Dev uses the local P-256 JWK from packages/did; production replaces this
// with a KMS/HSM-backed signer on an isolated host.
let signingWorker: Worker | null = null;
const signingKeyFile = process.env.VC_SIGNING_KEY_FILE;
if (signingKeyFile) {
  const privateJwk = JSON.parse(readFileSync(signingKeyFile, "utf8")) as {
    kty?: string;
    crv?: string;
  };
  const baseUrl = process.env.VC_PUBLIC_BASE_URL ?? webOrigin;
  const signingContext: VcSigningContext = {
    signer: createLocalP256Signer(privateJwk, process.env.VC_KEY_ID ?? "issuer-1"),
    issuerDid: process.env.VC_ISSUER_DID ?? "did:web:diplom.mn",
    baseUrl,
    statusListCredential:
      process.env.VC_STATUS_LIST_URL ?? `${baseUrl}/status/1`,
  };
  const signingQueue = new Queue(QUEUE_SIGNING, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  // Daily status-list freshness refresh at 00:10 Ulaanbaatar (gap #14's
  // freshness policy is open; a daily floor keeps validFrom recent).
  await signingQueue.upsertJobScheduler(
    "daily-status-list",
    { pattern: "10 0 * * *", tz: "Asia/Ulaanbaatar" },
    { name: JOB_PUBLISH_STATUS_LIST, data: {} },
  );
  await signingQueue.close();

  signingWorker = new Worker(
    QUEUE_SIGNING,
    async (job) => {
      if (job.name === JOB_PUBLISH_STATUS_LIST) {
        const result = await publishStatusList(db, signingContext);
        console.log(
          `[worker] status list ${result.listId} published (${result.revokedCount} revoked, sha256 ${result.sha256.slice(0, 12)}…)`,
        );
        return result;
      }
      if (job.name !== JOB_SIGN_VC) return;
      const { credentialId } = job.data as SignVcJobData;
      const result = await signVcForCredential(db, signingContext, credentialId);
      console.log(
        `[worker] sign-vc ${credentialId}: ` +
          (result.signed
            ? `signed (status index ${result.statusListIndex})`
            : `skipped (${result.skipped})`),
      );
      return result;
    },
    { connection, concurrency: 2 },
  );
  console.log(
    `[worker] VC signing enabled (issuer ${signingContext.issuerDid}, key ${signingContext.signer.keyId})`,
  );
} else {
  console.log("[worker] VC signing disabled (VC_SIGNING_KEY_FILE not set)");
}

// Anchoring (Phase 1) is opt-in: without chain config the worker runs
// PDF/notification jobs only and issuance shows "public proof pending".
const anchorConfig = anchorChainConfigFromEnv(process.env);
let anchorsQueue: Queue | null = null;
let anchorsWorker: Worker<AnchorBatchJobData> | null = null;
if (anchorConfig) {
  const anchorChain = createAnchorChain(anchorConfig);
  anchorsQueue = new Queue(QUEUE_ANCHORS, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  // Daily at 00:05 Ulaanbaatar time, anchoring the day that just closed.
  await anchorsQueue.upsertJobScheduler(
    "daily-anchor",
    { pattern: "5 0 * * *", tz: "Asia/Ulaanbaatar" },
    { name: JOB_ANCHOR_BATCH, data: {} satisfies AnchorBatchJobData },
  );
  anchorsWorker = new Worker<AnchorBatchJobData>(
    QUEUE_ANCHORS,
    async (job) => {
      if (job.name !== JOB_ANCHOR_BATCH) return;
      const result = await runAnchorBatch(db, anchorChain, {
        ...(job.data.batchDate ? { batchDate: job.data.batchDate } : {}),
      });
      if (result.outcome === "root-mismatch") {
        // Retrying cannot fix a divergent on-chain root; surface immediately.
        throw new UnrecoverableError(
          `Anchor batch ${result.batchId}: on-chain root ${result.onChainRoot} != computed ${result.ourRoot}`,
        );
      }
      console.log(
        `[worker] anchor batch ${result.batchDate}: ${result.outcome}` +
          (result.outcome === "confirmed"
            ? ` (${result.leafCount} leaves, tx ${result.txHash})`
            : ""),
      );
      return result;
    },
    // One at a time — a single nonce-bearing wallet must never race itself.
    { connection, concurrency: 1 },
  );
  console.log(
    `[worker] anchoring enabled (chain ${anchorConfig.chainId}, contract ${anchorConfig.contractAddress})`,
  );
} else {
  console.log("[worker] anchoring disabled (ANCHOR_* env not configured)");
}

const allWorkers = [
  artifactsWorker,
  notificationsWorker,
  ...(anchorsWorker ? [anchorsWorker] : []),
  ...(signingWorker ? [signingWorker] : []),
];
for (const w of allWorkers) {
  w.on("ready", () => console.log(`[worker] ${w.name} ready`));
  w.on("failed", (job, err) =>
    console.error(
      `[worker] ${w.name} job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    ),
  );
}

const shutdown = async () => {
  await Promise.all(allWorkers.map((w) => w.close()));
  await notificationsQueue.close();
  await anchorsQueue?.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
