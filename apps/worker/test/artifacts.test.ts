import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  credentials,
  credentialTypes,
  holders,
  institutions,
  users,
  type Db,
} from "@diplommn/db";
import {
  computeContentHash,
  generateCertificateId,
  generateSaltHex,
  sha256Hex,
} from "@diplommn/shared";
import { createStorage, type Storage } from "@diplommn/storage";
import type { Notifier } from "@diplommn/notify";
import type pg from "pg";
import { generatePdfArtifact } from "../src/jobs/generate-pdf.js";
import { notifyIssued } from "../src/jobs/notify-issued.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";

describe("worker artifact jobs (integration)", () => {
  let db: Db;
  let pool: pg.Pool;
  let storage: Storage;
  let credentialId: string;
  let certificateId: string;

  beforeAll(async () => {
    ({ db, pool } = createDb(DATABASE_URL));
    storage = createStorage();
    await storage.ensureBucket();

    // Seed one issued credential directly (worker consumes what the API issued).
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        email: `worker-test-${suffix}@test.diplom.mn`,
        fullName: "Worker Test",
        status: "ACTIVE",
      })
      .returning({ id: users.id });
    const [inst] = await db
      .insert(institutions)
      .values({ code: `WT-${suffix}`, nameMn: "Тест ИС", nameEn: "Test U" })
      .returning({ id: institutions.id });
    const [type] = await db
      .insert(credentialTypes)
      .values({
        code: `WT_DIPLOMA_${suffix}`,
        kind: "DIPLOMA",
        nameMn: "Тест диплом",
        nameEn: "Test diploma",
      })
      .returning({ id: credentialTypes.id });
    const [holder] = await db
      .insert(holders)
      .values({
        lastName: "Ганбат",
        firstName: "Тэмүүжин",
        registrationNumber: `WT${Math.floor(Math.random() * 1e8)}`,
        email: "temuujin@example.mn",
      })
      .returning({ id: holders.id });
    if (!user || !inst || !type || !holder) throw new Error("seed failed");

    const claims = {
      program: "Компьютерийн ухаан",
      degree: "Бакалавр",
      awardedDate: "2026-06-30",
    };
    const salt = generateSaltHex();
    const { hash, alg, canonicalization } = computeContentHash(claims, salt);
    certificateId = generateCertificateId();
    const [cred] = await db
      .insert(credentials)
      .values({
        certificateId,
        credentialNumber: `WT-${suffix}`,
        credentialTypeId: type.id,
        institutionId: inst.id,
        holderId: holder.id,
        claims,
        submittedSnapshot: claims,
        lifecycleStatus: "ISSUED",
        contentSalt: salt,
        contentHash: hash,
        contentHashAlg: alg,
        canonicalization,
        issuedAt: new Date(),
        createdBy: user.id,
      })
      .returning({ id: credentials.id });
    if (!cred) throw new Error("credential seed failed");
    credentialId = cred.id;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("generates a PDF, uploads it, and records key + checksum", async () => {
    const result = await generatePdfArtifact(
      db,
      storage,
      "http://localhost:3000",
      credentialId,
    );
    expect(result.skipped).toBeUndefined();
    expect(result.objectKey).toContain(credentialId);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Object exists and matches the stored checksum.
    const obj = await storage.getObjectStream(result.objectKey);
    const chunks: Buffer[] = [];
    for await (const c of obj.stream) chunks.push(c as Buffer);
    const pdf = Buffer.concat(chunks);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256Hex(pdf)).toBe(result.sha256);
    // Must always fit a single A4 page.
    const pageCount = (pdf.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
    expect(pageCount).toBe(1);

    const [row] = await db
      .select({
        pdfObjectKey: credentials.pdfObjectKey,
        pdfSha256: credentials.pdfSha256,
      })
      .from(credentials)
      .where(eq(credentials.id, credentialId));
    expect(row?.pdfObjectKey).toBe(result.objectKey);
    expect(row?.pdfSha256).toBe(result.sha256);
  });

  it("is idempotent — re-running overwrites cleanly", async () => {
    const again = await generatePdfArtifact(
      db,
      storage,
      "http://localhost:3000",
      credentialId,
    );
    expect(again.objectKey).toBeTruthy();
  });

  it("skips credentials without a certificate ID instead of retrying forever", async () => {
    const [row] = await db
      .select({ holderId: credentials.holderId, typeId: credentials.credentialTypeId, instId: credentials.institutionId, createdBy: credentials.createdBy })
      .from(credentials)
      .where(eq(credentials.id, credentialId));
    const [draft] = await db
      .insert(credentials)
      .values({
        credentialTypeId: row!.typeId,
        institutionId: row!.instId,
        holderId: row!.holderId,
        claims: {},
        createdBy: row!.createdBy,
      })
      .returning({ id: credentials.id });
    const result = await generatePdfArtifact(
      db,
      storage,
      "http://localhost:3000",
      draft!.id,
    );
    expect(result.skipped).toBe("no certificate id");
  });

  it("sends the issuance notification through the provider", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const capture: Notifier = {
      kind: "console",
      async sendEmail(to, subject, text) {
        sent.push({ to, subject, text });
      },
    };
    const result = await notifyIssued(
      db,
      capture,
      "http://localhost:3000",
      credentialId,
    );
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("temuujin@example.mn");
    expect(sent[0]!.text).toContain("/verify/");
    // Never leak registration numbers in notifications.
    expect(sent[0]!.text).not.toMatch(/WT\d{8}/);
  });
});
