import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  credentials,
  credentialTypes,
  holders,
  institutions,
  users,
  type Db,
} from "@diplommn/db";
import {
  computeContentHash,
  generateCertificateId,
  generateSaltHex,
} from "@diplommn/shared";
import { publicKeyMultibaseFromJwk } from "@diplommn/did";
import {
  createLocalP256Signer,
  verifyCredential,
  type Signed,
  type UnsignedDiplomaCredential,
} from "@diplommn/vc";
import { signVcForCredential, type VcSigningContext } from "../src/jobs/sign-vc.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";

describe("sign-vc job (integration)", () => {
  let db: Db;
  let ctx: VcSigningContext;
  let publicJwk: Parameters<typeof publicKeyMultibaseFromJwk>[0];
  let fixture: { userId: string; instId: string; diplomaTypeId: string; certTypeId: string };

  beforeAll(async () => {
    ({ db } = createDb(DATABASE_URL));
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    publicJwk = publicKey.export({ format: "jwk" });
    ctx = {
      signer: createLocalP256Signer(privateKey.export({ format: "jwk" }), "issuer-1"),
      issuerDid: "did:web:diplom.mn",
      baseUrl: "https://diplom.mn",
      statusListCredential: "https://diplom.mn/status/1",
    };

    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        email: `vc-test-${suffix}@test.diplom.mn`,
        fullName: "VC Test",
        status: "ACTIVE",
      })
      .returning({ id: users.id });
    const [inst] = await db
      .insert(institutions)
      .values({ code: `VT-${suffix}`, nameMn: "Тест Их Сургууль", nameEn: "Test U" })
      .returning({ id: institutions.id });
    const [diplomaType] = await db
      .insert(credentialTypes)
      .values({
        code: `VT_DIPLOMA_${suffix}`,
        kind: "DIPLOMA",
        nameMn: "Тест диплом",
        nameEn: "Test diploma",
      })
      .returning({ id: credentialTypes.id });
    const [certType] = await db
      .insert(credentialTypes)
      .values({
        code: `VT_CERT_${suffix}`,
        kind: "CERTIFICATE",
        nameMn: "Тест сертификат",
        nameEn: "Test certificate",
      })
      .returning({ id: credentialTypes.id });
    fixture = {
      userId: user!.id,
      instId: inst!.id,
      diplomaTypeId: diplomaType!.id,
      certTypeId: certType!.id,
    };
  });

  async function seedIssued(opts: {
    typeId?: string;
    credentialNumber?: string | null;
    claims?: Record<string, unknown>;
    lifecycleStatus?: "ISSUED" | "DRAFT";
  } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const [holder] = await db
      .insert(holders)
      .values({
        lastName: "Батбаяр",
        firstName: `Мөнхсайхан-${suffix}`,
        registrationNumber: `VT${randomUUID().slice(0, 10)}`,
      })
      .returning({ id: holders.id });
    const claims = opts.claims ?? {
      educationLevel: "бакалаврын боловсрол",
      educationFieldCode: "051202",
      educationFieldName: "Мэдээллийн Технологи",
      programName: "2026-2027, Намар, ХШУИС, Бакалавр, МТ (F.IT231)",
      graduationYear: "2026-2027",
      institutionHemisId: 35623,
      institutionStateRegister: "1231232",
      schoolName: "ХШУИС",
    };
    const salt = generateSaltHex();
    const { hash, alg, canonicalization } = computeContentHash(claims, salt);
    const issued = (opts.lifecycleStatus ?? "ISSUED") === "ISSUED";
    const [cred] = await db
      .insert(credentials)
      .values({
        credentialTypeId: opts.typeId ?? fixture.diplomaTypeId,
        institutionId: fixture.instId,
        holderId: holder!.id,
        claims,
        submittedSnapshot: claims,
        credentialNumber:
          opts.credentialNumber === undefined ? `D2026${suffix}` : opts.credentialNumber,
        certificateId: issued ? generateCertificateId() : null,
        lifecycleStatus: opts.lifecycleStatus ?? "ISSUED",
        anchorStatus: issued ? "AWAITING_BATCH" : "NOT_ELIGIBLE",
        contentSalt: salt,
        contentHash: hash,
        contentHashAlg: alg,
        canonicalization,
        issuedAt: issued ? new Date() : null,
        createdBy: fixture.userId,
      })
      .returning({ id: credentials.id });
    return cred!.id;
  }

  it("signs an issued diploma and the VC verifies against the issuer key", async () => {
    const id = await seedIssued();
    const result = await signVcForCredential(db, ctx, id);
    expect(result.signed).toBe(true);
    if (!result.signed) throw new Error("unreachable");

    const [row] = await db
      .select({
        vc: credentials.vc,
        vcKeyId: credentials.vcKeyId,
        vcSignedAt: credentials.vcSignedAt,
        statusListIndex: credentials.statusListIndex,
        certificateId: credentials.certificateId,
      })
      .from(credentials)
      .where(eq(credentials.id, id));
    expect(row?.vcKeyId).toBe("issuer-1");
    expect(row?.vcSignedAt).toBeTruthy();
    expect(row?.statusListIndex).toBe(result.statusListIndex);

    const vc = row!.vc as Signed<UnsignedDiplomaCredential>;
    expect(vc.issuer).toBe("did:web:diplom.mn");
    expect(vc.id).toBe(`https://diplom.mn/credentials/${row!.certificateId}`);
    expect(vc.credentialSubject.holder.lastName).toBe("Батбаяр");
    expect(vc.credentialSubject.institution.hemisId).toBe(35623);
    expect(vc.credentialStatus?.statusListIndex).toBe(
      String(result.statusListIndex),
    );
    // Privacy: registration number and GPA never enter the signed VC.
    expect(JSON.stringify(vc)).not.toContain("registrationNumber");
    expect(vc.credentialSubject).not.toHaveProperty("gpa");

    const outcome = verifyCredential(vc, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
      expectedVerificationMethod: "did:web:diplom.mn#issuer-1",
    });
    expect(outcome).toEqual({ verified: true });
  });

  it("is idempotent — a second run never re-signs", async () => {
    const id = await seedIssued();
    const first = await signVcForCredential(db, ctx, id);
    expect(first.signed).toBe(true);
    const second = await signVcForCredential(db, ctx, id);
    expect(second).toEqual({ signed: false, skipped: "already-signed" });
  });

  it("allocates distinct status-list indexes", async () => {
    const a = await signVcForCredential(db, ctx, await seedIssued());
    const b = await signVcForCredential(db, ctx, await seedIssued());
    if (!a.signed || !b.signed) throw new Error("unreachable");
    expect(a.statusListIndex).not.toBe(b.statusListIndex);
  });

  it("skips non-issued credentials and non-diploma kinds", async () => {
    const draft = await signVcForCredential(
      db,
      ctx,
      await seedIssued({ lifecycleStatus: "DRAFT" }),
    );
    expect(draft.signed).toBe(false);

    const cert = await signVcForCredential(
      db,
      ctx,
      await seedIssued({ typeId: fixture.certTypeId }),
    );
    expect(cert).toEqual({
      signed: false,
      skipped: "no schema for kind CERTIFICATE",
    });
  });

  it("fails loudly when the diploma number is missing", async () => {
    const id = await seedIssued({
      credentialNumber: null,
      claims: { educationLevel: "бакалаврын боловсрол" },
    });
    await expect(signVcForCredential(db, ctx, id)).rejects.toThrow(
      /no diploma number/,
    );
  });
});
