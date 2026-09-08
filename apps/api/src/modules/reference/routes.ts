import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { credentialTypes, institutions, type Db } from "@diplommn/db";
import { requireUser } from "../../plugins/auth.js";

/** Read-only reference data for staff UIs (institutions, credential types). */
export function registerReferenceRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/v1/institutions", async (request) => {
    requireUser(request);
    const items = await db
      .select({
        id: institutions.id,
        code: institutions.code,
        nameMn: institutions.nameMn,
        nameEn: institutions.nameEn,
      })
      .from(institutions)
      .where(eq(institutions.active, true))
      .orderBy(asc(institutions.code));
    return { items };
  });

  app.get("/api/v1/credential-types", async (request) => {
    requireUser(request);
    const items = await db
      .select({
        id: credentialTypes.id,
        code: credentialTypes.code,
        kind: credentialTypes.kind,
        nameMn: credentialTypes.nameMn,
        nameEn: credentialTypes.nameEn,
        schemaVersion: credentialTypes.schemaVersion,
      })
      .from(credentialTypes)
      .where(eq(credentialTypes.active, true))
      .orderBy(asc(credentialTypes.code));
    return { items };
  });
}
