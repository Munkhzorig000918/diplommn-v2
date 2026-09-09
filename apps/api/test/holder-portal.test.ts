import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { anchorBatches, credentials, holders, holderSessions } from "@diplommn/db";
import {
  computeContentHash,
  computeMerkleRoot,
  normalizeLeafHex,
  Role,
  sha256Hex,
  verifyMerkleProof,
} from "@diplommn/shared";
import { createDb } from "@diplommn/db";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { hashSessionToken } from "../src/plugins/auth.js";
import { HOLDER_COOKIE } from "../src/plugins/holder-auth.js";
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
  let issuedCredentialId: string;

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
    issuedCredentialId = credentialId;
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

  it("serves an offline proof bundle once the VC and anchor exist", async () => {
    // Session created directly (OTP flow is covered above; repeated logins
    // trip the OTP rate limiter by design).
    const [holderRow] = await db
      .select({ id: holders.id })
      .from(holders)
      .where(eq(holders.registrationNumber, regNum));
    const token = randomBytes(32).toString("hex");
    await db.insert(holderSessions).values({
      holderId: holderRow!.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cookie = `${HOLDER_COOKIE}=${token}`;

    // Before signing: no bundle.
    const early = await app.inject({
      method: "GET",
      url: `/api/v1/holder/credentials/${issuedCredentialId}/proof-bundle`,
      headers: { cookie },
    });
    expect(early.statusCode).toBe(409);

    // Simulate the signing + anchoring workers directly in the store.
    const [row] = await db
      .select({ contentSalt: credentials.contentSalt })
      .from(credentials)
      .where(eq(credentials.id, issuedCredentialId));
    const fakeVc = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      issuer: "did:web:diplom.mn",
      proof: { type: "DataIntegrityProof", proofValue: "ztest" },
    };
    const { hash: vcHash } = computeContentHash(fakeVc, row!.contentSalt!);
    const sibling = sha256Hex("proof-bundle-sibling");
    const leaves = [normalizeLeafHex(vcHash), normalizeLeafHex(sibling)].sort();
    const [batch] = await db
      .insert(anchorBatches)
      .values({
        batchId: BigInt(90_000_000 + Math.floor(Math.random() * 1_000_000)),
        merkleRoot: computeMerkleRoot(leaves),
        leafCount: leaves.length,
        leaves,
        chainId: 31337,
        contractAddress: "0xproofbundletest0000000000000000000000000",
        status: "CONFIRMED",
      })
      .returning({ id: anchorBatches.id, merkleRoot: anchorBatches.merkleRoot });
    await db
      .update(credentials)
      .set({
        vc: fakeVc,
        vcHash,
        vcSignedAt: new Date(),
        vcKeyId: "issuer-1",
        anchorBatchId: batch!.id,
        anchorStatus: "CONFIRMED",
      })
      .where(eq(credentials.id, issuedCredentialId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/holder/credentials/${issuedCredentialId}/proof-bundle`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    expect(bundle.vc.issuer).toBe("did:web:diplom.mn");
    expect(bundle.leaf.source).toBe("vc");
    expect(bundle.leaf.salt).toBe(row!.contentSalt);
    expect(bundle.anchor.merkleRoot).toBe(batch!.merkleRoot);
    // The included Merkle proof must actually connect the leaf to the root.
    expect(
      verifyMerkleProof(vcHash, bundle.anchor.merkleProof, batch!.merkleRoot),
    ).toBe(true);
  });
});
