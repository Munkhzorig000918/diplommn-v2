import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Enums — mirror @diplommn/shared status dimensions (kept separate). */
/* ------------------------------------------------------------------ */

export const userStatusEnum = pgEnum("user_status", [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "LOCKED",
  "INVITATION_EXPIRED",
  "DEACTIVATED",
]);

export const roleEnum = pgEnum("role", [
  "platform_admin",
  "operator",
  "approver",
  "lifecycle_admin",
  "auditor",
]);

export const credentialLifecycleEnum = pgEnum("credential_lifecycle", [
  "DRAFT",
  "PENDING_APPROVAL",
  "RETURNED",
  "REJECTED",
  "APPROVED",
  "ISSUED",
  "REVOCATION_PENDING",
  "REVOKED",
  "SUPERSEDED",
  "CANCELLED",
]);

export const sourceValidationEnum = pgEnum("source_validation_status", [
  "NOT_CHECKED",
  "CHECKING",
  "MATCHED",
  "MISMATCH",
  "ATTESTATION_INVALID",
  "UNAVAILABLE",
  "STALE",
]);

export const anchorStatusEnum = pgEnum("anchor_status", [
  "NOT_ELIGIBLE",
  "AWAITING_BATCH",
  "BATCHED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "REANCHORED",
]);

/** Batch-level submission state; per-credential anchor_status stays separate. */
export const anchorBatchStatusEnum = pgEnum("anchor_batch_status", [
  "PENDING",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
]);

export const credentialKindEnum = pgEnum("credential_kind", [
  "DIPLOMA",
  "CERTIFICATE",
]);

export const sourceChannelEnum = pgEnum("source_channel", [
  "OPERATOR",
  "IMPORT",
  "API",
]);

export const lifecycleCaseTypeEnum = pgEnum("lifecycle_case_type", [
  "REVOKE",
  "CORRECT",
  "REISSUE",
]);

export const lifecycleCaseStatusEnum = pgEnum("lifecycle_case_status", [
  "OPEN",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
  "CANCELLED",
]);

export const importBatchStatusEnum = pgEnum("import_batch_status", [
  "UPLOADED",
  "VALIDATING",
  "READY_FOR_REVIEW",
  "SUBMITTED",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "USER",
  "SYSTEM",
  "PUBLIC",
]);

export const auditSourceEnum = pgEnum("audit_source", [
  "UI",
  "API",
  "IMPORT",
  "JOB",
  "SYSTEM",
]);

/* ------------------------------------------------------------------ */
/* Access: users, roles, invitations, sessions                        */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    status: userStatusEnum("status").notNull().default("INVITED"),
    passwordHash: text("password_hash"),
    // TOTP secret (base32). MVP stores at rest in DB; move to KMS-encrypted
    // storage before production hardening (tracked in SECURITY notes).
    totpSecret: text("totp_secret"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: roleEnum("role").notNull(),
    // NULL = global scope; set = institution-scoped (design doc scope model).
    institutionId: uuid("institution_id").references(() => institutions.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_roles_uq").on(t.userId, t.role, t.institutionId),
    index("user_roles_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    // [{ role, institutionId? }] granted on acceptance
    roles: jsonb("roles").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("invitations_token_uq").on(t.tokenHash)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* Reference data: institutions, credential types                     */
/* ------------------------------------------------------------------ */

export const institutions = pgTable(
  "institutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    nameMn: text("name_mn").notNull(),
    nameEn: text("name_en").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("institutions_code_uq").on(t.code)],
);

export const credentialTypes = pgTable(
  "credential_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    kind: credentialKindEnum("kind").notNull(),
    nameMn: text("name_mn").notNull(),
    nameEn: text("name_en").notNull(),
    // Claim-schema version for VC mapping later; never mutate a published
    // schema in place — add a new version (design doc CFG-001 rule).
    schemaVersion: text("schema_version").notNull().default("1.0"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("credential_types_code_uq").on(t.code)],
);

/* ------------------------------------------------------------------ */
/* Holders                                                            */
/* ------------------------------------------------------------------ */

export const holders = pgTable(
  "holders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lastName: text("last_name").notNull(),
    firstName: text("first_name").notNull(),
    // Mongolian registration number — sensitive; masked everywhere by default.
    registrationNumber: text("registration_number").notNull(),
    email: text("email"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("holders_regnum_uq").on(t.registrationNumber)],
);

/* ------------------------------------------------------------------ */
/* Credentials                                                        */
/* ------------------------------------------------------------------ */

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Public random identifier (FR-V05); assigned at issuance, never reused.
    certificateId: text("certificate_id"),
    // Institution-facing document number (diploma number etc.), if supplied.
    credentialNumber: text("credential_number"),
    credentialTypeId: uuid("credential_type_id")
      .notNull()
      .references(() => credentialTypes.id),
    institutionId: uuid("institution_id")
      .notNull()
      .references(() => institutions.id),
    holderId: uuid("holder_id")
      .notNull()
      .references(() => holders.id),
    // VC-mappable claims (program, degree, dates, grades …). Editable only in
    // DRAFT/RETURNED; frozen by the submitted snapshot afterwards.
    claims: jsonb("claims").notNull().default(sql`'{}'::jsonb`),
    submittedSnapshot: jsonb("submitted_snapshot"),
    schemaVersion: text("schema_version").notNull().default("1.0"),
    sourceChannel: sourceChannelEnum("source_channel")
      .notNull()
      .default("OPERATOR"),

    lifecycleStatus: credentialLifecycleEnum("lifecycle_status")
      .notNull()
      .default("DRAFT"),
    sourceValidationStatus: sourceValidationEnum("source_validation_status")
      .notNull()
      .default("NOT_CHECKED"),
    anchorStatus: anchorStatusEnum("anchor_status")
      .notNull()
      .default("NOT_ELIGIBLE"),
    anchorBatchId: uuid("anchor_batch_id").references(() => anchorBatches.id),

    // Salted content hash — computed at issuance (Phase-2 anchoring input).
    // Salt is confidential: never exposed via API/UI/logs.
    contentSalt: text("content_salt"),
    contentHash: text("content_hash"),
    contentHashAlg: text("content_hash_alg"),
    canonicalization: text("canonicalization"),

    // PDF artifact (worker milestone) + integrity checksum.
    pdfObjectKey: text("pdf_object_key"),
    pdfSha256: text("pdf_sha256"),

    // Signed W3C VC (Phase 1). Written once by the signing job; never
    // updated — corrections issue a replacement credential.
    vc: jsonb("vc"),
    vcSignedAt: timestamp("vc_signed_at", { withTimezone: true }),
    vcKeyId: text("vc_key_id"),
    // Salted hash over the SIGNED VC (architecture §2: "salted hash per
    // VC") — the preferred anchor leaf once a VC exists. Uses contentSalt.
    vcHash: text("vc_hash"),
    // Bitstring Status List slot, allocated at signing (sequence-backed).
    statusListIndex: integer("status_list_index"),

    issuedAt: timestamp("issued_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),

    importBatchId: uuid("import_batch_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("credentials_certificate_id_uq").on(t.certificateId),
    uniqueIndex("credentials_status_list_index_uq").on(t.statusListIndex),
    index("credentials_holder_idx").on(t.holderId),
    index("credentials_institution_idx").on(t.institutionId),
    index("credentials_lifecycle_idx").on(t.lifecycleStatus),
    index("credentials_type_idx").on(t.credentialTypeId),
  ],
);

/** Human-readable lifecycle timeline (design doc CRED-007). */
export const credentialEvents = pgTable(
  "credential_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    reason: text("reason"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("credential_events_credential_idx").on(t.credentialId)],
);

/* ------------------------------------------------------------------ */
/* Lifecycle cases (revoke / correct / reissue) — dual control        */
/* ------------------------------------------------------------------ */

export const lifecycleCases = pgTable(
  "lifecycle_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    caseType: lifecycleCaseTypeEnum("case_type").notNull(),
    status: lifecycleCaseStatusEnum("status").notNull().default("OPEN"),
    reasonCode: text("reason_code").notNull(),
    reasonDetail: text("reason_detail").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    replacementCredentialId: uuid("replacement_credential_id").references(
      (): any => credentials.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("lifecycle_cases_credential_idx").on(t.credentialId),
    index("lifecycle_cases_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* CSV import (schema now, pipeline in M3)                            */
/* ------------------------------------------------------------------ */

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileName: text("file_name").notNull(),
    objectKey: text("object_key"),
    institutionId: uuid("institution_id").references(() => institutions.id),
    credentialTypeId: uuid("credential_type_id").references(
      () => credentialTypes.id,
    ),
    status: importBatchStatusEnum("status").notNull().default("UPLOADED"),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    errorRows: integer("error_rows").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("import_batches_status_idx").on(t.status)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").notNull(),
    errors: jsonb("errors"),
    status: text("status").notNull().default("PENDING"),
    credentialId: uuid("credential_id").references(() => credentials.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("import_rows_batch_row_uq").on(t.batchId, t.rowNumber),
    index("import_rows_batch_idx").on(t.batchId),
  ],
);

/* ------------------------------------------------------------------ */
/* Append-only, hash-chained audit log (architecture §8, design §19)  */
/* ------------------------------------------------------------------ */

export const auditEvents = pgTable(
  "audit_events",
  {
    // Monotonic chain position. GENERATED ALWAYS — cannot be supplied by app.
    seq: bigint("seq", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    id: uuid("id").notNull().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorDisplay: text("actor_display"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    source: auditSourceEnum("source").notNull().default("API"),
    result: text("result").notNull(),
    correlationId: text("correlation_id"),
    ip: text("ip"),
    // Redacted structured payload — never raw PII beyond policy.
    details: jsonb("details"),
    prevHash: text("prev_hash").notNull(),
    eventHash: text("event_hash").notNull(),
  },
  (t) => [
    uniqueIndex("audit_events_id_uq").on(t.id),
    index("audit_events_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_events_actor_idx").on(t.actorUserId),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_ts_idx").on(t.ts),
  ],
);

/* ------------------------------------------------------------------ */
/* Holder share links (design HOLD-003/004): random expiring tokens,  */
/* revocable by the holder. Share status is independent of credential */
/* validity (ShareStatus dimension).                                  */
/* ------------------------------------------------------------------ */

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    holderId: uuid("holder_id")
      .notNull()
      .references(() => holders.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("share_links_token_uq").on(t.tokenHash),
    index("share_links_holder_idx").on(t.holderId),
    index("share_links_credential_idx").on(t.credentialId),
  ],
);

/** Holder portal sessions — separate surface from staff sessions. */
export const holderSessions = pgTable(
  "holder_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holderId: uuid("holder_id")
      .notNull()
      .references(() => holders.id),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("holder_sessions_token_uq").on(t.tokenHash),
    index("holder_sessions_holder_idx").on(t.holderId),
  ],
);

/* ------------------------------------------------------------------ */
/* Holder OTP (portal login — used from M2)                           */
/* ------------------------------------------------------------------ */

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holderId: uuid("holder_id").references(() => holders.id),
    destination: text("destination").notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose").notNull().default("PORTAL_LOGIN"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("otp_challenges_holder_idx").on(t.holderId)],
);

/**
 * Published Bitstring Status Lists — the signed status list credential the
 * public /status/:listId endpoint serves. Regenerated by the worker on
 * revocations and on a daily freshness schedule; the API never signs.
 */
export const statusLists = pgTable("status_lists", {
  listId: integer("list_id").primaryKey(),
  credential: jsonb("credential").notNull(),
  sha256: text("sha256").notNull(),
  revokedCount: integer("revoked_count").notNull().default(0),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Daily anchor batches (architecture §4/§8): one Merkle root over the day's
 * salted content hashes, one Ethereum transaction. DB tx ≠ chain tx — batch
 * rows are created first, then submitted asynchronously with idempotent
 * retries. `leaves` keeps the full sorted leaf set so Merkle proofs can be
 * recomputed for any member credential at verification time.
 */
export const anchorBatches = pgTable(
  "anchor_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // On-chain batch id (uint256). Numbering policy lives off-chain: YYYYMMDD
    // of the closed issuance day in Asia/Ulaanbaatar (gap #11 suggestion).
    batchId: bigint("batch_id", { mode: "bigint" }).notNull(),
    merkleRoot: text("merkle_root").notNull(),
    leafCount: integer("leaf_count").notNull(),
    leaves: jsonb("leaves").notNull(),
    status: anchorBatchStatusEnum("status").notNull().default("PENDING"),
    chainId: integer("chain_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("anchor_batches_batch_id_uq").on(t.batchId),
    index("anchor_batches_status_idx").on(t.status),
  ],
);
