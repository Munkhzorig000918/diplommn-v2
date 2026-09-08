import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { sessions, userRoles, users, type Db } from "@diplommn/db";
import { AppError, type Role } from "@diplommn/shared";

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roles: { role: Role; institutionId: string | null }[];
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: AuthenticatedUser | null;
  }
}

export const SESSION_COOKIE = "dmn_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Session resolution — opaque random cookie token, server-side session row
 * (revocable), sha256-hashed at rest. All authorization is server-side.
 */
export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest("currentUser", null);

  app.addHook("preHandler", async (request) => {
    request.currentUser = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== "ACTIVE") return;

    const roles = await db
      .select({ role: userRoles.role, institutionId: userRoles.institutionId })
      .from(userRoles)
      .where(eq(userRoles.userId, row.userId));

    request.currentUser = {
      id: row.userId,
      email: row.email,
      fullName: row.fullName,
      roles: roles.map((r) => ({
        role: r.role as Role,
        institutionId: r.institutionId,
      })),
    };
  });
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.currentUser) throw AppError.unauthorized();
  return request.currentUser;
}

/** Global grant (institutionId null) or any scoped grant of the role. */
export function hasRole(user: AuthenticatedUser, ...roles: Role[]): boolean {
  return user.roles.some((r) => roles.includes(r.role));
}

export function requireRole(
  request: FastifyRequest,
  ...roles: Role[]
): AuthenticatedUser {
  const user = requireUser(request);
  if (!hasRole(user, ...roles)) throw AppError.forbidden();
  return user;
}

/**
 * Institution scoping: a role grant with institutionId=null is global; a
 * scoped grant only covers that institution (design doc scope model).
 */
export function canActOnInstitution(
  user: AuthenticatedUser,
  role: Role,
  institutionId: string,
): boolean {
  return user.roles.some(
    (r) =>
      r.role === role &&
      (r.institutionId === null || r.institutionId === institutionId),
  );
}

export function requireInstitutionScope(
  request: FastifyRequest,
  institutionId: string,
  ...roles: Role[]
): AuthenticatedUser {
  const user = requireUser(request);
  if (!roles.some((role) => canActOnInstitution(user, role, institutionId))) {
    throw AppError.forbidden();
  }
  return user;
}
