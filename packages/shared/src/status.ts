/**
 * Status dimensions are deliberately separate (design doc §15): lifecycle,
 * source validation, processing, anchoring and sharing must never be merged
 * into one enum. MVP uses lifecycle + source-validation; the other dimensions
 * exist now so the data model stays V2 (VC/anchor) mappable.
 */

export const CredentialLifecycle = {
  Draft: "DRAFT",
  PendingApproval: "PENDING_APPROVAL",
  Returned: "RETURNED",
  Rejected: "REJECTED",
  Approved: "APPROVED",
  Issued: "ISSUED",
  RevocationPending: "REVOCATION_PENDING",
  Revoked: "REVOKED",
  Superseded: "SUPERSEDED",
  Cancelled: "CANCELLED",
} as const;
export type CredentialLifecycle =
  (typeof CredentialLifecycle)[keyof typeof CredentialLifecycle];

/** Allowed lifecycle transitions. Anything not listed is rejected server-side. */
export const LIFECYCLE_TRANSITIONS: Record<
  CredentialLifecycle,
  readonly CredentialLifecycle[]
> = {
  DRAFT: [CredentialLifecycle.PendingApproval, CredentialLifecycle.Cancelled],
  PENDING_APPROVAL: [
    CredentialLifecycle.Approved,
    CredentialLifecycle.Returned,
    CredentialLifecycle.Rejected,
  ],
  RETURNED: [CredentialLifecycle.PendingApproval, CredentialLifecycle.Cancelled],
  REJECTED: [],
  APPROVED: [CredentialLifecycle.Issued],
  ISSUED: [CredentialLifecycle.RevocationPending, CredentialLifecycle.Superseded],
  REVOCATION_PENDING: [CredentialLifecycle.Revoked],
  REVOKED: [],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function canTransition(
  from: CredentialLifecycle,
  to: CredentialLifecycle,
): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export const SourceValidationStatus = {
  NotChecked: "NOT_CHECKED",
  Checking: "CHECKING",
  Matched: "MATCHED",
  Mismatch: "MISMATCH",
  AttestationInvalid: "ATTESTATION_INVALID",
  Unavailable: "UNAVAILABLE",
  Stale: "STALE",
} as const;
export type SourceValidationStatus =
  (typeof SourceValidationStatus)[keyof typeof SourceValidationStatus];

/** V2 anchoring dimension — schema present in MVP, populated in Phase 2. */
export const AnchorStatus = {
  NotEligible: "NOT_ELIGIBLE",
  AwaitingBatch: "AWAITING_BATCH",
  Batched: "BATCHED",
  Submitted: "SUBMITTED",
  Confirmed: "CONFIRMED",
  Failed: "FAILED",
  Reanchored: "REANCHORED",
} as const;
export type AnchorStatus = (typeof AnchorStatus)[keyof typeof AnchorStatus];

export const ShareStatus = {
  Active: "ACTIVE",
  Expired: "EXPIRED",
  Revoked: "REVOKED",
  Unavailable: "UNAVAILABLE",
} as const;
export type ShareStatus = (typeof ShareStatus)[keyof typeof ShareStatus];

/**
 * Public verification results for the MVP database-check path.
 * V2's cryptographic verifier adds NOT_VALID / INDETERMINATE; the MVP can only
 * assert what the database knows. NOT_FOUND is never presented as "invalid".
 */
export const VerificationResult = {
  Valid: "VALID",
  Revoked: "REVOKED",
  Superseded: "SUPERSEDED",
  NotFound: "NOT_FOUND",
} as const;
export type VerificationResult =
  (typeof VerificationResult)[keyof typeof VerificationResult];

export const LifecycleCaseType = {
  Revoke: "REVOKE",
  Correct: "CORRECT",
  Reissue: "REISSUE",
} as const;
export type LifecycleCaseType =
  (typeof LifecycleCaseType)[keyof typeof LifecycleCaseType];

export const LifecycleCaseStatus = {
  Open: "OPEN",
  Approved: "APPROVED",
  Rejected: "REJECTED",
  Completed: "COMPLETED",
  Cancelled: "CANCELLED",
} as const;
export type LifecycleCaseStatus =
  (typeof LifecycleCaseStatus)[keyof typeof LifecycleCaseStatus];

export const ImportBatchStatus = {
  Uploaded: "UPLOADED",
  Validating: "VALIDATING",
  ReadyForReview: "READY_FOR_REVIEW",
  Submitted: "SUBMITTED",
  PartiallyCompleted: "PARTIALLY_COMPLETED",
  Completed: "COMPLETED",
  Cancelled: "CANCELLED",
  Failed: "FAILED",
} as const;
export type ImportBatchStatus =
  (typeof ImportBatchStatus)[keyof typeof ImportBatchStatus];

export const UserStatus = {
  Invited: "INVITED",
  Active: "ACTIVE",
  Suspended: "SUSPENDED",
  Locked: "LOCKED",
  InvitationExpired: "INVITATION_EXPIRED",
  Deactivated: "DEACTIVATED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
