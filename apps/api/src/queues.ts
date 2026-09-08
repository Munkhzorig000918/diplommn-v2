import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_GENERATE_PDF,
  QUEUE_ARTIFACTS,
  QUEUE_NOTIFICATIONS,
  type GeneratePdfJobData,
} from "@diplommn/shared";

/**
 * Job producers. Enqueueing happens AFTER the issuing transaction commits and
 * is fire-safe: a failed enqueue is logged and recoverable via the ops
 * console's "regenerate artifacts" — it never rolls back issuance.
 */
export interface JobQueues {
  artifacts: Queue;
  notifications: Queue;
  connection: Redis;
  enqueuePdf(credentialId: string, opts?: { force?: boolean }): Promise<void>;
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

  return {
    artifacts,
    notifications,
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
    async close() {
      await artifacts.close();
      await notifications.close();
      await connection.quit();
    },
  };
}
