/**
 * PII display helpers. Disclosure of holder names on public verification is an
 * open policy decision (architecture gap #19) — the default is the masked
 * Mongolian convention: surname initial + given name ("Д.Батболд").
 */
export type HolderNameDisclosure = "masked" | "full" | "none";

export function maskHolderName(
  lastName: string,
  firstName: string,
  disclosure: HolderNameDisclosure,
): string | null {
  switch (disclosure) {
    case "none":
      return null;
    case "full":
      return `${lastName} ${firstName}`.trim();
    case "masked": {
      const initial = lastName.trim().charAt(0);
      return initial ? `${initial}.${firstName.trim()}` : firstName.trim();
    }
  }
}

/** Registration numbers are never shown in full outside break-glass flows. */
export function maskRegistrationNumber(regNum: string): string {
  if (regNum.length <= 4) return "*".repeat(regNum.length);
  return `${regNum.slice(0, 2)}${"*".repeat(regNum.length - 4)}${regNum.slice(-2)}`;
}
