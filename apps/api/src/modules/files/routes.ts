import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { credentials, type Db } from "@diplommn/db";
import { AppError, Role } from "@diplommn/shared";
import type { Storage } from "@diplommn/storage";
import { requireInstitutionScope } from "../../plugins/auth.js";
import { requireHolder } from "../../plugins/holder-auth.js";

const IdParams = z.object({ id: z.string().uuid() });

/** PDF artifact downloads — streamed from object storage, checksum exposed. */
export function registerFileRoutes(
  app: FastifyInstance,
  db: Db,
  storage: Storage,
): void {
  async function streamPdf(
    reply: import("fastify").FastifyReply,
    objectKey: string,
    certificateId: string | null,
    sha256: string | null,
  ) {
    const obj = await storage.getObjectStream(objectKey);
    reply.header("content-type", "application/pdf");
    reply.header(
      "content-disposition",
      `attachment; filename="certificate-${certificateId ?? "document"}.pdf"`,
    );
    if (obj.contentLength) reply.header("content-length", obj.contentLength);
    if (sha256) reply.header("x-checksum-sha256", sha256);
    return reply.send(obj.stream);
  }

  app.get("/api/v1/holder/credentials/:id/pdf", async (request, reply) => {
    const holder = requireHolder(request);
    const { id } = IdParams.parse(request.params);
    const rows = await db
      .select({
        pdfObjectKey: credentials.pdfObjectKey,
        pdfSha256: credentials.pdfSha256,
        certificateId: credentials.certificateId,
      })
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.holderId, holder.id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound("Credential not found");
    if (!row.pdfObjectKey) {
      throw AppError.notFound("PDF is not available yet");
    }
    return streamPdf(reply, row.pdfObjectKey, row.certificateId, row.pdfSha256);
  });

  app.get("/api/v1/credentials/:id/pdf", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const rows = await db
      .select({
        institutionId: credentials.institutionId,
        pdfObjectKey: credentials.pdfObjectKey,
        pdfSha256: credentials.pdfSha256,
        certificateId: credentials.certificateId,
      })
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound("Credential not found");
    requireInstitutionScope(
      request,
      row.institutionId,
      Role.Operator,
      Role.Approver,
      Role.LifecycleAdmin,
      Role.PlatformAdmin,
      Role.Auditor,
    );
    if (!row.pdfObjectKey) throw AppError.notFound("PDF is not available yet");
    return streamPdf(reply, row.pdfObjectKey, row.certificateId, row.pdfSha256);
  });
}
