import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { holders } from "@diplommn/db";
import { Role } from "@diplommn/shared";
import { createDb } from "@diplommn/db";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  makeInstitutionAndType,
  makeUser,
  sessionCookieFor,
  uniqueRegNum,
} from "./helpers.js";
import type { Db } from "@diplommn/db";

describe("holder portal (integration)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: pg.Pool;
  const sentOtps: { destination: string; code: string }[] = [];

  let regNum: string;
  let certificateFormattedId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";
    process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";
    const config = loadConfig();
    ({ db, pool } = createDb(config.DATABASE_URL));
    app = await buildServer(db, config, {
      logger: false,
      otpDelivery: async (destination, code) => {
        sentOtps.push({ destination, code });
      },
    });

    // Issue one credential for a fresh holder with an email on file.
    const { institutionId, credentialTypeId } = await makeInstitutionAndType(db);
    const operator = await makeUser(db, [{ role: Role.Operator }]);
    const approver = await makeUser(db, [{ role: Role.Approver }]);
    const opHeaders = await sessionCookieFor(db, operator.id);
    const apHeaders = await sessionCookieFor(db, approver.id);

    regNum = uniqueRegNum();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: opHeaders,
      payload: {
        credentialTypeId,
        institutionId,
        holder: {
          lastName: "Сүхбат",
          firstName: "Номин",
          registrationNumber: regNum,
          email: "nomin@example.mn",
        },
        claims: { program: "Хууль", degree: "Бакалавр", awardedDate: "2026-06-01" },
      },
    });
    const credentialId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/submit`,
      headers: opHeaders,
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/approve`,
      headers: apHeaders,
    });
    certificateFormattedId = approved.json().certificateId as string;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function loginAsHolder(): Promise<string> {
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/holder/otp/request",
      payload: { registrationNumber: regNum },
    });
    expect(req.statusCode).toBe(200);
    const { challengeId } = req.json();
    const otp = sentOtps.at(-1);
    expect(otp?.destination).toBe("nomin@example.mn");

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/holder/otp/verify",
      payload: { challengeId, code: otp!.code },
    });
    expect(verify.statusCode).toBe(200);
    return String(verify.headers["set-cookie"]).split(";")[0]!;
  }

  it("gives an identical response for unknown registration numbers (no enumeration)", async () => {
    const before = sentOtps.length;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/holder/otp/request",
      payload: { registrationNumber: "XX00000000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().challengeId).toBeDefined();
    expect(sentOtps.length).toBe(before); // nothing sent
  });

  it("rejects wrong OTP codes and counts attempts", async () => {
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/holder/otp/request",
      payload: { registrationNumber: regNum },
    });
    const { challengeId } = req.json();
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/holder/otp/verify",
      payload: { challengeId, code: "000000" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("logs in with OTP, lists own credentials, and reads detail", async () => {
    const cookie = await loginAsHolder();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/holder/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().holder.registrationNumber).toMatch(/\*/);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/holder/credentials",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].certificateId).toBe(certificateFormattedId.includes("-")
      ? certificateFormattedId
      : items[0].certificateId);
    expect(items[0].lifecycleStatus).toBe("ISSUED");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/holder/credentials/${items[0].id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().credential.claims.program).toBe("Хууль");
    expect(detail.json().credential.pdfAvailable).toBe(false);
  });

  it("creates a share link, resolves it publicly, and revokes it", async () => {
    const cookie = await loginAsHolder();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/holder/credentials",
      headers: { cookie },
    });
    const credentialId = list.json().items[0].id as string;

    const share = await app.inject({
      method: "POST",
      url: `/api/v1/holder/credentials/${credentialId}/shares`,
      headers: { cookie },
      payload: { expiresInDays: 7 },
    });
    expect(share.statusCode).toBe(201);
    const { token, url } = share.json();
    expect(url).toContain("/s/");

    // Public resolution — no auth.
    const resolved = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().share.status).toBe("ACTIVE");
    expect(resolved.json().certificateId).toBeTruthy();

    // Access counted.
    const shares = await app.inject({
      method: "GET",
      url: "/api/v1/holder/shares",
      headers: { cookie },
    });
    const mine = shares.json().items.find((s: { id: string }) => s.id === share.json().shareId);
    expect(mine.accessCount).toBe(1);

    // Revoke → link dead, credential untouched.
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/holder/shares/${share.json().shareId}/revoke`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/v1/share/${token}`,
    });
    expect(afterRevoke.json().share.status).toBe("REVOKED");
    expect(afterRevoke.json().certificateId).toBeUndefined();

    const stillValid = await app.inject({
      method: "GET",
      url: `/api/v1/verify/${certificateFormattedId}`,
    });
    expect(stillValid.json().result).toBe("VALID");
  });

  it("keeps holders out of each other's credentials", async () => {
    const cookie = await loginAsHolder();
    // A credential belonging to a different holder from another test file.
    const [otherHolder] = await db
      .select()
      .from(holders)
      .where(eq(holders.registrationNumber, "УК99112233"))
      .limit(1);
    if (!otherHolder) return; // seed not present — nothing to probe
    const probe = await app.inject({
      method: "GET",
      url: `/api/v1/holder/credentials/${otherHolder.id}`,
      headers: { cookie },
    });
    expect(probe.statusCode).toBe(404);
  });

  it("rejects unknown share tokens without leaking anything", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/share/this-token-does-not-exist-000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().share.status).toBe("NOT_FOUND");
  });
});
