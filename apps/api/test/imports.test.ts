import { afterAll, beforeAll, describe, expect, it } from "vitest";
import FormData from "form-data";
import { Role } from "@diplommn/shared";
import {
  createTestContext,
  makeInstitutionAndType,
  makeUser,
  sessionCookieFor,
  uniqueRegNum,
  type TestContext,
} from "./helpers.js";

function csvUpload(
  csv: string,
  institutionId: string,
  credentialTypeId: string,
): { payload: FormData; headers: Record<string, string> } {
  const form = new FormData();
  form.append("file", Buffer.from(csv, "utf8"), {
    filename: "batch.csv",
    contentType: "text/csv",
  });
  form.append("institutionId", institutionId);
  form.append("credentialTypeId", credentialTypeId);
  return { payload: form, headers: form.getHeaders() };
}

const HEADER =
  "lastName,firstName,registrationNumber,email,credentialNumber,program,degree,awardedDate";

describe("CSV imports (integration)", () => {
  let ctx: TestContext;
  let institutionId: string;
  let credentialTypeId: string;
  let operatorHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;

  beforeAll(async () => {
    ctx = await createTestContext();
    ({ institutionId, credentialTypeId } = await makeInstitutionAndType(ctx.db));
    const operator = await makeUser(ctx.db, [{ role: Role.Operator }]);
    const approver = await makeUser(ctx.db, [{ role: Role.Approver }]);
    operatorHeaders = await sessionCookieFor(ctx.db, operator.id);
    approverHeaders = await sessionCookieFor(ctx.db, approver.id);
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("uploads a mixed batch, reports per-row errors, submits only valid rows", async () => {
    const good1 = uniqueRegNum();
    const good2 = uniqueRegNum();
    const csv = [
      HEADER,
      `Дорж,Сараа,${good1},saraa@example.mn,I-2026-001,Математик,Бакалавр,2026-06-15`,
      `,Билгүүн,${uniqueRegNum()},,I-2026-002,Физик,Бакалавр,2026-06-15`, // missing lastName
      `Бат,Тэмүүлэн,${good2},,I-2026-003,Хими,Бакалавр,2026-06-15`,
      `Бат,Тэмүүлэн,${good2},,I-2026-003,Хими,Бакалавр,2026-06-15`, // duplicate
      `Наран,Ирээдүй,${uniqueRegNum()},,I-2026-004,Биологи,Бакалавр,15/06/2026`, // bad date
    ].join("\n");

    const { payload, headers } = csvUpload(csv, institutionId, credentialTypeId);
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...operatorHeaders, ...headers },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    const batch = upload.json();
    expect(batch.totalRows).toBe(5);
    expect(batch.validRows).toBe(2);
    expect(batch.errorRows).toBe(3);

    // Error rows are inspectable and downloadable.
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/imports/${batch.id}?errorsOnly=true`,
      headers: operatorHeaders,
    });
    expect(detail.json().rows).toHaveLength(3);

    const errCsv = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/imports/${batch.id}/errors.csv`,
      headers: operatorHeaders,
    });
    expect(errCsv.statusCode).toBe(200);
    expect(errCsv.headers["content-type"]).toContain("text/csv");
    expect(errCsv.body).toContain("lastName is required");
    expect(errCsv.body).toContain("duplicate of row");
    expect(errCsv.body).toContain("awardedDate must be YYYY-MM-DD");

    // Submit: only the 2 valid rows enter the approval workflow.
    const submit = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/submit`,
      headers: operatorHeaders,
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().submitted).toBe(2);
    expect(submit.json().failed).toBe(0);
    expect(submit.json().status).toBe("PARTIALLY_COMPLETED");

    // Rows link to credentials now pending approval.
    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/imports/${batch.id}`,
      headers: operatorHeaders,
    });
    const submittedRows = after
      .json()
      .rows.filter((r: { status: string }) => r.status === "SUBMITTED");
    expect(submittedRows).toHaveLength(2);
    expect(submittedRows[0].credentialId).toBeTruthy();

    // Approve one imported credential end-to-end → publicly verifiable.
    const approve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/credentials/${submittedRows[0].credentialId}/approve`,
      headers: approverHeaders,
    });
    expect(approve.statusCode).toBe(200);
    const verify = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/verify/${approve.json().certificateId}`,
    });
    expect(verify.json().result).toBe("VALID");

    // A batch cannot be submitted twice.
    const resubmit = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/submit`,
      headers: operatorHeaders,
    });
    expect(resubmit.statusCode).toBe(409);
  });

  it("rejects a CSV with missing required columns", async () => {
    const { payload, headers } = csvUpload(
      "lastName,firstName\nа,б",
      institutionId,
      credentialTypeId,
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...operatorHeaders, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.missing).toContain("registrationNumber");
  });

  it("requires operator role and institution scope", async () => {
    const outsider = await makeUser(ctx.db, [{ role: Role.Auditor }]);
    const outsiderHeaders = await sessionCookieFor(ctx.db, outsider.id);
    const { payload, headers } = csvUpload(
      `${HEADER}\nа,б,${uniqueRegNum()},,X-1,Х,Б,2026-01-01`,
      institutionId,
      credentialTypeId,
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...outsiderHeaders, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves the CSV template to staff", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/imports/template.csv",
      headers: operatorHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("registrationNumber");
  });
});
