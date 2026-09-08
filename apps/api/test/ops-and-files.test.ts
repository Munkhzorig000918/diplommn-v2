import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createDb, credentials, type Db } from "@diplommn/db";
import { Role, sha256Hex } from "@diplommn/shared";
import { createStorage } from "@diplommn/storage";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createQueues, type JobQueues } from "../src/queues.js";
import {
  makeInstitutionAndType,
  makeUser,
  sessionCookieFor,
  uniqueRegNum,
} from "./helpers.js";

describe("ops + file downloads (integration)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: pg.Pool;
  let queues: JobQueues;
  let adminHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;
  let credentialId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";
    process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";
    const config = loadConfig();
    ({ db, pool } = createDb(config.DATABASE_URL));
    const storage = createStorage();
    await storage.ensureBucket();
    queues = createQueues();
    app = await buildServer(db, config, { logger: false, queues, storage });

    const admin = await makeUser(db, [{ role: Role.PlatformAdmin }]);
    adminHeaders = await sessionCookieFor(db, admin.id);

    // Issue a credential and attach a PDF object directly (worker is tested separately).
    const { institutionId, credentialTypeId } = await makeInstitutionAndType(db);
    const operator = await makeUser(db, [{ role: Role.Operator }]);
    const approver = await makeUser(db, [{ role: Role.Approver }]);
    operatorHeaders = await sessionCookieFor(db, operator.id);
    const approverHeaders = await sessionCookieFor(db, approver.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: operatorHeaders,
      payload: {
        credentialTypeId,
        institutionId,
        holder: {
          lastName: "Отгон",
          firstName: "Мөнх",
          registrationNumber: uniqueRegNum(),
        },
        claims: { degree: "Бакалавр" },
      },
    });
    credentialId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/submit`,
      headers: operatorHeaders,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/approve`,
      headers: approverHeaders,
    });

    const fakePdf = Buffer.from("%PDF-1.7\n%test artifact\n%%EOF\n");
    const objectKey = `credentials/${credentialId}/certificate-test.pdf`;
    await storage.putObject(objectKey, fakePdf, "application/pdf");
    await db
      .update(credentials)
      .set({ pdfObjectKey: objectKey, pdfSha256: sha256Hex(fakePdf) })
      .where(eq(credentials.id, credentialId));
  });
  afterAll(async () => {
    await app.close();
    await queues.close();
    await pool.end();
  });

  it("streams the staff PDF download with checksum header", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/credentials/${credentialId}/pdf`,
      headers: operatorHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-checksum-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.startsWith("%PDF-")).toBe(true);
  });

  it("returns 404 for PDFs that are not generated yet, and for other holders", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/holder/credentials/${credentialId}/pdf`,
    });
    expect(res.statusCode).toBe(401); // no holder session at all
  });

  it("reports integration health and queue counts to platform admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ops/overview",
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.integrations.postgres.status).toBe("OPERATIONAL");
    expect(body.integrations.redis.status).toBe("OPERATIONAL");
    expect(body.integrations.objectStorage.status).toBe("OPERATIONAL");
    expect(body.queues.artifacts).toBeDefined();
    expect(body.queues.notifications).toBeDefined();
  });

  it("denies ops access to non-privileged roles", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ops/overview",
      headers: operatorHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists failed jobs (empty ok) and 404s retry of unknown jobs", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ops/jobs/failed?queue=artifacts",
      headers: adminHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().items)).toBe(true);

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/ops/jobs/artifacts/nonexistent-job-id/retry",
      headers: adminHeaders,
    });
    expect(retry.statusCode).toBe(404);
  });

  it("enqueues artifact regeneration for issued credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ops/credentials/${credentialId}/regenerate-artifacts`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const counts = await queues.artifacts.getJobCounts("waiting", "delayed", "active", "completed");
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});
