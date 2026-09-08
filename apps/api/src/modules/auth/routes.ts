import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import * as OTPAuth from "otpauth";
import { z } from "zod";
import {
  appendAuditEvent,
  invitations,
  sessions,
  userRoles,
  users,
  type Db,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  isRole,
} from "@diplommn/shared";
import type { ApiConfig } from "../../config.js";
import { hashSessionToken, requireUser, SESSION_COOKIE } from "../../plugins/auth.js";

const ARGON2_OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 4 };
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

const AcceptInvitationBody = z.object({
  token: z.string().min(20).max(200),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(256),
});

function verifyTotp(secretBase32: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token: code, window: 1 }) !== null;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  config: ApiConfig,
): void {
  // Login is rate-limited tightly: credential stuffing surface.
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = LoginBody.parse(request.body);
      const invalid = () => AppError.unauthorized("Invalid credentials");

      const found = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${body.email})`)
        .limit(1);
      const user = found[0];

      const audit = async (result: string, details?: unknown) => {
        await db.transaction(async (tx) => {
          await appendAuditEvent(tx, {
            actorType: user ? "USER" : "PUBLIC",
            actorUserId: user?.id ?? null,
            action:
              result === AuditResult.Success
                ? AuditAction.LoginSucceeded
                : AuditAction.LoginFailed,
            resourceType: AuditResource.Session,
            result,
            correlationId: request.id,
            ip: request.ip,
            details,
          });
        });
      };

      if (!user || !user.passwordHash || user.status !== "ACTIVE") {
        await audit(AuditResult.Failure, { reason: "unknown_or_inactive" });
        throw invalid();
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await audit(AuditResult.Denied, { reason: "locked" });
        throw invalid();
      }

      const passwordOk = await argon2Verify(user.passwordHash, body.password);
      if (!passwordOk) {
        const failed = user.failedLoginCount + 1;
        await db
          .update(users)
          .set({
            failedLoginCount: failed,
            lockedUntil:
              failed >= MAX_FAILED_LOGINS
                ? new Date(Date.now() + LOCK_MINUTES * 60_000)
                : null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
        await audit(AuditResult.Failure, { reason: "bad_password" });
        throw invalid();
      }

      if (user.totpSecret) {
        if (!body.totpCode) {
          // Password OK but MFA required — distinct, non-enumerating signal.
          return reply.status(401).send({
            error: {
              code: "UNAUTHORIZED",
              message: "TOTP code required",
              details: { totpRequired: true },
              correlationId: request.id,
            },
          });
        }
        if (!verifyTotp(user.totpSecret, body.totpCode)) {
          await audit(AuditResult.Failure, { reason: "bad_totp" });
          throw invalid();
        }
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(
        Date.now() + config.SESSION_TTL_HOURS * 3_600_000,
      );
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        await tx.insert(sessions).values({
          userId: user.id,
          tokenHash: hashSessionToken(token),
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          expiresAt,
        });
        await appendAuditEvent(tx, {
          actorType: "USER",
          actorUserId: user.id,
          action: AuditAction.LoginSucceeded,
          resourceType: AuditResource.Session,
          result: AuditResult.Success,
          correlationId: request.id,
          ip: request.ip,
        });
      });

      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.COOKIE_SECURE,
        expires: expiresAt,
      });
      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
      };
    },
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const user = requireUser(request);
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.tokenHash, hashSessionToken(token)),
              isNull(sessions.revokedAt),
            ),
          );
        await appendAuditEvent(tx, {
          actorType: "USER",
          actorUserId: user.id,
          action: AuditAction.Logout,
          resourceType: AuditResource.Session,
          result: AuditResult.Success,
          correlationId: request.id,
        });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (request) => {
    const user = requireUser(request);
    return { user };
  });

  /**
   * Invitation acceptance: the invitee sets their own password (admins never
   * see or set passwords) and receives their TOTP enrollment exactly once.
   */
  app.post(
    "/api/v1/auth/invitations/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = AcceptInvitationBody.parse(request.body);
      const tokenHash = hashSessionToken(body.token);

      const found = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      const invitation = found[0];
      if (!invitation || invitation.acceptedAt) {
        throw AppError.notFound("Invitation not found or already used");
      }
      if (invitation.expiresAt < new Date()) {
        throw AppError.conflict("Invitation has expired");
      }

      const grants = z
        .array(
          z.object({
            role: z.string().refine(isRole, "unknown role"),
            institutionId: z.string().uuid().nullish(),
          }),
        )
        .parse(invitation.roles);

      const passwordHash = await argon2Hash(body.password, ARGON2_OPTS);
      const totpSecret = new OTPAuth.Secret({ size: 20 });

      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = lower(${invitation.email})`)
          .limit(1);
        if (existing[0]) throw AppError.conflict("Account already exists");

        const [created] = await tx
          .insert(users)
          .values({
            email: invitation.email.toLowerCase(),
            fullName: invitation.fullName,
            status: "ACTIVE",
            passwordHash,
            totpSecret: totpSecret.base32,
          })
          .returning({ id: users.id });
        if (!created) throw new Error("failed to create user");

        for (const grant of grants) {
          await tx.insert(userRoles).values({
            userId: created.id,
            role: grant.role,
            institutionId: grant.institutionId ?? null,
          });
        }
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, invitation.id));
        await appendAuditEvent(tx, {
          actorType: "USER",
          actorUserId: created.id,
          action: AuditAction.InvitationAccepted,
          resourceType: AuditResource.Invitation,
          resourceId: invitation.id,
          result: AuditResult.Success,
          correlationId: request.id,
          details: { roles: grants },
        });
        return created;
      });

      const otpauthUri = new OTPAuth.TOTP({
        issuer: "diplom.mn",
        label: invitation.email,
        secret: totpSecret,
      }).toString();

      // Returned exactly once; not stored anywhere except the user row.
      return {
        userId: result.id,
        totp: { secret: totpSecret.base32, otpauthUri },
      };
    },
  );
}
