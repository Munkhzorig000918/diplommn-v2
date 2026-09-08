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
  JOB_GENERATE_PDF,
  JOB_NOTIFY_ISSUED,
  QUEUE_ARTIFACTS,
  QUEUE_NOTIFICATIONS,
  type GeneratePdfJobData,
  type NotifyIssuedJobData,
} from "@diplommn/shared";
import { generatePdfArtifact } from "./jobs/generate-pdf.js";
import { notifyIssued } from "./jobs/notify-issued.js";

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

for (const w of [artifactsWorker, notificationsWorker]) {
  w.on("ready", () => console.log(`[worker] ${w.name} ready`));
  w.on("failed", (job, err) =>
    console.error(
      `[worker] ${w.name} job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    ),
  );
}

const shutdown = async () => {
  await Promise.all([artifactsWorker.close(), notificationsWorker.close()]);
  await notificationsQueue.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
