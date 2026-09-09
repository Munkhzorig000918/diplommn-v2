/**
 * HEMIS adapter types. The upstream contract was reverse-engineered from the
 * v1 production integration (diplom-springboot HemisService/HemisApiService,
 * scripts/python/hash-sync.py) against https://hub.esis.edu.mn:
 *
 *  - GET /svc/hemis/api/diploma/{degreeNumber}     (Bearer service token)
 *    → flat SCREAMING_SNAKE object with 11 fields
 *  - GET /svc/api/dsolution/diplom/{degreeNumber}  (Basic, per-institution)
 *    → { SUCCESS_CODE, RESPONSE_MESSAGE, RESULT: [...] } envelope
 *
 * The two shapes are normalized into one HemisDiplomaRecord. Raw payloads
 * are preserved verbatim for the approval-evidence panel and audit trail.
 */

/** Normalized authoritative diploma record (camelCase view of both shapes). */
export interface HemisDiplomaRecord {
  degreeNumber: string;
  /** Holder registration number (упр. дугаар); compare case-insensitively. */
  primaryIdentifierNumber: string;
  institutionId: number | null;
  institutionName: string;
  educationLevelName: string;
  /** String — leading zeros are significant ("041302"). */
  educationFieldCode: string;
  educationFieldName: string;
  totalGpa: number | null;
  /** HEMIS LAST_NAME is the surname/patronymic; may be null upstream. */
  lastName: string;
  firstName: string;
  /** Academic-year label, e.g. "2022-2023 хичээлийн жил" (not a date). */
  conferYearName: string;
}

/**
 * D1 HMAC attestation (architecture §12, decision D1). HEMIS did NOT provide
 * this in v1 — no HMAC/mTLS existed. The verifier is injectable so the
 * adapter is ready the day HEMIS ships it; canonicalization/freshness rules
 * are open gap #6 and must come from the HEMIS contract, not be invented.
 */
export interface HemisAttestation {
  verified: boolean;
  timestamp: string | null;
  nonce: string | null;
  detail?: string;
}

export type HemisEndpoint = "hemis" | "dsolution";

export type HemisFetchResult =
  | {
      status: "found";
      record: HemisDiplomaRecord;
      /** Verbatim upstream payload (evidence; never mutated). */
      raw: unknown;
      endpoint: HemisEndpoint;
      fetchedAt: string;
      attestation: HemisAttestation | null;
    }
  | { status: "not-found"; raw: unknown; endpoint: HemisEndpoint; fetchedAt: string }
  | { status: "unavailable"; error: string; fetchedAt: string };
