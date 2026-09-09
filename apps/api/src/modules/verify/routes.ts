import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  anchorBatches,
  appendAuditEvent,
  credentials,
  credentialTypes,
  holders,
  institutions,
  statusLists,
  type Db,
} from "@diplommn/db";
import type { DidWebDocument } from "@diplommn/did";
import type { Signed, StatusListCredential } from "@diplommn/vc";
import {
  createDidWebResolver,
  createEthereumRootFetcher,
  createStatusListFetcher,
  verifyProofBundle,
  type ProofBundle,
} from "@diplommn/verifier";
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

const BundleAnchor = z.object({
  batchId: z.string(),
  merkleRoot: z.string(),
  merkleProof: z.array(z.string()),
  chainId: z.number().int(),
  contractAddress: z.string(),
  txHash: z.string().nullable(),
  blockNumber: z.string().nullable(),
  status: z.string(),
});

const BundleBody = z.object({
  bundleVersion: z.string().optional(),
  vc: z.record(z.string(), z.unknown()),
  leaf: z
    .object({
      salt: z.string().nullable(),
      source: z.enum(["vc", "claims"]),
      hashAlg: z.string().nullable(),
    })
    .optional(),
  anchor: BundleAnchor.nullable().optional(),
});

export function registerVerifyRoutes(
  app: FastifyInstance,
  db: Db,
  config: ApiConfig,
  localDidDocument: DidWebDocument | null = null,
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
  /**
   * V2 verification path (Phase 2): verify a presented VC / proof bundle
   * with the open-verifier core running server-side. Accepts the holder's
   * downloaded proof bundle or a bare signed VC. Stateless with respect to
   * our credential store — only the DID document, the status list and the
   * anchored root are consulted, exactly like an external verifier would.
   */
  const webDidResolver = createDidWebResolver();
  const webStatusListFetcher = createStatusListFetcher();
  const rootFetcher = config.ANCHOR_RPC_URL
    ? createEthereumRootFetcher(config.ANCHOR_RPC_URL)
    : null;

  app.post(
    "/api/v1/verify/bundle",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const raw = request.body as Record<string, unknown> | null;
      // Accept both the wrapped proof bundle and a bare signed VC.
      const parsed = BundleBody.safeParse(
        raw && typeof raw === "object" && "vc" in raw ? raw : { vc: raw },
      );
      if (!parsed.success || typeof parsed.data.vc !== "object") {
        throw AppError.validation("Body must be a proof bundle or a signed VC");
      }
      const vc = parsed.data.vc as ProofBundle["vc"];
      if (!vc || typeof vc !== "object" || !("proof" in vc)) {
        throw AppError.validation("Credential is missing its proof");
      }

      const bundle: ProofBundle = {
        bundleVersion: parsed.data.bundleVersion ?? "1.0",
        vc,
        leaf: parsed.data.leaf ?? { salt: null, source: "vc", hashAlg: null },
        anchor: parsed.data.anchor ?? null,
      };

      const report = await verifyProofBundle(bundle, {
        resolveDidDocument: async (did) => {
          if (localDidDocument && localDidDocument.id === did) {
            return localDidDocument;
          }
          return webDidResolver(did);
        },
        fetchStatusList: async (url) => {
          // Our own lists come straight from the store; foreign URLs go out
          // over the network like any external verifier.
          const own = /\/status\/(\d+)$/.exec(url);
          if (own) {
            const [row] = await db
              .select({ credential: statusLists.credential })
              .from(statusLists)
              .where(eq(statusLists.listId, Number(own[1])))
              .limit(1);
            if (row) return row.credential as Signed<StatusListCredential>;
          }
          return webStatusListFetcher(url);
        },
        ...(rootFetcher ? { fetchAnchoredRoot: rootFetcher } : {}),
      });

      await db.transaction(async (tx) => {
        await appendAuditEvent(tx, {
          actorType: "PUBLIC",
          action: AuditAction.PublicVerificationPerformed,
          resourceType: AuditResource.Credential,
          resourceId: null,
          result: AuditResult.Success,
          correlationId: request.id,
          details: { path: "vc-bundle", result: report.result },
        });
      });

      const proof = ((vc as { proof?: unknown }).proof ?? {}) as Record<
        string,
        unknown
      >;
      return {
        result: report.result,
        checks: report.checks,
        details: report.details,
        verifiedAt: new Date().toISOString(),
        credential: {
          id: (vc as { id?: string }).id ?? null,
          type: (vc as { type?: string[] }).type ?? [],
          issuer: vc.issuer,
          validFrom: (vc as { validFrom?: string }).validFrom ?? null,
          // The holder presented this VC themselves — its subject is shown
          // back to the person it was handed to, not looked up from our DB.
          subject:
            (vc as { credentialSubject?: unknown }).credentialSubject ?? null,
        },
        technical: {
          verificationMethod: proof.verificationMethod ?? null,
          cryptosuite: proof.cryptosuite ?? null,
          proofCreated: proof.created ?? null,
          credentialStatus: vc.credentialStatus ?? null,
          anchor: bundle.anchor,
        },
      };
    },
  );

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
          vcSignedAt: credentials.vcSignedAt,
          vcKeyId: credentials.vcKeyId,
          statusListIndex: credentials.statusListIndex,
          anchorStatus: credentials.anchorStatus,
          anchorBatchId: credentials.anchorBatchId,
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
        technical: await buildTechnicalInfo(db, config, row),
      };
    },
  );
}

/** Public-safe proof metadata for the "Техникийн баталгаа" panel — hashes,
 * transaction coordinates and key ids only, never PII or salts. */
async function buildTechnicalInfo(
  db: Db,
  config: ApiConfig,
  row: {
    vcSignedAt: Date | null;
    vcKeyId: string | null;
    statusListIndex: number | null;
    anchorStatus: string;
    anchorBatchId: string | null;
  },
): Promise<Record<string, unknown> | null> {
  if (!row.vcSignedAt && !row.anchorBatchId) return null;

  let anchor: Record<string, unknown> | null = null;
  if (row.anchorBatchId) {
    const [batch] = await db
      .select({
        batchId: anchorBatches.batchId,
        merkleRoot: anchorBatches.merkleRoot,
        chainId: anchorBatches.chainId,
        contractAddress: anchorBatches.contractAddress,
        txHash: anchorBatches.txHash,
        blockNumber: anchorBatches.blockNumber,
        status: anchorBatches.status,
        confirmedAt: anchorBatches.confirmedAt,
      })
      .from(anchorBatches)
      .where(eq(anchorBatches.id, row.anchorBatchId))
      .limit(1);
    if (batch) {
      anchor = {
        batchId: batch.batchId.toString(),
        merkleRoot: batch.merkleRoot,
        chainId: batch.chainId,
        contractAddress: batch.contractAddress,
        txHash: batch.txHash,
        blockNumber: batch.blockNumber?.toString() ?? null,
        status: batch.status,
        confirmedAt: batch.confirmedAt,
      };
    }
  }

  return {
    issuerDid: config.VC_ISSUER_DID,
    vcSignedAt: row.vcSignedAt,
    vcKeyId: row.vcKeyId,
    anchorStatus: row.anchorStatus,
    statusList:
      row.statusListIndex !== null
        ? { listId: 1, index: row.statusListIndex }
        : null,
    anchor,
  };
}
