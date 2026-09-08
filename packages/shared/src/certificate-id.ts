import { randomBytes } from "node:crypto";

/**
 * Certificate IDs (FR-V05): cryptographically random, non-sequential public
 * identifiers. 20 Crockford-base32 chars = 100 bits of entropy — printed on
 * documents and QR codes, expected to survive decades, safe against
 * enumeration together with exact-match lookup + rate limiting.
 *
 * Crockford base32 alphabet excludes I, L, O, U to avoid transcription errors.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CERTIFICATE_ID_LENGTH = 20;

export function generateCertificateId(): string {
  // 5 bits per char; use rejection-free modulo over a wide random value per char.
  // randomBytes(20) gives 160 bits; take 5 bits per byte via mod 32 — uniform
  // because 256 % 32 === 0.
  const bytes = randomBytes(CERTIFICATE_ID_LENGTH);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

/** Display form: 4 groups of 5 chars, e.g. `7Q2MD-9K3XF-08TRV-ZC51H`. */
export function formatCertificateId(id: string): string {
  return id.match(/.{1,5}/g)?.join("-") ?? id;
}

/**
 * Normalize user input: uppercase, strip separators/whitespace, map the
 * Crockford confusables (I/L → 1, O → 0). Returns null when the result is not
 * a plausible certificate ID — callers must not fall back to partial matching.
 */
export function normalizeCertificateId(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-_.]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== CERTIFICATE_ID_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
