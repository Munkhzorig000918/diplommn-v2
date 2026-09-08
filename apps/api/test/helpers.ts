import { randomBytes, randomUUID } from "node:crypto";
import { hash as argon2Hash } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import {
  createDb,
  credentialTypes,
  institutions,
  sessions,
  userRoles,
  users,
  type Db,
} from "@diplommn/db";
import type { Role } from "@diplommn/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { hashSessionToken, SESSION_COOKIE } from "../src/plugins/auth.js";
import type pg from "pg";

export const TEST_PASSWORD = "TestPassword-123!";
let cachedPasswordHash: string | null = null;

export async function testPasswordHash(): Promise<string> {
  cachedPasswordHash ??= await argon2Hash(TEST_PASSWORD, {
    memoryCost: 8192,
    timeCost: 2,
    parallelism: 1,
  });
  return cachedPasswordHash;
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  pool: pg.Pool;
}

export async function createTestContext(): Promise<TestContext> {
  process.env.DATABASE_URL ??=
    "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";
  process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  const app = await buildServer(db, config, { logger: false });
  return { app, db, pool };
}

export async function makeUser(
  db: Db,
  roles: { role: Role; institutionId?: string | null }[],
  opts: { totpSecret?: string | null } = {},
): Promise<{ id: string; email: string }> {
  const email = `test-${randomUUID()}@test.diplom.mn`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      fullName: "Test User",
      status: "ACTIVE",
      passwordHash: await testPasswordHash(),
      totpSecret: opts.totpSecret ?? null,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("failed to create test user");
  for (const grant of roles) {
    await db.insert(userRoles).values({
      userId: user.id,
      role: grant.role,
      institutionId: grant.institutionId ?? null,
    });
  }
  return { id: user.id, email };
}

/** Create a live session directly (bypasses login — auth is tested separately). */
export async function sessionCookieFor(
  db: Db,
  userId: string,
): Promise<Record<string, string>> {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

export async function makeInstitutionAndType(db: Db): Promise<{
  institutionId: string;
  credentialTypeId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [inst] = await db
    .insert(institutions)
    .values({
      code: `TEST-${suffix}`,
      nameMn: "Тест Их Сургууль",
      nameEn: "Test University",
    })
    .returning({ id: institutions.id });
  const [type] = await db
    .insert(credentialTypes)
    .values({
      code: `TEST_DIPLOMA_${suffix}`,
      kind: "DIPLOMA",
      nameMn: "Тест диплом",
      nameEn: "Test diploma",
    })
    .returning({ id: credentialTypes.id });
  if (!inst || !type) throw new Error("failed to create reference data");
  return { institutionId: inst.id, credentialTypeId: type.id };
}

export function uniqueRegNum(): string {
  return `TT${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0")}`;
}
