/**
 * Development / bootstrap seed. Idempotent: safe to re-run.
 *
 * Creates: bootstrap platform admin (+demo staff for each role), a demo
 * institution + credential types, one demo holder and one ISSUED credential so
 * the public verifier works immediately. All writes go through the audit chain.
 *
 * TOTP secrets and the demo certificate ID are printed to stdout ONCE — this
 * is a development convenience only; production onboarding uses invitations.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { hash as argon2Hash } from "@node-rs/argon2";
import * as OTPAuth from "otpauth";
import {
  AuditAction,
  AuditResource,
  AuditResult,
  computeContentHash,
  formatCertificateId,
  generateCertificateId,
  generateSaltHex,
  Role,
} from "@diplommn/shared";
import { createDb, type Db } from "./client.js";
import { appendAuditEvent } from "./audit-chain.js";
import {
  credentialEvents,
  credentials,
  credentialTypes,
  holders,
  institutions,
  userRoles,
  users,
} from "./schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env") });

const ARGON2_OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 4 };

async function ensureUser(
  db: Db,
  opts: {
    email: string;
    fullName: string;
    password: string;
    roles: Role[];
  },
): Promise<{ id: string; created: boolean; totpSecret?: string }> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${opts.email})`)
    .limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const passwordHash = await argon2Hash(opts.password, ARGON2_OPTS);
  const totp = new OTPAuth.Secret({ size: 20 });

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email: opts.email.toLowerCase(),
        fullName: opts.fullName,
        status: "ACTIVE",
        passwordHash,
        totpSecret: totp.base32,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to insert user");
    for (const role of opts.roles) {
      await tx.insert(userRoles).values({ userId: row.id, role });
    }
    await appendAuditEvent(tx, {
      actorType: "SYSTEM",
      action: AuditAction.InvitationAccepted,
      resourceType: AuditResource.User,
      resourceId: row.id,
      source: "SYSTEM",
      result: AuditResult.Success,
      details: { seeded: true, roles: opts.roles },
    });
    return { id: row.id, created: true, totpSecret: totp.base32 };
  });
}

function otpauthUri(email: string, base32: string): string {
  return new OTPAuth.TOTP({
    issuer: "diplom.mn",
    label: email,
    secret: OTPAuth.Secret.fromBase32(base32),
  }).toString();
}

const { db, pool } = createDb();
try {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@diplom.mn";
  const adminPassword =
    process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "ChangeMe-Now-1234";

  const demoUsers = [
    { email: adminEmail, fullName: "Platform Admin", roles: [Role.PlatformAdmin] },
    { email: "operator@diplom.mn", fullName: "Демо Оператор", roles: [Role.Operator] },
    { email: "approver@diplom.mn", fullName: "Демо Зөвшөөрөгч", roles: [Role.Approver] },
    { email: "lifecycle@diplom.mn", fullName: "Демо Лайфсайкл Админ", roles: [Role.LifecycleAdmin] },
    { email: "auditor@diplom.mn", fullName: "Демо Аудитор", roles: [Role.Auditor] },
  ];

  const userIds = new Map<string, string>();
  for (const u of demoUsers) {
    const res = await ensureUser(db, { ...u, password: adminPassword });
    userIds.set(u.email, res.id);
    if (res.created && res.totpSecret) {
      console.log(`\nUser created: ${u.email} (password: from BOOTSTRAP_ADMIN_PASSWORD)`);
      console.log(`  TOTP secret: ${res.totpSecret}`);
      console.log(`  otpauth URI: ${otpauthUri(u.email, res.totpSecret)}`);
    }
  }

  // Demo institution & credential types
  let [inst] = await db
    .select()
    .from(institutions)
    .where(eq(institutions.code, "MUIS"))
    .limit(1);
  if (!inst) {
    [inst] = await db
      .insert(institutions)
      .values({
        code: "MUIS",
        nameMn: "Монгол Улсын Их Сургууль",
        nameEn: "National University of Mongolia",
      })
      .returning();
    console.log("\nInstitution created: MUIS");
  }
  if (!inst) throw new Error("institution seed failed");

  let [bachelor] = await db
    .select()
    .from(credentialTypes)
    .where(eq(credentialTypes.code, "DIPLOMA_BACHELOR"))
    .limit(1);
  if (!bachelor) {
    [bachelor] = await db
      .insert(credentialTypes)
      .values({
        code: "DIPLOMA_BACHELOR",
        kind: "DIPLOMA",
        nameMn: "Бакалаврын диплом",
        nameEn: "Bachelor's diploma",
      })
      .returning();
    await db.insert(credentialTypes).values({
      code: "CERT_PROFESSIONAL",
      kind: "CERTIFICATE",
      nameMn: "Мэргэшлийн гэрчилгээ",
      nameEn: "Professional certificate",
    });
    console.log("Credential types created: DIPLOMA_BACHELOR, CERT_PROFESSIONAL");
  }
  if (!bachelor) throw new Error("credential type seed failed");

  // Demo holder + one issued credential (mirrors the real issuance data shape)
  let [holder] = await db
    .select()
    .from(holders)
    .where(eq(holders.registrationNumber, "УК99112233"))
    .limit(1);
  if (!holder) {
    [holder] = await db
      .insert(holders)
      .values({
        lastName: "Дорж",
        firstName: "Батболд",
        registrationNumber: "УК99112233",
        email: "batbold@example.mn",
      })
      .returning();
  }
  if (!holder) throw new Error("holder seed failed");

  const existingCred = await db
    .select({ certificateId: credentials.certificateId })
    .from(credentials)
    .where(eq(credentials.holderId, holder.id))
    .limit(1);

  if (existingCred[0]?.certificateId) {
    console.log(
      `\nDemo credential already present. Certificate ID: ${formatCertificateId(existingCred[0].certificateId)}`,
    );
  } else {
    const operatorId = userIds.get("operator@diplom.mn");
    const approverId = userIds.get("approver@diplom.mn");
    if (!operatorId || !approverId) throw new Error("demo users missing");

    const claims = {
      holderName: "Дорж Батболд",
      institution: "Монгол Улсын Их Сургууль",
      program: "Мэдээллийн технологи",
      degree: "Бакалавр",
      credentialNumber: "D-2026-00123",
      awardedDate: "2026-06-15",
    };
    const salt = generateSaltHex();
    const { hash, alg, canonicalization } = computeContentHash(claims, salt);
    const certificateId = generateCertificateId();
    const now = new Date();

    await db.transaction(async (tx) => {
      const [cred] = await tx
        .insert(credentials)
        .values({
          certificateId,
          credentialNumber: "D-2026-00123",
          credentialTypeId: bachelor.id,
          institutionId: inst.id,
          holderId: holder.id,
          claims,
          submittedSnapshot: claims,
          lifecycleStatus: "ISSUED",
          contentSalt: salt,
          contentHash: hash,
          contentHashAlg: alg,
          canonicalization,
          issuedAt: now,
          createdBy: operatorId,
          submittedBy: operatorId,
          submittedAt: now,
          approvedBy: approverId,
          approvedAt: now,
        })
        .returning({ id: credentials.id });
      if (!cred) throw new Error("credential seed failed");
      await tx.insert(credentialEvents).values({
        credentialId: cred.id,
        eventType: "issued",
        toStatus: "ISSUED",
        details: { seeded: true },
      });
      await appendAuditEvent(tx, {
        actorType: "SYSTEM",
        action: AuditAction.CredentialIssued,
        resourceType: AuditResource.Credential,
        resourceId: cred.id,
        source: "SYSTEM",
        result: AuditResult.Success,
        details: { seeded: true, certificateId },
      });
    });

    console.log(`\nDemo credential issued.`);
    console.log(`  Certificate ID: ${formatCertificateId(certificateId)}`);
    console.log(`  Try: GET /api/v1/verify/${formatCertificateId(certificateId)}`);
  }

  console.log("\nSeed complete.");
} finally {
  await pool.end();
}
