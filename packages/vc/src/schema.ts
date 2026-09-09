/**
 * Diploma claim schema 1.0 — the FROZEN content contract of the signed VC.
 *
 * Derived from three evidence sources: the v1 Fabric claims (DiplomaDto),
 * the v1 HEMIS payload (11 fields), and the institution-provided record
 * sample (institutionRegister/school/programName). Deliberately EXCLUDED
 * for privacy (kept off-chain in the platform DB, never in the shareable
 * signed VC): student registration number, GPA, email. System state
 * (tx hashes, anchor status, verification URLs) never enters claims.
 *
 * Changing anything here after launch is a new schemaVersion + reissue —
 * additions land in 1.1+, never silently in 1.0.
 */
import { z } from "zod";

export const DIPLOMA_SCHEMA_VERSION = "1.0";
export const DIPLOMA_SCHEMA_URL =
  "https://diplom.mn/schemas/diploma/1.0.json";
export const DIPLOMA_CREDENTIAL_TYPE = "MongolianDiplomaCredential";

export const DiplomaSubjectSchema = z
  .object({
    /** HEMIS degree number, e.g. "D202300392". */
    diplomaNumber: z.string().min(1),
    holder: z
      .object({
        lastName: z.string().min(1),
        firstName: z.string().min(1),
      })
      .strict(),
    institution: z
      .object({
        /** Platform institution code (stable internal registry). */
        code: z.string().min(1).optional(),
        /** HEMIS INSTITUTION_ID where known. */
        hemisId: z.number().int().optional(),
        /** State registration number (улсын бүртгэлийн дугаар). */
        stateRegister: z.string().min(1).optional(),
        nameMn: z.string().min(1),
        nameEn: z.string().min(1).optional(),
      })
      .strict(),
    /** Constituent school (бүрэлдэхүүн сургууль), when applicable. */
    school: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
    educationLevel: z.string().min(1).optional(),
    educationField: z
      .object({
        /** String — leading zeros significant ("051202"). */
        code: z.string().optional(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
    programName: z.string().optional(),
    /** Academic year or year label; real conferral date pending source. */
    graduationYear: z.string().optional(),
  })
  .strict();

export type DiplomaSubject = z.infer<typeof DiplomaSubjectSchema>;
