/**
 * Audit vocabulary — normalized actions and resource types (design doc §19).
 * Every important operation appends exactly one audit event inside the same
 * database transaction as the change it records.
 */
export const AuditAction = {
  // auth & access
  LoginSucceeded: "auth.login.succeeded",
  LoginFailed: "auth.login.failed",
  Logout: "auth.logout",
  InvitationCreated: "access.invitation.created",
  InvitationAccepted: "access.invitation.accepted",
  UserRoleChanged: "access.role.changed",
  UserStatusChanged: "access.user.status_changed",
  // credential workflow
  CredentialDraftCreated: "credential.draft.created",
  CredentialDraftUpdated: "credential.draft.updated",
  CredentialSubmitted: "credential.submitted",
  CredentialApproved: "credential.approved",
  CredentialReturned: "credential.returned",
  CredentialRejected: "credential.rejected",
  CredentialIssued: "credential.issued",
  CredentialCancelled: "credential.cancelled",
  // lifecycle cases
  LifecycleCaseCreated: "lifecycle.case.created",
  LifecycleCaseApproved: "lifecycle.case.approved",
  LifecycleCaseRejected: "lifecycle.case.rejected",
  CredentialRevoked: "credential.revoked",
  CredentialSuperseded: "credential.superseded",
  // verification
  PublicVerificationPerformed: "verification.public.performed",
  ShareVerificationPerformed: "verification.share.performed",
  // holder portal
  HolderOtpRequested: "holder.otp.requested",
  HolderLoginSucceeded: "holder.login.succeeded",
  HolderLoginFailed: "holder.login.failed",
  HolderLogout: "holder.logout",
  ShareCreated: "holder.share.created",
  ShareRevoked: "holder.share.revoked",
  // imports
  ImportBatchCreated: "import.batch.created",
  ImportBatchSubmitted: "import.batch.submitted",
  ImportBatchCancelled: "import.batch.cancelled",
  // artifacts & notifications (worker)
  ArtifactGenerated: "artifact.pdf.generated",
  NotificationSent: "notification.issued.sent",
  // technical operations
  OpsJobRetried: "ops.job.retried",
  OpsArtifactsRegenerated: "ops.artifacts.regenerated",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditResource = {
  User: "user",
  Invitation: "invitation",
  Credential: "credential",
  LifecycleCase: "lifecycle_case",
  ImportBatch: "import_batch",
  Session: "session",
  Holder: "holder",
  ShareLink: "share_link",
} as const;
export type AuditResource = (typeof AuditResource)[keyof typeof AuditResource];

export const AuditResult = {
  Success: "SUCCESS",
  Failure: "FAILURE",
  Denied: "DENIED",
} as const;
export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];
