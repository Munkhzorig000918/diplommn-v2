import { describe, expect, it } from "vitest";
import { canTransition, CredentialLifecycle } from "../src/status.js";

describe("lifecycle transitions", () => {
  it("allows the happy path draft → submitted → approved → issued", () => {
    expect(canTransition("DRAFT", "PENDING_APPROVAL")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "ISSUED")).toBe(true);
  });

  it("allows return/resubmit and rejection", () => {
    expect(canTransition("PENDING_APPROVAL", "RETURNED")).toBe(true);
    expect(canTransition("RETURNED", "PENDING_APPROVAL")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "REJECTED")).toBe(true);
  });

  it("routes revocation through REVOCATION_PENDING", () => {
    expect(canTransition("ISSUED", "REVOCATION_PENDING")).toBe(true);
    expect(canTransition("REVOCATION_PENDING", "REVOKED")).toBe(true);
    expect(canTransition("ISSUED", "REVOKED")).toBe(false);
  });

  it("never allows editing/reviving terminal states", () => {
    for (const terminal of ["REJECTED", "REVOKED", "SUPERSEDED", "CANCELLED"] as const) {
      for (const target of Object.values(CredentialLifecycle)) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("never allows skipping approval", () => {
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("DRAFT", "ISSUED")).toBe(false);
    expect(canTransition("PENDING_APPROVAL", "ISSUED")).toBe(false);
  });
});
