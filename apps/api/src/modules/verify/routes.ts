import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  appendAuditEvent,
  credentials,
  credentialTypes,
  holders,
  institutions,
  statusLists,
  type Db,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  formatCertificateId,
  maskHolderName,
  normalizeCertificateId,
  VerificationResult,
} from "@diplommn/shared";
import type { ApiConfig } from "../../config.js";

/**
 * Public verification (MVP path): exact random Certificate ID → database check.
 * No login, no enumeration (exact match only, rate limited), no PII beyond the
 * disclosure policy, "not found" never presented as "invalid" and never
 * distinguishable between "does not exist" and "not visible".
 */

/** Whitelisted VC-claim keys shown publicly (gap #19 default — minimal facts). */
const PUBLIC_CLAIM_KEYS = ["program", "degree", "awardedDate"] as const;

const Params = z.object({ certificateId: z.string().min(1).max(64) });

export function registerVerifyRoutes(
  app: FastifyInstance,
  db: Db,
  config: ApiConfig,
): void {
  /**
   * Public Bitstring Status List (Phase 2). Serves the worker-signed status
   * list credential; no auth, cacheable, CDN-mirrorable (stateless tier).
   */
  app.get("/status/:listId", async (request, reply) => {
    const { listId } = z
      .object({ listId: z.coerce.number().int().min(1).max(1_000_000) })
      .parse(request.params);
    const [row] = await db
      .select({
        credential: statusLists.credential,
        sha256: statusLists.sha256,
        generatedAt: statusLists.generatedAt,
      })
      .from(statusLists)
      .where(eq(statusLists.listId, listId))
      .limit(1);
    if (!row) throw AppError.notFound("Status list not found");
    reply
      .header("cache-control", "public, max-age=300")
      .header("x-status-list-sha256", row.sha256)
      .type("application/json");
    return row.credential;
  });
  app.get(
    "/api/v1/verify/:certificateId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { certificateId: raw } = Params.parse(request.params);
      const normalized = normalizeCertificateId(raw);
      if (!normalized) {
        // Format error — answered without touching the database (design §13.4).
        throw AppError.validation(
          "Certificate ID must be 20 characters (letters and digits), e.g. XXXXX-XXXXX-XXXXX-XXXXX",
          { expectedFormat: "XXXXX-XXXXX-XXXXX-XXXXX" },
        );
      }

      const rows = await db
        .select({
          id: credentials.id,
          certificateId: credentials.certificateId,
          credentialNumber: credentials.credentialNumber,
          lifecycleStatus: credentials.lifecycleStatus,
          issuedAt: credentials.issuedAt,
          claims: credentials.claims,
          submittedSnapshot: credentials.submittedSnapshot,
          institutionCode: institutions.code,
          institutionNameMn: institutions.nameMn,
          institutionNameEn: institutions.nameEn,
          typeKind: credentialTypes.kind,
          typeNameMn: credentialTypes.nameMn,
          typeNameEn: credentialTypes.nameEn,
          holderLastName: holders.lastName,
          holderFirstName: holders.firstName,
        })
        .from(credentials)
        .innerJoin(institutions, eq(credentials.institutionId, institutions.id))
        .innerJoin(
          credentialTypes,
          eq(credentials.credentialTypeId, credentialTypes.id),
        )
        .innerJoin(holders, eq(credentials.holderId, holders.id))
        .where(eq(credentials.certificateId, normalized))
        .limit(1);
      const row = rows[0];

      let result: VerificationResult;
      if (!row) {
        result = VerificationResult.NotFound;
      } else {
        switch (row.lifecycleStatus) {
          case "ISSUED":
            result = VerificationResult.Valid;
            break;
          case "REVOCATION_PENDING":
          case "REVOKED":
            result = VerificationResult.Revoked;
            break;
          case "SUPERSEDED":
            result = VerificationResult.Superseded;
            break;
          default:
            // Certificate IDs only exist from issuance; anything else is
            // unreachable — treat conservatively as not found.
            result = VerificationResult.NotFound;
        }
      }

      // Audit trail (privacy-minimized: no IP retention for public checks).
      await db.transaction(async (tx) => {
        await appendAuditEvent(tx, {
          actorType: "PUBLIC",
          action: AuditAction.PublicVerificationPerformed,
          resourceType: AuditResource.Credential,
          resourceId: row?.id ?? null,
          result: AuditResult.Success,
          correlationId: request.id,
          details: { result },
        });
      });

      const verifiedAt = new Date().toISOString();
      if (!row) {
        return {
          result,
          verifiedAt,
          message:
            "No verifiable credential was found for this identifier. Check the identifier and try again.",
        };
      }

      const claims = (row.submittedSnapshot ?? row.claims ?? {}) as Record<
        string,
        unknown
      >;
      const publicClaims: Record<string, unknown> = {};
      for (const key of PUBLIC_CLAIM_KEYS) {
        if (claims[key] !== undefined) publicClaims[key] = claims[key];
      }

      return {
        result,
        verifiedAt,
        credential: {
          certificateId: formatCertificateId(row.certificateId ?? normalized),
          credentialNumber: row.credentialNumber,
          holderName: maskHolderName(
            row.holderLastName,
            row.holderFirstName,
            config.PUBLIC_HOLDER_NAME_DISCLOSURE,
          ),
          institution: {
            code: row.institutionCode,
            nameMn: row.institutionNameMn,
            nameEn: row.institutionNameEn,
          },
          credentialType: {
            kind: row.typeKind,
            nameMn: row.typeNameMn,
            nameEn: row.typeNameEn,
          },
          issuedAt: row.issuedAt,
          publicClaims,
        },
        checks: [
          {
            check: "database_record",
            status: result === VerificationResult.Valid ? "PASSED" : "FAILED",
            description:
              "Record matched against the diplom.mn issuance database (MVP verification path)",
          },
        ],
      };
    },
  );
}
