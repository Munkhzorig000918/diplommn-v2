import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_ID_LENGTH,
  formatCertificateId,
  generateCertificateId,
  normalizeCertificateId,
} from "../src/certificate-id.js";

describe("certificate-id", () => {
  it("generates IDs of the right length and alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateCertificateId();
      expect(id).toHaveLength(CERTIFICATE_ID_LENGTH);
      expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    }
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateCertificateId));
    expect(ids.size).toBe(1000);
  });

  it("formats into 4 groups of 5", () => {
    const id = "7Q2MD9K3XF08TRVZC51H";
    expect(formatCertificateId(id)).toBe("7Q2MD-9K3XF-08TRV-ZC51H");
  });

  it("normalizes dashes, case, whitespace and confusables", () => {
    expect(normalizeCertificateId("7q2md-9k3xf-08trv-zc51h")).toBe(
      "7Q2MD9K3XF08TRVZC51H",
    );
    // I/L → 1, O → 0
    expect(normalizeCertificateId("7Q2MD9K3XFO8TRVZC5lH")).toBe(
      "7Q2MD9K3XF08TRVZC51H",
    );
    expect(normalizeCertificateId(" 7Q2MD 9K3XF 08TRV ZC51H ")).toBe(
      "7Q2MD9K3XF08TRVZC51H",
    );
  });

  it("rejects wrong length and invalid characters — no partial matching", () => {
    expect(normalizeCertificateId("7Q2MD")).toBeNull();
    expect(normalizeCertificateId("7Q2MD9K3XF08TRVZC51HX")).toBeNull();
    expect(normalizeCertificateId("7Q2MD9K3XF08TRVZC51U")).toBeNull(); // U excluded
    expect(normalizeCertificateId("")).toBeNull();
  });

  it("round-trips generated IDs through format + normalize", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateCertificateId();
      expect(normalizeCertificateId(formatCertificateId(id))).toBe(id);
    }
  });
});
