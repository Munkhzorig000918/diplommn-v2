import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import {
  appendAuditEvent,
  credentialEvents,
  credentials,
  credentialTypes,
  holders,
  importBatches,
  importRows,
  institutions,
  type Db,
} from "@diplommn/db";
import {
  AppError,
  AuditAction,
  AuditResource,
  AuditResult,
  Role,
} from "@diplommn/shared";
import {
  requireInstitutionScope,
  requireRole,
  requireUser,
} from "../../plugins/auth.js";
import { submitCredential } from "../credentials/service.js";

/**
 * CSV import pipeline (design §9.5, §14.2): upload → per-row validation →
 * review → submit valid rows into the normal approval workflow. Mixed batches
 * make partial progress — a bad row never silently rolls back good rows; error
 * rows stay downloadable and fixable. Bulk approval does not exist.
 */

export const IMPORT_TEMPLATE_COLUMNS = [
  "lastName",
  "firstName",
  "registrationNumber",
  "email",
  "credentialNumber",
  "program",
  "degree",
  "awardedDate",
] as const;

const MAX_ROWS = 5000;

const RowSchema = z.object({
  lastName: z.string().trim().min(1, "lastName is required").max(100),
  firstName: z.string().trim().min(1, "firstName is required").max(100),
  registrationNumber: z
    .string()
    .trim()
    .min(4, "registrationNumber too short")
    .max(20),
  email: z
    .string()
    .trim()
    .email("invalid email")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  credentialNumber: z.string().trim().min(1, "credentialNumber is required").max(100),
  program: z.string().trim().min(1, "program is required").max(300),
  degree: z.string().trim().min(1, "degree is required").max(300),
  awardedDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "awardedDate must be YYYY-MM-DD"),
});

const IdParams = z.object({ id: z.string().uuid() });
const RowsQuery = z.object({
  errorsOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().min(1).max(500).default(100),
  offset: z.coerce.number().min(0).default(0),
});

interface UploadBody {
  file?: Buffer;
  institutionId?: string;
  credentialTypeId?: string;
}

export function registerImportRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/v1/imports/template.csv", async (request, reply) => {
    requireRole(request, Role.Operator, Role.Approver, Role.PlatformAdmin);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      'attachment; filename="diplommn-import-template.csv"',
    );
    return `${IMPORT_TEMPLATE_COLUMNS.join(",")}\nДорж,Батболд,УК99112233,batbold@example.mn,D-2026-00123,Мэдээллийн технологи,Бакалавр,2026-06-15\n`;
  });

  app.post("/api/v1/imports", async (request, reply) => {
    const body = (request.body ?? {}) as UploadBody;
    const meta = z
      .object({
        institutionId: z.string().uuid(),
        credentialTypeId: z.string().uuid(),
      })
      .parse({
        institutionId: body.institutionId,
        credentialTypeId: body.credentialTypeId,
      });
    const user = requireInstitutionScope(
      request,
      meta.institutionId,
      Role.Operator,
    );
    if (!body.file || !(body.file instanceof Buffer) || body.file.length === 0) {
      throw AppError.validation("A CSV file is required (field name: file)");
    }

    const [institution] = await db
      .select()
      .from(institutions)
      .where(and(eq(institutions.id, meta.institutionId), eq(institutions.active, true)))
      .limit(1);
    if (!institution) throw AppError.validation("Unknown or inactive institution");
    const [credType] = await db
      .select()
      .from(credentialTypes)
      .where(and(eq(credentialTypes.id, meta.credentialTypeId), eq(credentialTypes.active, true)))
      .limit(1);
    if (!credType) throw AppError.validation("Unknown or inactive credential type");

    let records: Record<string, string>[];
    try {
      records = parseCsv(body.file, {
        columns: true,
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
      }) as Record<string, string>[];
    } catch (e) {
      throw AppError.validation("The file could not be parsed as CSV", {
        parseError: e instanceof Error ? e.message : String(e),
      });
    }
    if (records.length === 0) throw AppError.validation("The CSV contains no data rows");
    if (records.length > MAX_ROWS) {
      throw AppError.validation(`Too many rows (max ${MAX_ROWS} per batch)`, {
        rows: records.length,
      });
    }

    const header = Object.keys(records[0] ?? {});
    const missing = IMPORT_TEMPLATE_COLUMNS.filter(
      (c) => c !== "email" && !header.includes(c),
    );
    if (missing.length > 0) {
      throw AppError.validation("Required columns are missing", { missing });
    }

    // Per-row validation + duplicate detection inside the batch.
    const seen = new Map<string, number>();
    const parsedRows = records.map((raw, idx) => {
      const rowNumber = idx + 2; // header = line 1
      const result = RowSchema.safeParse(raw);
      const errors: { field: string; message: string }[] = [];
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({ field: issue.path.join("."), message: issue.message });
        }
      } else {
        const key = `${result.data.registrationNumber}::${result.data.credentialNumber}`;
        const firstSeen = seen.get(key);
        if (firstSeen !== undefined) {
          errors.push({
            field: "credentialNumber",
            message: `duplicate of row ${firstSeen} (same registrationNumber + credentialNumber)`,
          });
        } else {
          seen.set(key, rowNumber);
        }
      }
      return { rowNumber, raw, errors, valid: errors.length === 0 };
    });

    const validCount = parsedRows.filter((r) => r.valid).length;
    const batch = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(importBatches)
        .values({
          fileName: "upload.csv",
          institutionId: meta.institutionId,
          credentialTypeId: meta.credentialTypeId,
          status: "READY_FOR_REVIEW",
          totalRows: parsedRows.length,
          validRows: validCount,
          errorRows: parsedRows.length - validCount,
          createdBy: user.id,
        })
        .returning({ id: importBatches.id });
      if (!row) throw new Error("failed to create batch");

      for (const r of parsedRows) {
        await tx.insert(importRows).values({
          batchId: row.id,
          rowNumber: r.rowNumber,
          raw: r.raw,
          errors: r.errors.length ? r.errors : null,
          status: r.valid ? "PENDING" : "ERROR",
        });
      }
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.ImportBatchCreated,
        resourceType: AuditResource.ImportBatch,
        resourceId: row.id,
        result: AuditResult.Success,
        correlationId: request.id,
        source: "IMPORT",
        details: {
          institutionId: meta.institutionId,
          credentialTypeId: meta.credentialTypeId,
          totalRows: parsedRows.length,
          validRows: validCount,
          errorRows: parsedRows.length - validCount,
        },
      });
      return row;
    });

    return reply.status(201).send({
      id: batch.id,
      totalRows: parsedRows.length,
      validRows: validCount,
      errorRows: parsedRows.length - validCount,
    });
  });

  app.get("/api/v1/imports", async (request) => {
    const user = requireRole(
      request,
      Role.Operator,
      Role.Approver,
      Role.PlatformAdmin,
      Role.Auditor,
    );
    // Institution-scoped users only see their institutions' batches.
    const hasGlobal = user.roles.some((r) => r.institutionId === null);
    const scoped = [
      ...new Set(
        user.roles.flatMap((r) => (r.institutionId ? [r.institutionId] : [])),
      ),
    ];
    if (!hasGlobal && scoped.length === 0) return { items: [] };
    const first = scoped[0];
    const items = await db
      .select()
      .from(importBatches)
      .where(
        hasGlobal || first === undefined
          ? undefined
          : inArray(importBatches.institutionId, scoped),
      )
      .orderBy(desc(importBatches.createdAt))
      .limit(50);
    return { items };
  });

  app.get("/api/v1/imports/:id", async (request) => {
    requireUser(request);
    const { id } = IdParams.parse(request.params);
    const query = RowsQuery.parse(request.query);

    const [batch] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, id))
      .limit(1);
    if (!batch) throw AppError.notFound("Batch not found");
    requireInstitutionScope(
      request,
      batch.institutionId ?? "",
      Role.Operator,
      Role.Approver,
      Role.PlatformAdmin,
    );

    const conditions: SQL[] = [eq(importRows.batchId, id)];
    if (query.errorsOnly) conditions.push(eq(importRows.status, "ERROR"));
    const rows = await db
      .select()
      .from(importRows)
      .where(and(...conditions))
      .orderBy(asc(importRows.rowNumber))
      .limit(query.limit)
      .offset(query.offset);

    return { batch, rows };
  });

  app.get("/api/v1/imports/:id/errors.csv", async (request, reply) => {
    requireUser(request);
    const { id } = IdParams.parse(request.params);
    const [batch] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, id))
      .limit(1);
    if (!batch) throw AppError.notFound("Batch not found");
    requireInstitutionScope(
      request,
      batch.institutionId ?? "",
      Role.Operator,
      Role.Approver,
      Role.PlatformAdmin,
    );

    const rows = await db
      .select()
      .from(importRows)
      .where(and(eq(importRows.batchId, id), eq(importRows.status, "ERROR")))
      .orderBy(asc(importRows.rowNumber));

    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const lines = [
      ["rowNumber", "errors", ...IMPORT_TEMPLATE_COLUMNS].join(","),
      ...rows.map((r) => {
        const raw = r.raw as Record<string, string>;
        const errors = (r.errors as { field: string; message: string }[] | null)
          ?.map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        return [
          r.rowNumber,
          esc(errors),
          ...IMPORT_TEMPLATE_COLUMNS.map((c) => esc(raw[c])),
        ].join(",");
      }),
    ];
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="import-${id}-errors.csv"`,
    );
    return `﻿${lines.join("\n")}\n`;
  });

  /**
   * Submit valid rows into the approval workflow. Each row runs in its own
   * transaction: one failing row marks itself FAILED and the rest continue.
   */
  app.post("/api/v1/imports/:id/submit", async (request) => {
    const { id } = IdParams.parse(request.params);
    const [batch] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, id))
      .limit(1);
    if (!batch) throw AppError.notFound("Batch not found");
    if (!batch.institutionId || !batch.credentialTypeId) {
      throw AppError.conflict("Batch is missing institution/type context");
    }
    const user = requireInstitutionScope(
      request,
      batch.institutionId,
      Role.Operator,
    );
    if (batch.status !== "READY_FOR_REVIEW") {
      throw AppError.conflict("Batch has already been submitted or closed");
    }

    const [credType] = await db
      .select()
      .from(credentialTypes)
      .where(eq(credentialTypes.id, batch.credentialTypeId))
      .limit(1);
    if (!credType) throw AppError.conflict("Credential type no longer exists");

    const pendingRows = await db
      .select()
      .from(importRows)
      .where(and(eq(importRows.batchId, id), eq(importRows.status, "PENDING")))
      .orderBy(asc(importRows.rowNumber));

    let submitted = 0;
    let failed = 0;
    for (const row of pendingRows) {
      const raw = RowSchema.parse(row.raw);
      try {
        const credentialId = await db.transaction(async (tx) => {
          let [holder] = await tx
            .select()
            .from(holders)
            .where(eq(holders.registrationNumber, raw.registrationNumber))
            .limit(1);
          if (!holder) {
            [holder] = await tx
              .insert(holders)
              .values({
                lastName: raw.lastName,
                firstName: raw.firstName,
                registrationNumber: raw.registrationNumber,
                email: raw.email ?? null,
              })
              .returning();
          }
          if (!holder) throw new Error("failed to resolve holder");

          const [cred] = await tx
            .insert(credentials)
            .values({
              credentialTypeId: batch.credentialTypeId!,
              institutionId: batch.institutionId!,
              holderId: holder.id,
              credentialNumber: raw.credentialNumber,
              claims: {
                program: raw.program,
                degree: raw.degree,
                awardedDate: raw.awardedDate,
              },
              schemaVersion: credType.schemaVersion,
              sourceChannel: "IMPORT",
              importBatchId: id,
              createdBy: user.id,
            })
            .returning({ id: credentials.id });
          if (!cred) throw new Error("failed to create credential");
          await tx.insert(credentialEvents).values({
            credentialId: cred.id,
            eventType: "draft_created",
            toStatus: "DRAFT",
            actorUserId: user.id,
            details: { importBatchId: id, rowNumber: row.rowNumber },
          });
          return cred.id;
        });

        await submitCredential(db, credentialId, {
          userId: user.id,
          correlationId: request.id,
        });
        await db
          .update(importRows)
          .set({ status: "SUBMITTED", credentialId })
          .where(eq(importRows.id, row.id));
        submitted += 1;
      } catch (e) {
        failed += 1;
        await db
          .update(importRows)
          .set({
            status: "FAILED",
            errors: [
              {
                field: "*",
                message: e instanceof Error ? e.message : "submission failed",
              },
            ],
          })
          .where(eq(importRows.id, row.id));
      }
    }

    const finalStatus =
      failed === 0 && batch.errorRows === 0
        ? "COMPLETED"
        : submitted > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED";

    await db.transaction(async (tx) => {
      await tx
        .update(importBatches)
        .set({ status: finalStatus, updatedAt: new Date() })
        .where(eq(importBatches.id, id));
      await appendAuditEvent(tx, {
        actorType: "USER",
        actorUserId: user.id,
        action: AuditAction.ImportBatchSubmitted,
        resourceType: AuditResource.ImportBatch,
        resourceId: id,
        result: AuditResult.Success,
        correlationId: request.id,
        source: "IMPORT",
        details: { submitted, failed, errorRows: batch.errorRows, finalStatus },
      });
    });

    return { submitted, failed, errorRows: batch.errorRows, status: finalStatus };
  });
}
