import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import {
  createTestContext,
  makeUser,
  TEST_PASSWORD,
  type TestContext,
} from "./helpers.js";
import { Role } from "@diplommn/shared";

describe("auth (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("rejects wrong password with a generic message", async () => {
    const user = await makeUser(ctx.db, [{ role: Role.Operator }]);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: "wrong-password-1234" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Invalid credentials");
  });

  it("rejects unknown emails with the same generic message (no enumeration)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@test.diplom.mn", password: "whatever-123456" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Invalid credentials");
  });

  it("requires TOTP when enrolled, then logs in and serves /me", async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const user = await makeUser(ctx.db, [{ role: Role.Operator }], {
      totpSecret: secret.base32,
    });

    const withoutTotp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: TEST_PASSWORD },
    });
    expect(withoutTotp.statusCode).toBe(401);
    expect(withoutTotp.json().error.details?.totpRequired).toBe(true);

    const totp = new OTPAuth.TOTP({ secret });
    const withTotp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: user.email,
        password: TEST_PASSWORD,
        totpCode: totp.generate(),
      },
    });
    expect(withTotp.statusCode).toBe(200);
    const setCookie = withTotp.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookie = String(setCookie).split(";")[0]!;

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(user.email);

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const meAfter = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("rejects unauthenticated access to staff APIs", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/credentials" });
    expect(res.statusCode).toBe(401);
  });
});
