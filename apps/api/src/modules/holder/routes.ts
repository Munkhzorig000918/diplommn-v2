import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  anchorBatches,
  appendAuditEvent,
  credentials,
  credentialTypes,
  holders,
  holderSessions,
  institutions,
  otpChallenges,
  shareLinks,
  type Db,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  computeMerkleProof,
  formatCertificateId,
  maskRegistrationNumber,
  ShareStatus,
} from "@diplommn/shared";
import type { ApiConfig } from "../../config.js";
import { hashSessionToken } from "../../plugins/auth.js";
import { HOLDER_COOKIE, requireHolder } from "../../plugins/holder-auth.js";

/**
 * Holder portal (design R2 / HOLD screens). MVP login: registration number →
 * OTP to the contact on file (gap #4 default: exact registration-number match;
 * holders without a stored contact must go through their institution).
 * All responses are enumeration-safe: they never reveal whether a
 * registration number exists or where a code was sent.
 */

export type OtpDelivery = (destination: string, code: string) => Promise<void>;

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const HOLDER_SESSION_HOURS = 2;
const SHARE_DEFAULT_DAYS = 7;
const SHARE_MAX_DAYS = 90;

const RequestOtpBody = z.object({
  registrationNumber: z.string().min(4).max(20),
});
const VerifyOtpBody = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});
const CreateShareBody = z.object({
  expiresInDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(SHARE_MAX_DAYS)
    .default(SHARE_DEFAULT_DAYS),
});
const IdParams = z.object({ id: z.string().uuid() });

function hashOtp(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

export function shareStatusOf(row: {
  revokedAt: Date | null;
  expiresAt: Date;
}): ShareStatus {
  if (row.revokedAt) return ShareStatus.Revoked;
  if (row.expiresAt < new Date()) return ShareStatus.Expired;
  return ShareStatus.Active;
}

/** Lifecycle states a holder can see — issued history, never internal drafts. */
const HOLDER_VISIBLE_STATUSES = [
  "ISSUED",
  "REVOKED",
  "REVOCATION_PENDING",
  "SUPERSEDED",
] as const;

export function registerHolderRoutes(
  app: FastifyInstance,
  db: Db,
  config: ApiConfig,
  otpDelivery: OtpDelivery,
): void {
  app.post(
    "/api/v1/holder/otp/request",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const body = RequestOtpBody.parse(request.body);
      // Same shape whether or not a holder matches — no enumeration.
      const challengeId = randomUUID();

      const found = await db
        .select()
        .from(holders)
        .where(eq(holders.registrationNumber, body.registrationNumber))
        .limit(1);
      const holder = found[0];

      if (holder?.email) {
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        await db.transaction(async (tx) => {
          await tx.insert(otpChallenges).values({
            id: challengeId,
            holderId: holder.id,
            destination: holder.email!,
            codeHash: hashOtp(challengeId, code),
            purpose: "PORTAL_LOGIN",
            expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
          });
          await appendAuditEvent(tx, {
            actorType: "PUBLIC",
            action: AuditAction.HolderOtpRequested,
            resourceType: AuditResource.Holder,
            resourceId: holder.id,
            result: AuditResult.Success,
            correlationId: request.id,
          });
        });
        await otpDelivery(holder.email, code);
      }

      return {
        challengeId,
        message:
          "Хэрэв бүртгэл олдвол таны бүртгэлтэй хаяг руу нэг удаагийн код илгээгдлээ. / If a record exists, a one-time code has been sent to the contact on file.",
        expiresInMinutes: OTP_TTL_MINUTES,
      };
    },
  );

  app.post(
    "/api/v1/holder/otp/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = VerifyOtpBody.parse(request.body);
      const invalid = () =>
        AppError.unauthorized("Код буруу эсвэл хугацаа нь дууссан байна");

      const found = await db
        .select()
        .from(otpChallenges)
        .where(eq(otpChallenges.id, body.challengeId))
        .limit(1);
      const challenge = found[0];
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt < new Date() ||
        challenge.attempts >= OTP_MAX_ATTEMPTS ||
        !challenge.holderId
      ) {
        throw invalid();
      }

      if (challenge.codeHash !== hashOtp(challenge.id, body.code)) {
        await db.transaction(async (tx) => {
          await tx
            .update(otpChallenges)
            .set({ attempts: challenge.attempts + 1 })
            .where(eq(otpChallenges.id, challenge.id));
          await appendAuditEvent(tx, {
            actorType: "PUBLIC",
            action: AuditAction.HolderLoginFailed,
            resourceType: AuditResource.Holder,
            resourceId: challenge.holderId,
            result: AuditResult.Failure,
            correlationId: request.id,
            details: { reason: "bad_code", attempt: challenge.attempts + 1 },
          });
        });
        throw invalid();
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + HOLDER_SESSION_HOURS * 3_600_000);
      await db.transaction(async (tx) => {
        await tx
          .update(otpChallenges)
          .set({ consumedAt: new Date() })
          .where(eq(otpChallenges.id, challenge.id));
        await tx.insert(holderSessions).values({
          holderId: challenge.holderId!,
          tokenHash: hashSessionToken(token),
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          expiresAt,
        });
        await appendAuditEvent(tx, {
          actorType: "PUBLIC",
          action: AuditAction.HolderLoginSucceeded,
          resourceType: AuditResource.Holder,
          resourceId: challenge.holderId,
          result: AuditResult.Success,
          correlationId: request.id,
        });
      });

      reply.setCookie(HOLDER_COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.COOKIE_SECURE,
        expires: expiresAt,
      });
      return { ok: true };
    },
  );

  app.post("/api/v1/holder/logout", async (request, reply) => {
    const holder = requireHolder(request);
    const token = request.cookies[HOLDER_COOKIE];
    if (token) {
      await db.transaction(async (tx) => {
        await tx
          .update(holderSessions)
          .set({ revokedAt: new Date() })
          .where(eq(holderSessions.tokenHash, hashSessionToken(token)));
        await appendAuditEvent(tx, {
          actorType: "PUBLIC",
          action: AuditAction.HolderLogout,
          resourceType: AuditResource.Holder,
          resourceId: holder.id,
          result: AuditResult.Success,
          correlationId: request.id,
        });
      });
    }
    reply.clearCookie(HOLDER_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/holder/me", async (request) => {
    const holder = requireHolder(request);
    const [row] = await db
      .select()
      .from(holders)
      .where(eq(holders.id, holder.id))
      .limit(1);
    if (!row) throw AppError.unauthorized();
    return {
      holder: {
        id: row.id,
        lastName: row.lastName,
        firstName: row.firstName,
        registrationNumber: maskRegistrationNumber(row.registrationNumber),
      },
    };
  });

  app.get("/api/v1/holder/credentials", async (request) => {
    const holder = requireHolder(request);
    const rows = await db
      .select({
        id: credentials.id,
        certificateId: credentials.certificateId,
        credentialNumber: credentials.credentialNumber,
        lifecycleStatus: credentials.lifecycleStatus,
        issuedAt: credentials.issuedAt,
        institutionNameMn: institutions.nameMn,
        institutionNameEn: institutions.nameEn,
        typeNameMn: credentialTypes.nameMn,
        typeNameEn: credentialTypes.nameEn,
        kind: credentialTypes.kind,
      })
      .from(credentials)
      .innerJoin(institutions, eq(credentials.institutionId, institutions.id))
      .innerJoin(
        credentialTypes,
        eq(credentials.credentialTypeId, credentialTypes.id),
      )
      .where(
        and(
          eq(credentials.holderId, holder.id),
          inArray(credentials.lifecycleStatus, [...HOLDER_VISIBLE_STATUSES]),
        ),
      )
      .orderBy(desc(credentials.issuedAt));

    return {
      items: rows.map((r) => ({
        ...r,
        certificateId: r.certificateId
          ? formatCertificateId(r.certificateId)
          : null,
      })),
    };
  });

  /**
   * Offline proof bundle (Phase 2): everything an independent verifier
   * needs without contacting diplom.mn — the signed VC, the salt that
   * unlocks THIS credential's anchor leaf (discloses nothing about other
   * leaves), and the Merkle proof against the anchored daily root. The
   * status list URL travels inside the VC's credentialStatus.
   */
  app.get("/api/v1/holder/credentials/:id/proof-bundle", async (request) => {
    const holder = requireHolder(request);
    const { id } = IdParams.parse(request.params);

    const rows = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.holderId, holder.id)))
      .limit(1);
    const credential = rows[0];
    if (
      !credential ||
      !HOLDER_VISIBLE_STATUSES.includes(
        credential.lifecycleStatus as (typeof HOLDER_VISIBLE_STATUSES)[number],
      )
    ) {
      throw AppError.notFound("Credential not found");
    }
    if (!credential.vc) {
      throw AppError.conflict("Credential has no signed VC yet");
    }

    const leaf = credential.vcHash ?? credential.contentHash;
    let anchor: Record<string, unknown> | null = null;
    if (credential.anchorBatchId && leaf) {
      const [batch] = await db
        .select()
        .from(anchorBatches)
        .where(eq(anchorBatches.id, credential.anchorBatchId))
        .limit(1);
      if (batch) {
        try {
          anchor = {
            batchId: batch.batchId.toString(),
            merkleRoot: batch.merkleRoot,
            merkleProof: computeMerkleProof(batch.leaves as string[], leaf),
            chainId: batch.chainId,
            contractAddress: batch.contractAddress,
            txHash: batch.txHash,
            blockNumber: batch.blockNumber?.toString() ?? null,
            status: batch.status,
          };
        } catch (err) {
          // Leaf missing from its own batch — an integrity signal worth
          // surfacing in logs; the bundle degrades to signature+status only.
          request.log.error({ err, credentialId: id }, "proof-bundle leaf not in batch");
        }
      }
    }

    return {
      bundleVersion: "1.0",
      vc: credential.vc,
      // Salted-leaf preimage material for independent recomputation.
      leaf: {
        salt: credential.contentSalt,
        source: credential.vcHash ? "vc" : "claims",
        hashAlg: credential.contentHashAlg,
      },
      anchor,
    };
  });

  app.get("/api/v1/holder/credentials/:id", async (request) => {
    const holder = requireHolder(request);
    const { id } = IdParams.parse(request.params);

    const rows = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.holderId, holder.id)))
      .limit(1);
    const credential = rows[0];
    if (
      !credential ||
      !HOLDER_VISIBLE_STATUSES.includes(
        credential.lifecycleStatus as (typeof HOLDER_VISIBLE_STATUSES)[number],
      )
    ) {
      throw AppError.notFound("Credential not found");
    }

    const [institution] = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, credential.institutionId))
      .limit(1);
    const [credType] = await db
      .select()
      .from(credentialTypes)
      .where(eq(credentialTypes.id, credential.credentialTypeId))
      .limit(1);
    const shares = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.credentialId, id))
      .orderBy(desc(shareLinks.createdAt));

    const claims = (credential.submittedSnapshot ?? credential.claims) as Record<
      string,
      unknown
    >;

    return {
      credential: {
        id: credential.id,
        certificateId: credential.certificateId
          ? formatCertificateId(credential.certificateId)
          : null,
        credentialNumber: credential.credentialNumber,
        lifecycleStatus: credential.lifecycleStatus,
        issuedAt: credential.issuedAt,
        institution: institution
          ? { nameMn: institution.nameMn, nameEn: institution.nameEn }
          : null,
        credentialType: credType
          ? { nameMn: credType.nameMn, nameEn: credType.nameEn, kind: credType.kind }
          : null,
        claims,
        pdfAvailable: credential.pdfObjectKey !== null,
      },
      shares: shares.map((s) => ({
        id: s.id,
        status: shareStatusOf(s),
        expiresAt: s.expiresAt,
        accessCount: s.accessCount,
        createdAt: s.createdAt,
      })),
    };
  });

  app.post("/api/v1/holder/credentials/:id/shares", async (request, reply) => {
    const holder = requireHolder(request);
    const { id } = IdParams.parse(request.params);
    const body = CreateShareBody.parse(request.body ?? {});

    const rows = await db
      .select({
        id: credentials.id,
        lifecycleStatus: credentials.lifecycleStatus,
      })
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.holderId, holder.id)))
      .limit(1);
    const credential = rows[0];
    if (!credential) throw AppError.notFound("Credential not found");
    if (credential.lifecycleStatus !== "ISSUED") {
      throw AppError.conflict("Only issued credentials can be shared");
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + body.expiresInDays * 24 * 3_600_000,
    );

    const share = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(shareLinks)
        .values({
          credentialId: id,
          holderId: holder.id,
          tokenHash: hashSessionToken(token),
          expiresAt,
        })
        .returning({ id: shareLinks.id });
      if (!row) throw new Error("failed to create share");
      await appendAuditEvent(tx, {
        actorType: "PUBLIC",
        action: AuditAction.ShareCreated,
        resourceType: AuditResource.ShareLink,
        resourceId: row.id,
        result: AuditResult.Success,
        correlationId: request.id,
        details: { credentialId: id, expiresAt: expiresAt.toISOString() },
      });
      return row;
    });

    // The raw token is returned exactly once; only its hash is stored.
    return reply.status(201).send({
      shareId: share.id,
      token,
      url: `${config.WEB_ORIGIN}/s/${token}`,
      expiresAt,
    });
  });

  app.get("/api/v1/holder/shares", async (request) => {
    const holder = requireHolder(request);
    const rows = await db
      .select({
        id: shareLinks.id,
        credentialId: shareLinks.credentialId,
        expiresAt: shareLinks.expiresAt,
        revokedAt: shareLinks.revokedAt,
        accessCount: shareLinks.accessCount,
        lastAccessedAt: shareLinks.lastAccessedAt,
        createdAt: shareLinks.createdAt,
        certificateId: credentials.certificateId,
        typeNameMn: credentialTypes.nameMn,
      })
      .from(shareLinks)
      .innerJoin(credentials, eq(shareLinks.credentialId, credentials.id))
      .innerJoin(
        credentialTypes,
        eq(credentials.credentialTypeId, credentialTypes.id),
      )
      .where(eq(shareLinks.holderId, holder.id))
      .orderBy(desc(shareLinks.createdAt));

    return {
      items: rows.map((r) => ({
        id: r.id,
        credentialId: r.credentialId,
        certificateId: r.certificateId
          ? formatCertificateId(r.certificateId)
          : null,
        credentialType: r.typeNameMn,
        status: shareStatusOf(r),
        expiresAt: r.expiresAt,
        accessCount: r.accessCount,
        lastAccessedAt: r.lastAccessedAt,
        createdAt: r.createdAt,
      })),
    };
  });

  app.post("/api/v1/holder/shares/:id/revoke", async (request) => {
    const holder = requireHolder(request);
    const { id } = IdParams.parse(request.params);

    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.id, id), eq(shareLinks.holderId, holder.id)))
        .for("update")
        .limit(1);
      const share = rows[0];
      if (!share) throw AppError.notFound("Share not found");
      if (share.revokedAt) return; // idempotent
      await tx
        .update(shareLinks)
        .set({ revokedAt: new Date() })
        .where(eq(shareLinks.id, id));
      await appendAuditEvent(tx, {
        actorType: "PUBLIC",
        action: AuditAction.ShareRevoked,
        resourceType: AuditResource.ShareLink,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
      });
    });
    return { ok: true };
  });

  /* -------- public share resolution (no login) -------- */

  app.get(
    "/api/v1/share/:token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { token } = z
        .object({ token: z.string().min(20).max(100) })
        .parse(request.params);

      const rows = await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.tokenHash, hashSessionToken(token)))
        .limit(1);
      const share = rows[0];

      // Share-link state is distinct from credential state (design §15.5):
      // an expired/revoked LINK never implies anything about the credential.
      if (!share) {
        return {
          share: { status: "NOT_FOUND" },
          message:
            "Энэ хуваалцах холбоос олдсонгүй. / This share link was not found.",
        };
      }
      const status = shareStatusOf(share);
      if (status !== ShareStatus.Active) {
        return {
          share: { status },
          message:
            "Энэ хуваалцах холбоос хүчингүй болсон эсвэл хугацаа нь дууссан. Энэ нь баримтын хүчинтэй байдлыг илэрхийлэхгүй. / This share link is no longer active — this says nothing about the credential itself.",
        };
      }

      const credRows = await db
        .select({ certificateId: credentials.certificateId })
        .from(credentials)
        .where(eq(credentials.id, share.credentialId))
        .limit(1);
      const certificateId = credRows[0]?.certificateId;

      await db.transaction(async (tx) => {
        await tx
          .update(shareLinks)
          .set({
            accessCount: sql`${shareLinks.accessCount} + 1`,
            lastAccessedAt: new Date(),
          })
          .where(eq(shareLinks.id, share.id));
        await appendAuditEvent(tx, {
          actorType: "PUBLIC",
          action: AuditAction.ShareVerificationPerformed,
          resourceType: AuditResource.ShareLink,
          resourceId: share.id,
          result: AuditResult.Success,
          correlationId: request.id,
        });
      });

      return {
        share: { status, expiresAt: share.expiresAt },
        certificateId: certificateId ? formatCertificateId(certificateId) : null,
      };
    },
  );
}
