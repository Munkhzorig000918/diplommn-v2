import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appendAuditEvent,
  invitations,
  userRoles,
  users,
  type Db,
} from "@diplommn/db";
import {
  AuditAction,
  AuditResource,
  AuditResult,
  isRole,
  Role,
} from "@diplommn/shared";
import type { Notifier } from "@diplommn/notify";
import { hashSessionToken, requireRole } from "../../plugins/auth.js";

const InviteBody = z.object({
  email: z.string().email(),
  fullName: z.string().min(1).max(200),
  roles: z
    .array(
      z.object({
        role: z.string().refine(isRole, "unknown role"),
        institutionId: z.string().uuid().nullish(),
      }),
    )
    .min(1),
});

const INVITATION_TTL_DAYS = 7;

export function registerUserRoutes(
  app: FastifyInstance,
  db: Db,
  notifier: Notifier | null = null,
): void {
  /** Platform admin invites staff. The token travels by email; with the
   * console (dev) notifier it is also returned in the response. */
  app.post("/api/v1/users/invitations", async (request, reply) => {
    const admin = requireRole(request, Role.PlatformAdmin);
    const body = InviteBody.parse(request.body);

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 3_600_000,
    );

    const invitation = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invitations)
        .values({
          email: body.email.toLowerCase(),
          fullName: body.fullName,
          roles: body.roles,
          tokenHash: hashSessionToken(token),
          invitedBy: admin.id,
          expiresAt,
        })
        .returning({ id: invitations.id });
      if (!row) throw new Error("failed to create invitation");
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: admin.id,
        action: AuditAction.InvitationCreated,
        resourceType: AuditResource.Invitation,
        resourceId: row.id,
        result: AuditResult.Success,
        correlationId: request.id,
        details: { email: body.email.toLowerCase(), roles: body.roles },
      });
      return row;
    });

    // Email delivery; a failure never rolls back the invitation (the admin
    // can re-issue). The body carries only the token the recipient owns.
    let delivered = false;
    if (notifier) {
      try {
        await notifier.sendEmail(
          body.email.toLowerCase(),
          "diplom.mn — ажилтны бүртгэлийн урилга",
          [
            `Сайн байна уу, ${body.fullName}.`,
            "",
            "Таныг diplom.mn-ий ажилтны консолд урьсан байна.",
            `Бүртгэлээ идэвхжүүлэх код (7 хоног хүчинтэй):`,
            "",
            `  ${token}`,
            "",
            "Кодыг консолын нэвтрэх хуудасны «Урилга идэвхжүүлэх» хэсэгт оруулж, нууц үг болон баталгаажуулагч аппаа тохируулна уу.",
          ].join("\n"),
        );
        delivered = notifier.kind === "smtp";
      } catch (err) {
        request.log.error({ err }, "invitation email delivery failed");
      }
    }

    // Dev convenience: without real delivery the token is returned so the
    // admin can hand it over out-of-band.
    return reply.status(201).send({
      invitationId: invitation.id,
      expiresAt,
      delivered,
      ...(delivered ? {} : { token }),
    });
  });

  app.get("/api/v1/users", async (request) => {
    requireRole(request, Role.PlatformAdmin, Role.Auditor);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(100);

    const withRoles = await Promise.all(
      rows.map(async (u) => ({
        ...u,
        roles: await db
          .select({
            role: userRoles.role,
            institutionId: userRoles.institutionId,
          })
          .from(userRoles)
          .where(eq(userRoles.userId, u.id)),
      })),
    );
    return { users: withRoles };
  });
}
