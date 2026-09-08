import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCertificateId, Role } from "@diplommn/shared";
import {
  createTestContext,
  makeInstitutionAndType,
  makeUser,
  sessionCookieFor,
  uniqueRegNum,
  type TestContext,
} from "./helpers.js";

describe("public verification (integration)", () => {
  let ctx: TestContext;
  let certificateId: string;
  let operatorHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let credentialId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const { institutionId, credentialTypeId } = await makeInstitutionAndType(ctx.db);
    const operator = await makeUser(ctx.db, [{ role: Role.Operator }]);
    const approver = await makeUser(ctx.db, [{ role: Role.Approver }]);
    operatorHeaders = await sessionCookieFor(ctx.db, operator.id);
    approverHeaders = await sessionCookieFor(ctx.db, approver.id);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: operatorHeaders,
      payload: {
        credentialTypeId,
        institutionId,
        holder: {
          lastName: "Батсүх",
          firstName: "Энхжин",
          registrationNumber: uniqueRegNum(),
        },
        credentialNumber: "V-2026-042",
        claims: {
          program: "Эдийн засаг",
          degree: "Бакалавр",
          awardedDate: "2026-06-20",
          gpa: "3.8", // internal claim — must NOT appear publicly
        },
      },
    });
    credentialId = created.json().id as string;
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/submit`,
      headers: operatorHeaders,
    });
    const approved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credentialId}/approve`,
      headers: approverHeaders,
    });
    certificateId = approved.json().certificateId as string;
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("rejects malformed IDs with format guidance (no lookup)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/verify/too-short",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.details.expectedFormat).toBeDefined();
  });

  it("returns NOT_FOUND for a well-formed unknown ID — never 'invalid'", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/verify/00000000000000000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("NOT_FOUND");
    expect(res.json().credential).toBeUndefined();
  });

  it("verifies an issued credential with masked holder name and whitelisted claims", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/verify/${formatCertificateId(certificateId)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBe("VALID");
    expect(body.credential.holderName).toBe("Б.Энхжин");
    expect(body.credential.publicClaims).toEqual({
      program: "Эдийн засаг",
      degree: "Бакалавр",
      awardedDate: "2026-06-20",
    });
    // Non-whitelisted internal claims never leak.
    expect(JSON.stringify(body)).not.toContain("3.8");
    expect(body.checks[0].status).toBe("PASSED");
  });

  it("accepts lowercase / unformatted / confusable input for the same ID", async () => {
    const sloppy = certificateId.toLowerCase().replace(/0/g, "o");
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/verify/${sloppy}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("VALID");
  });

  it("reports REVOKED after a dual-controlled revocation", async () => {
    const admin1 = await makeUser(ctx.db, [{ role: Role.LifecycleAdmin }]);
    const admin2 = await makeUser(ctx.db, [{ role: Role.LifecycleAdmin }]);
    const h1 = await sessionCookieFor(ctx.db, admin1.id);
    const h2 = await sessionCookieFor(ctx.db, admin2.id);

    const c = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/lifecycle-cases",
      headers: h1,
      payload: {
        credentialId,
        caseType: "REVOKE",
        reasonCode: "FRAUD",
        reasonDetail: "Шалгалтын дүнгийн зөрчил илэрсэн тул хүчингүй болгов.",
      },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/lifecycle-cases/${c.json().id}/approve`,
      headers: h2,
      payload: {},
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/verify/${certificateId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("REVOKED");
    // Revoked still shows what the credential was — with the same minimal facts.
    expect(res.json().credential.holderName).toBe("Б.Энхжин");
  });
});
