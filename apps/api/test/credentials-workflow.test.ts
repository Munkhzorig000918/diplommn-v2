import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { credentials } from "@diplommn/db";
import { Role } from "@diplommn/shared";
import {
  createTestContext,
  makeInstitutionAndType,
  makeUser,
  sessionCookieFor,
  uniqueRegNum,
  type TestContext,
} from "./helpers.js";

describe("credential workflow (integration)", () => {
  let ctx: TestContext;
  let institutionId: string;
  let credentialTypeId: string;
  let operator: { id: string };
  let approver: { id: string };
  let operatorHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestContext();
    ({ institutionId, credentialTypeId } = await makeInstitutionAndType(ctx.db));
    operator = await makeUser(ctx.db, [{ role: Role.Operator }]);
    approver = await makeUser(ctx.db, [{ role: Role.Approver }]);
    operatorHeaders = await sessionCookieFor(ctx.db, operator.id);
    approverHeaders = await sessionCookieFor(ctx.db, approver.id);
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function createDraft(): Promise<string> {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: operatorHeaders,
      payload: {
        credentialTypeId,
        institutionId,
        holder: {
          lastName: "Тест",
          firstName: "Оюутан",
          registrationNumber: uniqueRegNum(),
        },
        credentialNumber: "T-2026-001",
        claims: {
          program: "Мэдээллийн технологи",
          degree: "Бакалавр",
          awardedDate: "2026-06-15",
        },
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("runs the full happy path: draft → submit → approve → issued", async () => {
    const id = await createDraft();

    const submit = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    expect(submit.statusCode).toBe(200);

    const approve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/approve`,
      headers: approverHeaders,
    });
    expect(approve.statusCode).toBe(200);
    const { certificateId } = approve.json();
    expect(certificateId).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{20}$/);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/credentials/${id}`,
      headers: operatorHeaders,
    });
    const { credential } = detail.json();
    expect(credential.lifecycleStatus).toBe("ISSUED");
    expect(credential.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(credential.contentHashAlg).toBe("SHA-256");
    // The salt must never cross the API boundary.
    expect(credential.contentSalt).toBeUndefined();
    // Registration number is masked for staff by default.
    expect(credential.holder.registrationNumber).toMatch(/\*/);
  });

  it("forbids self-approval (separation of duties)", async () => {
    const both = await makeUser(ctx.db, [
      { role: Role.Operator },
      { role: Role.Approver },
    ]);
    const bothHeaders = await sessionCookieFor(ctx.db, both.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: bothHeaders,
      payload: {
        credentialTypeId,
        institutionId,
        holder: {
          lastName: "Дав",
          firstName: "Хар",
          registrationNumber: uniqueRegNum(),
        },
        claims: { degree: "Бакалавр" },
      },
    });
    const id = res.json().id as string;
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: bothHeaders,
    });

    const selfApprove = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/approve`,
      headers: bothHeaders,
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error.code).toBe("FORBIDDEN");
  });

  it("blocks approval by users without the approver role", async () => {
    const id = await createDraft();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/approve`,
      headers: operatorHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces the state machine: no submit twice, no editing issued records", async () => {
    const id = await createDraft();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    const resubmit = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    expect(resubmit.statusCode).toBe(409);

    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/approve`,
      headers: approverHeaders,
    });
    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/credentials/${id}`,
      headers: operatorHeaders,
      payload: { claims: { degree: "Магистр" } },
    });
    expect(edit.statusCode).toBe(409);
  });

  it("supports return → edit → resubmit", async () => {
    const id = await createDraft();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    const ret = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/return`,
      headers: approverHeaders,
      payload: { reason: "Хөтөлбөрийн нэр буруу байна" },
    });
    expect(ret.statusCode).toBe(200);

    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/credentials/${id}`,
      headers: operatorHeaders,
      payload: { claims: { program: "Программ хангамж", degree: "Бакалавр" } },
    });
    expect(edit.statusCode).toBe(200);

    const resubmit = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${id}/submit`,
      headers: operatorHeaders,
    });
    expect(resubmit.statusCode).toBe(200);
  });

  it("scopes institution-bound operators to their institution", async () => {
    const other = await makeInstitutionAndType(ctx.db);
    const scopedOperator = await makeUser(ctx.db, [
      { role: Role.Operator, institutionId: other.institutionId },
    ]);
    const scopedHeaders = await sessionCookieFor(ctx.db, scopedOperator.id);

    // May not create for an institution outside their scope.
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: scopedHeaders,
      payload: {
        credentialTypeId,
        institutionId, // NOT their institution
        holder: {
          lastName: "Хэн",
          firstName: "Нэгэн",
          registrationNumber: uniqueRegNum(),
        },
        claims: {},
      },
    });
    expect(res.statusCode).toBe(403);
  });

  describe("revocation via lifecycle case (dual control)", () => {
    let credentialId: string;
    let lifecycleAdmin1Headers: Record<string, string>;
    let lifecycleAdmin2Headers: Record<string, string>;

    beforeAll(async () => {
      const a1 = await makeUser(ctx.db, [{ role: Role.LifecycleAdmin }]);
      const a2 = await makeUser(ctx.db, [{ role: Role.LifecycleAdmin }]);
      lifecycleAdmin1Headers = await sessionCookieFor(ctx.db, a1.id);
      lifecycleAdmin2Headers = await sessionCookieFor(ctx.db, a2.id);

      credentialId = await createDraft();
      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/credentials/${credentialId}/submit`,
        headers: operatorHeaders,
      });
      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/credentials/${credentialId}/approve`,
        headers: approverHeaders,
      });
    });

    it("requester cannot approve their own case; a second admin can", async () => {
      const caseRes = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/lifecycle-cases",
        headers: lifecycleAdmin1Headers,
        payload: {
          credentialId,
          caseType: "REVOKE",
          reasonCode: "DATA_ERROR",
          reasonDetail: "Тухайн диплом андуурч олгогдсон болохыг тогтоов.",
        },
      });
      expect(caseRes.statusCode).toBe(201);
      const caseId = caseRes.json().id as string;

      const selfApprove = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/lifecycle-cases/${caseId}/approve`,
        headers: lifecycleAdmin1Headers,
        payload: {},
      });
      expect(selfApprove.statusCode).toBe(403);

      const approve = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/lifecycle-cases/${caseId}/approve`,
        headers: lifecycleAdmin2Headers,
        payload: { note: "Баталгаажууллаа" },
      });
      expect(approve.statusCode).toBe(200);

      const [row] = await ctx.db
        .select({ status: credentials.lifecycleStatus })
        .from(credentials)
        .where(eq(credentials.id, credentialId));
      expect(row?.status).toBe("REVOKED");
    });
  });
});
