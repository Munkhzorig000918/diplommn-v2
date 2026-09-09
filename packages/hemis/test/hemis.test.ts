import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_KEYS,
  HemisClient,
  buildValidationEvidence,
  matchAgainstHemis,
  normalizeEnvelopeItem,
  toSourceValidationStatus,
} from "../src/index.js";

/** Real production sample preserved in v1 chaincode comments. */
const FLAT_SAMPLE = {
  DEGREE_NUMBER: "D202300392",
  PRIMARY_IDENTIFIER_NUMBER: "ей01292215",
  INSTITUTION_ID: 35623,
  INSTITUTION_NAME: "ШУТИС /Шинжлэх ухаан технологийн их сургууль/",
  EDUCATION_LEVEL_NAME: "Бакалаврын боловсрол",
  EDUCATION_FIELD_CODE: "041302",
  EDUCATION_FIELD_NAME: "Менежмент",
  TOTAL_GPA: 2.6,
  LAST_NAME: "Батбаяр",
  FIRST_NAME: "\tМөнхсайхан",
  CONFER_YEAR_NAME: "2022-2023 хичээлийн жил",
};

const ENVELOPE_SAMPLE = {
  SUCCESS_CODE: 200,
  RESPONSE_MESSAGE: "OK",
  RESULT: [
    {
      ...FLAT_SAMPLE,
      FIRST_NAME: "Хуучин",
      CONFER_YEAR: 2020,
      TOTAL_GPA: "3.10",
    },
    {
      ...FLAT_SAMPLE,
      CONFER_YEAR: 2023,
      TOTAL_GPA: "2.60",
      CONFER_YEAR_NAME: undefined,
    },
  ],
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init?: unknown) =>
    handler(String(input), init as RequestInit)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HemisClient", () => {
  it("uses the bearer endpoint and normalizes the flat shape", async () => {
    const seen: string[] = [];
    const client = new HemisClient({
      baseUrl: "https://hemis.test",
      bearerToken: "jwt-token",
      basicAuth: "unused",
      fetchImpl: fakeFetch((url, init) => {
        seen.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer jwt-token",
        );
        return jsonResponse(FLAT_SAMPLE);
      }),
    });

    const result = await client.fetchDiploma("D202300392");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(seen).toEqual([
      "https://hemis.test/svc/hemis/api/diploma/D202300392",
    ]);
    expect(result.endpoint).toBe("hemis");
    // Tab contamination stripped (v1 quirk).
    expect(result.record.firstName).toBe("Мөнхсайхан");
    expect(result.record.educationFieldCode).toBe("041302");
    expect(result.record.totalGpa).toBe(2.6);
    expect(result.attestation).toBeNull();
    expect(result.raw).toEqual(FLAT_SAMPLE);
  });

  it("falls back to the Basic endpoint and normalizes the envelope", async () => {
    const client = new HemisClient({
      baseUrl: "https://hemis.test",
      bearerToken: "expired",
      basicAuth: "bXVzdDpzZWNyZXQ=",
      fetchImpl: fakeFetch((url, init) => {
        if (url.includes("/svc/hemis/api/diploma/")) {
          return jsonResponse({ Message: "unauthorized" }, 401);
        }
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Basic bXVzdDpzZWNyZXQ=",
        );
        return jsonResponse(ENVELOPE_SAMPLE);
      }),
    });

    const result = await client.fetchDiploma("D202300392");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.endpoint).toBe("dsolution");
    // Last RESULT element wins (hash-sync.py rule)…
    expect(result.record.totalGpa).toBe(2.6);
    // …string GPA parsed, CONFER_YEAR → academic-year label.
    expect(result.record.conferYearName).toBe("2022-2023 хичээлийн жил");
  });

  it("reports not-found on an empty RESULT envelope", async () => {
    const client = new HemisClient({
      baseUrl: "https://hemis.test",
      basicAuth: "abc",
      fetchImpl: fakeFetch(() =>
        jsonResponse({ SUCCESS_CODE: 200, RESULT: [] }),
      ),
    });
    const result = await client.fetchDiploma("D000");
    expect(result.status).toBe("not-found");
  });

  it("reports unavailable when every endpoint fails", async () => {
    const client = new HemisClient({
      baseUrl: "https://hemis.test",
      bearerToken: "t",
      basicAuth: "b",
      fetchImpl: fakeFetch(() => {
        throw new Error("connection refused");
      }),
    });
    const result = await client.fetchDiploma("D000");
    expect(result.status).toBe("unavailable");
  });

  it("runs the injected D1 attestation verifier", async () => {
    const client = new HemisClient({
      baseUrl: "https://hemis.test",
      bearerToken: "t",
      fetchImpl: fakeFetch(() => jsonResponse(FLAT_SAMPLE)),
      verifyAttestation: async () => ({
        verified: false,
        timestamp: "2026-09-09T00:00:00Z",
        nonce: "n1",
        detail: "signature mismatch",
      }),
    });
    const result = await client.fetchDiploma("D202300392");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.attestation?.verified).toBe(false);
    expect(toSourceValidationStatus(result, { matched: true, keysChecked: [], diffs: [] })).toBe(
      "ATTESTATION_INVALID",
    );
  });
});

describe("matchAgainstHemis", () => {
  const record = normalizeEnvelopeItem({
    ...FLAT_SAMPLE,
    CONFER_YEAR: 2023,
  });

  it("matches on the three v1 keys with normalization", () => {
    const result = matchAgainstHemis(record, {
      degreeNumber: "D202300392",
      primaryIdentifierNumber: "ЕЙ01292215", // case-insensitive
      firstName: "Мөнхсайхан\t",
    });
    expect(result.matched).toBe(true);
    expect(result.keysChecked).toEqual([...DEFAULT_MATCH_KEYS]);
  });

  it("reports per-field diffs on mismatch", () => {
    const result = matchAgainstHemis(record, {
      degreeNumber: "D202300392",
      primaryIdentifierNumber: "ей01292215",
      firstName: "Өөр Нэр",
    });
    expect(result.matched).toBe(false);
    expect(result.diffs).toEqual([
      { key: "firstName", submitted: "Өөр Нэр", hemis: "Мөнхсайхан" },
    ]);
  });

  it("normalizes GPA to two decimals when GPA is checked", () => {
    const result = matchAgainstHemis(
      record,
      { totalGpa: "2.6" },
      ["totalGpa"],
    );
    expect(result.matched).toBe(true);
  });
});

describe("status mapping + evidence", () => {
  it("maps outcomes to the source-validation dimension", () => {
    const unavailable = {
      status: "unavailable",
      error: "x",
      fetchedAt: "t",
    } as const;
    expect(toSourceValidationStatus(unavailable, null)).toBe("UNAVAILABLE");

    const notFound = {
      status: "not-found",
      raw: {},
      endpoint: "hemis",
      fetchedAt: "t",
    } as const;
    // Default-block (open decision #9): absent record never silently passes.
    expect(toSourceValidationStatus(notFound, null)).toBe("MISMATCH");
  });

  it("builds a jsonb-safe evidence blob with the raw payload", () => {
    const fetchResult = {
      status: "found",
      record: normalizeEnvelopeItem({ ...FLAT_SAMPLE, CONFER_YEAR: 2023 }),
      raw: FLAT_SAMPLE,
      endpoint: "hemis",
      fetchedAt: "2026-09-09T00:00:00Z",
      attestation: null,
    } as const;
    const match = matchAgainstHemis(fetchResult.record, {
      degreeNumber: "D202300392",
      primaryIdentifierNumber: "ей01292215",
      firstName: "Мөнхсайхан",
    });
    const evidence = buildValidationEvidence("D202300392", fetchResult, match);
    expect(evidence.source).toBe("HEMIS");
    expect(evidence.raw).toEqual(FLAT_SAMPLE);
    expect((evidence.match as { matched: boolean }).matched).toBe(true);
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });
});
