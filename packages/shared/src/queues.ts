/**
 * Queue and job contracts shared by the API (producer) and worker (consumer).
 * Job state lives in Redis/BullMQ and never replaces credential lifecycle
 * status (design §15.3). Handlers must be idempotent — jobs may re-run.
 */
export const QUEUE_ARTIFACTS = "artifacts";
export const QUEUE_NOTIFICATIONS = "notifications";
export const QUEUE_ANCHORS = "anchors";
export const QUEUE_SIGNING = "signing";

export const JOB_GENERATE_PDF = "generate-pdf";
export const JOB_NOTIFY_ISSUED = "notify-issued";
export const JOB_ANCHOR_BATCH = "anchor-batch";
export const JOB_SIGN_VC = "sign-vc";
export const JOB_PUBLISH_STATUS_LIST = "publish-status-list";

export interface SignVcJobData {
  credentialId: string;
}

export interface PublishStatusListJobData {
  /** Status list id; the platform currently publishes list 1. */
  listId?: number;
}

export interface GeneratePdfJobData {
  credentialId: string;
}

export interface NotifyIssuedJobData {
  credentialId: string;
}

export interface AnchorBatchJobData {
  /**
   * Issuance day to anchor as "YYYY-MM-DD" (Asia/Ulaanbaatar calendar).
   * Omitted on the daily scheduled run — the worker anchors the day that
   * just closed. Set explicitly for ops-console retries/backfills.
   */
  batchDate?: string;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false, // dead-letter stays visible in the ops console
} as const;
