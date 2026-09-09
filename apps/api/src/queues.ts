import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_GENERATE_PDF,
  JOB_PUBLISH_STATUS_LIST,
  JOB_SIGN_VC,
  QUEUE_ARTIFACTS,
  QUEUE_NOTIFICATIONS,
  QUEUE_SIGNING,
  type GeneratePdfJobData,
  type PublishStatusListJobData,
  type SignVcJobData,
} from "@diplommn/shared";

/**
 * Job producers. Enqueueing happens AFTER the issuing transaction commits and
 * is fire-safe: a failed enqueue is logged and recoverable via the ops
 * console's "regenerate artifacts" — it never rolls back issuance.
 */
export interface JobQueues {
  artifacts: Queue;
  notifications: Queue;
  signing: Queue;
  connection: Redis;
  enqueuePdf(credentialId: string, opts?: { force?: boolean }): Promise<void>;
  enqueueSignVc(credentialId: string): Promise<void>;
  enqueuePublishStatusList(): Promise<void>;
  close(): Promise<void>;
}

export function createQueues(redisUrl?: string): JobQueues {
  const connection = new Redis(
    redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6380",
    { maxRetriesPerRequest: null },
  );
  const artifacts = new Queue(QUEUE_ARTIFACTS, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const notifications = new Queue(QUEUE_NOTIFICATIONS, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const signing = new Queue(QUEUE_SIGNING, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return {
    artifacts,
    notifications,
    signing,
    connection,
    async enqueuePdf(credentialId, opts = {}) {
      // Stable jobId dedupes accidental double-enqueue on approve+retry;
      // ops regeneration forces a fresh job. NOTE: BullMQ forbids ":" in
      // custom job IDs — use "-" separators only.
      const jobId = opts.force
        ? `pdf-${credentialId}-${Date.now()}`
        : `pdf-${credentialId}`;
      await artifacts.add(
        JOB_GENERATE_PDF,
        { credentialId } satisfies GeneratePdfJobData,
        { jobId },
      );
    },
    async enqueueSignVc(credentialId) {
      // Signing is idempotent (already-signed credentials are skipped), so a
      // stable jobId per credential is enough.
      await signing.add(
        JOB_SIGN_VC,
        { credentialId } satisfies SignVcJobData,
        { jobId: `sign-${credentialId}` },
      );
    },
    async enqueuePublishStatusList() {
      // Time-bucketed jobId dedupes bursts of revocations into one refresh.
      await signing.add(
        JOB_PUBLISH_STATUS_LIST,
        {} satisfies PublishStatusListJobData,
        { jobId: `statuslist-${Math.floor(Date.now() / 60_000)}` },
      );
    },
    async close() {
      await artifacts.close();
      await notifications.close();
      await signing.close();
      await connection.quit();
    },
  };
}
