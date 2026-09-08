/**
 * Queue and job contracts shared by the API (producer) and worker (consumer).
 * Job state lives in Redis/BullMQ and never replaces credential lifecycle
 * status (design §15.3). Handlers must be idempotent — jobs may re-run.
 */
export const QUEUE_ARTIFACTS = "artifacts";
export const QUEUE_NOTIFICATIONS = "notifications";

export const JOB_GENERATE_PDF = "generate-pdf";
export const JOB_NOTIFY_ISSUED = "notify-issued";

export interface GeneratePdfJobData {
  credentialId: string;
}

export interface NotifyIssuedJobData {
  credentialId: string;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false, // dead-letter stays visible in the ops console
} as const;
