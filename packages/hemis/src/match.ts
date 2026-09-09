/**
 * Claims ↔ HEMIS reconciliation. v1 matched on exactly three keys
 * (DEGREE_NUMBER, PRIMARY_IDENTIFIER_NUMBER, FIRST_NAME) and blocked the row
 * on any mismatch; v2 keeps that default but reports per-field diffs for the
 * approver's evidence panel (design §HEMIS match panel). Mismatch blocks
 * issuance by default; any exception path is open decision #9.
 */
import type { HemisDiplomaRecord, HemisFetchResult } from "./types.js";

export const DEFAULT_MATCH_KEYS = [
  "degreeNumber",
  "primaryIdentifierNumber",
  "firstName",
] as const satisfies readonly (keyof HemisDiplomaRecord)[];

export type MatchKey = keyof HemisDiplomaRecord;

export interface HemisFieldDiff {
  key: MatchKey;
  submitted: string;
  hemis: string;
}

export interface HemisMatchResult {
  matched: boolean;
  keysChecked: MatchKey[];
  diffs: HemisFieldDiff[];
}

/** v1 normalization: identifiers case-insensitive, names tab/space-trimmed, GPA to 2dp. */
function normalize(key: MatchKey, value: unknown): string {
  if (value == null) return "";
  const text = String(value).replaceAll("\t", "").trim();
  switch (key) {
    case "primaryIdentifierNumber":
      return text.toLowerCase();
    case "totalGpa": {
      const parsed = Number.parseFloat(text);
      return Number.isFinite(parsed) ? parsed.toFixed(2) : text;
    }
    default:
      return text;
  }
}

export function matchAgainstHemis(
  record: HemisDiplomaRecord,
  submitted: Partial<Record<MatchKey, unknown>>,
  keys: readonly MatchKey[] = DEFAULT_MATCH_KEYS,
): HemisMatchResult {
  const diffs: HemisFieldDiff[] = [];
  for (const key of keys) {
    const submittedValue = normalize(key, submitted[key]);
    const hemisValue = normalize(key, record[key]);
    if (submittedValue !== hemisValue) {
      diffs.push({ key, submitted: submittedValue, hemis: hemisValue });
    }
  }
  return { matched: diffs.length === 0, keysChecked: [...keys], diffs };
}

/**
 * Map a fetch+match outcome to the source-validation status dimension.
 * "No HEMIS record" defaults to MISMATCH (default-block per open decision
 * #9 — an absent authoritative record must not silently pass).
 */
export function toSourceValidationStatus(
  fetchResult: HemisFetchResult,
  matchResult: HemisMatchResult | null,
):
  | "MATCHED"
  | "MISMATCH"
  | "UNAVAILABLE"
  | "ATTESTATION_INVALID" {
  if (fetchResult.status === "unavailable") return "UNAVAILABLE";
  if (fetchResult.status === "not-found") return "MISMATCH";
  if (fetchResult.attestation && !fetchResult.attestation.verified) {
    return "ATTESTATION_INVALID";
  }
  return matchResult?.matched ? "MATCHED" : "MISMATCH";
}

/** Evidence blob persisted with the source-validation event (jsonb-safe). */
export function buildValidationEvidence(
  degreeNumber: string,
  fetchResult: HemisFetchResult,
  matchResult: HemisMatchResult | null,
): Record<string, unknown> {
  return {
    source: "HEMIS",
    degreeNumber,
    fetchedAt: fetchResult.fetchedAt,
    outcome: fetchResult.status,
    ...(fetchResult.status !== "unavailable"
      ? { endpoint: fetchResult.endpoint, raw: fetchResult.raw }
      : { error: fetchResult.error }),
    ...(fetchResult.status === "found"
      ? { record: fetchResult.record, attestation: fetchResult.attestation }
      : {}),
    ...(matchResult ? { match: matchResult } : {}),
  };
}
