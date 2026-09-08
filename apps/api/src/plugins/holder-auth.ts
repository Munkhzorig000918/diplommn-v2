import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { holders, holderSessions, type Db } from "@diplommn/db";
import { AppError } from "@diplommn/shared";
import { hashSessionToken } from "./auth.js";

export interface AuthenticatedHolder {
  id: string;
  firstName: string;
  lastName: string;
}

declare module "fastify" {
  interface FastifyRequest {
    currentHolder: AuthenticatedHolder | null;
  }
}

export const HOLDER_COOKIE = "dmn_holder";

/** Holder portal sessions — a separate surface from staff sessions. */
export function registerHolderAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest("currentHolder", null);

  app.addHook("preHandler", async (request) => {
    request.currentHolder = null;
    const token = request.cookies[HOLDER_COOKIE];
    if (!token) return;

    const rows = await db
      .select({
        id: holders.id,
        firstName: holders.firstName,
        lastName: holders.lastName,
      })
      .from(holderSessions)
      .innerJoin(holders, eq(holderSessions.holderId, holders.id))
      .where(
        and(
          eq(holderSessions.tokenHash, hashSessionToken(token)),
          isNull(holderSessions.revokedAt),
          gt(holderSessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) request.currentHolder = row;
  });
}

export function requireHolder(request: FastifyRequest): AuthenticatedHolder {
  if (!request.currentHolder) throw AppError.unauthorized();
  return request.currentHolder;
}
