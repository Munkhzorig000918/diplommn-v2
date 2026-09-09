/**
 * HEMIS HTTP client. Behavior mirrors the proven v1 read path (bearer
 * endpoint first, per-institution Basic endpoint as fallback, envelope
 * normalization from hash-sync.py) with the v1 defects fixed: bounded
 * timeouts, no unbounded retry storms (retry policy belongs to the caller),
 * credentials from configuration only (v1 leaked live secrets in source —
 * those accounts must be rotated, never reused).
 */
import type {
  HemisAttestation,
  HemisDiplomaRecord,
  HemisFetchResult,
} from "./types.js";

export interface HemisClientConfig {
  /** e.g. https://hub.esis.edu.mn */
  baseUrl: string;
  /** Long-lived HEMIS service JWT for /svc/hemis/api/diploma. */
  bearerToken?: string;
  /** base64(user:pass) per-institution account for /svc/api/dsolution/diplom. */
  basicAuth?: string;
  /** Request timeout; v1 had none and blocked threads on slow HEMIS. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * D1 attestation hook (architecture §12). Called with the raw Response and
   * parsed body once HEMIS ships HMAC-signed responses; format is gap #6.
   */
  verifyAttestation?: (
    response: Response,
    body: unknown,
  ) => Promise<HemisAttestation | null>;
}

/** v1 quirk: HEMIS names arrive tab-contaminated; LAST_NAME may be null. */
function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\t", "").trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

type Flat = Record<string, unknown>;

/** Flat /svc/hemis/api/diploma shape → normalized record. */
export function normalizeFlatRecord(raw: Flat): HemisDiplomaRecord {
  return {
    degreeNumber: asString(raw.DEGREE_NUMBER),
    primaryIdentifierNumber: asString(raw.PRIMARY_IDENTIFIER_NUMBER),
    institutionId: asNumber(raw.INSTITUTION_ID),
    institutionName: asString(raw.INSTITUTION_NAME),
    educationLevelName: asString(raw.EDUCATION_LEVEL_NAME),
    educationFieldCode: asString(raw.EDUCATION_FIELD_CODE),
    educationFieldName: asString(raw.EDUCATION_FIELD_NAME),
    totalGpa: asNumber(raw.TOTAL_GPA),
    lastName: cleanName(raw.LAST_NAME),
    firstName: cleanName(raw.FIRST_NAME),
    conferYearName: asString(raw.CONFER_YEAR_NAME),
  };
}

/**
 * Envelope /svc/api/dsolution/diplom item → normalized record, applying the
 * hash-sync.py rules: TOTAL_GPA arrives as a string here, and CONFER_YEAR
 * (e.g. 2023) becomes the "2022-2023 хичээлийн жил" label.
 */
export function normalizeEnvelopeItem(raw: Flat): HemisDiplomaRecord {
  const conferYear = asNumber(raw.CONFER_YEAR);
  return {
    ...normalizeFlatRecord(raw),
    conferYearName: conferYear
      ? `${conferYear - 1}-${conferYear} хичээлийн жил`
      : asString(raw.CONFER_YEAR_NAME),
  };
}

export class HemisClient {
  constructor(private readonly config: HemisClientConfig) {
    if (!config.bearerToken && !config.basicAuth) {
      throw new Error("HemisClient needs bearerToken and/or basicAuth");
    }
  }

  async fetchDiploma(degreeNumber: string): Promise<HemisFetchResult> {
    const fetchedAt = new Date().toISOString();
    const errors: string[] = [];

    if (this.config.bearerToken) {
      const primary = await this.tryEndpoint(
        `/svc/hemis/api/diploma/${encodeURIComponent(degreeNumber)}`,
        { Authorization: `Bearer ${this.config.bearerToken}` },
        fetchedAt,
        (body, response) => this.interpretFlat(body, response, fetchedAt),
      );
      if (primary) return primary;
      errors.push("hemis endpoint failed");
    }

    if (this.config.basicAuth) {
      const fallback = await this.tryEndpoint(
        `/svc/api/dsolution/diplom/${encodeURIComponent(degreeNumber)}`,
        { Authorization: `Basic ${this.config.basicAuth}` },
        fetchedAt,
        (body, response) => this.interpretEnvelope(body, response, fetchedAt),
      );
      if (fallback) return fallback;
      errors.push("dsolution endpoint failed");
    }

    return {
      status: "unavailable",
      error: errors.join("; ") || "no endpoint configured",
      fetchedAt,
    };
  }

  private async tryEndpoint(
    path: string,
    headers: Record<string, string>,
    fetchedAt: string,
    interpret: (
      body: unknown,
      response: Response,
    ) => Promise<HemisFetchResult | null>,
  ): Promise<HemisFetchResult | null> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    try {
      const response = await fetchImpl(`${this.config.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return await interpret(body, response);
    } catch {
      return null;
    }
  }

  private async interpretFlat(
    body: unknown,
    response: Response,
    fetchedAt: string,
  ): Promise<HemisFetchResult | null> {
    if (typeof body !== "object" || body === null) return null;
    const flat = body as Flat;
    if (!flat.DEGREE_NUMBER) {
      return { status: "not-found", raw: body, endpoint: "hemis", fetchedAt };
    }
    return {
      status: "found",
      record: normalizeFlatRecord(flat),
      raw: body,
      endpoint: "hemis",
      fetchedAt,
      attestation:
        (await this.config.verifyAttestation?.(response, body)) ?? null,
    };
  }

  private async interpretEnvelope(
    body: unknown,
    response: Response,
    fetchedAt: string,
  ): Promise<HemisFetchResult | null> {
    if (typeof body !== "object" || body === null) return null;
    const envelope = body as {
      SUCCESS_CODE?: unknown;
      RESULT?: unknown;
    };
    if (asNumber(envelope.SUCCESS_CODE) !== 200) return null;
    const results = Array.isArray(envelope.RESULT) ? envelope.RESULT : [];
    if (results.length === 0) {
      return { status: "not-found", raw: body, endpoint: "dsolution", fetchedAt };
    }
    // Multi-element RESULT: v1 tooling reads the LAST element (most recent
    // record, per hash-sync.py); the count is preserved in `raw` as evidence.
    const item = results[results.length - 1] as Flat;
    return {
      status: "found",
      record: normalizeEnvelopeItem(item),
      raw: body,
      endpoint: "dsolution",
      fetchedAt,
      attestation:
        (await this.config.verifyAttestation?.(response, body)) ?? null,
    };
  }
}

export function hemisClientConfigFromEnv(
  env: NodeJS.ProcessEnv,
): HemisClientConfig | null {
  const baseUrl = env.HEMIS_BASE_URL;
  if (!baseUrl) return null;
  const bearerToken = env.HEMIS_BEARER_TOKEN;
  const basicAuth = env.HEMIS_BASIC_AUTH;
  if (!bearerToken && !basicAuth) return null;
  return {
    baseUrl,
    ...(bearerToken ? { bearerToken } : {}),
    ...(basicAuth ? { basicAuth } : {}),
    ...(env.HEMIS_TIMEOUT_MS ? { timeoutMs: Number(env.HEMIS_TIMEOUT_MS) } : {}),
  };
}
