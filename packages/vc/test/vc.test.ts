import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyMultibaseFromJwk } from "@diplommn/did";
import {
  DIPLOMA_SCHEMA_URL,
  DiplomaSubjectSchema,
  buildDiplomaCredential,
  createLocalP256Signer,
  signCredential,
  verifyCredential,
  type DiplomaSubject,
} from "../src/index.js";

const SUBJECT: DiplomaSubject = {
  diplomaNumber: "D202609001",
  holder: { lastName: "Батбаяр", firstName: "Мөнхсайхан" },
  institution: {
    code: "MUST",
    hemisId: 35623,
    stateRegister: "1231232",
    nameMn: "Тест Их Сургууль",
  },
  school: { id: "S1", name: "ХШУИС" },
  educationLevel: "бакалаврын боловсрол",
  educationField: { code: "051202", name: "Мэдээллийн Технологи" },
  programName: "2026-2027, Намар, ХШУИС, Бакалавр, Мэдээллийн Технологи, (F.IT231)",
  graduationYear: "2026-2027",
};

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    publicJwk: publicKey.export({ format: "jwk" }),
    privateJwk: privateKey.export({ format: "jwk" }),
  };
}

function unsigned(status = true) {
  return buildDiplomaCredential({
    certificateId: "3G8Q2M5T7Z9B4C6D1E0F",
    issuerDid: "did:web:diplom.mn",
    baseUrl: "https://diplom.mn",
    issuedAt: new Date("2026-09-09T08:00:00Z"),
    subject: SUBJECT,
    ...(status
      ? {
          status: {
            statusListIndex: 42,
            statusListCredential: "https://diplom.mn/status/1",
          },
        }
      : {}),
  });
}

describe("schema 1.0", () => {
  it("rejects unknown fields (frozen contract)", () => {
    expect(() =>
      DiplomaSubjectSchema.parse({ ...SUBJECT, gpa: 4 }),
    ).toThrow();
    expect(() =>
      DiplomaSubjectSchema.parse({ ...SUBJECT, studentRegister: "aa99887766" }),
    ).toThrow();
  });

  it("requires diploma number, holder and institution name", () => {
    expect(() =>
      DiplomaSubjectSchema.parse({ holder: SUBJECT.holder }),
    ).toThrow();
    const minimal = {
      diplomaNumber: "D1",
      holder: { lastName: "А", firstName: "Б" },
      institution: { nameMn: "Их сургууль" },
    };
    expect(DiplomaSubjectSchema.parse(minimal)).toEqual(minimal);
  });
});

describe("credential envelope", () => {
  it("builds a VC 2.0 document with schema + status references", () => {
    const vc = unsigned();
    expect(vc["@context"]).toEqual(["https://www.w3.org/ns/credentials/v2"]);
    expect(vc.id).toBe("https://diplom.mn/credentials/3G8Q2M5T7Z9B4C6D1E0F");
    expect(vc.type).toEqual(["VerifiableCredential", "MongolianDiplomaCredential"]);
    expect(vc.credentialSchema.id).toBe(DIPLOMA_SCHEMA_URL);
    expect(vc.credentialStatus).toEqual({
      id: "https://diplom.mn/status/1#42",
      type: "BitstringStatusListEntry",
      statusPurpose: "revocation",
      statusListIndex: "42",
      statusListCredential: "https://diplom.mn/status/1",
    });
    expect(vc.validFrom).toBe("2026-09-09T08:00:00.000Z");
  });
});

describe("sign + verify (ecdsa-jcs-2019)", () => {
  it("round-trips: signed VC verifies against the issuer Multikey", async () => {
    const { publicJwk, privateJwk } = keypair();
    const signer = createLocalP256Signer(privateJwk, "issuer-1");
    const signed = await signCredential(unsigned(), signer, {
      created: new Date("2026-09-09T08:00:01Z"),
    });

    expect(signed.proof.type).toBe("DataIntegrityProof");
    expect(signed.proof.cryptosuite).toBe("ecdsa-jcs-2019");
    expect(signed.proof.verificationMethod).toBe("did:web:diplom.mn#issuer-1");
    expect(signed.proof.proofValue.startsWith("z")).toBe(true);

    const outcome = verifyCredential(signed, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
      expectedVerificationMethod: "did:web:diplom.mn#issuer-1",
    });
    expect(outcome).toEqual({ verified: true });
  });

  it("fails verification when any claim is tampered", async () => {
    const { publicJwk, privateJwk } = keypair();
    const signed = await signCredential(
      unsigned(),
      createLocalP256Signer(privateJwk, "issuer-1"),
    );
    const tampered = structuredClone(signed);
    tampered.credentialSubject.holder.firstName = "Хуурамч";
    const outcome = verifyCredential(tampered, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
    });
    expect(outcome.verified).toBe(false);
  });

  it("fails against a different issuer key", async () => {
    const signerKeys = keypair();
    const otherKeys = keypair();
    const signed = await signCredential(
      unsigned(),
      createLocalP256Signer(signerKeys.privateJwk, "issuer-1"),
    );
    const outcome = verifyCredential(signed, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(otherKeys.publicJwk),
    });
    expect(outcome.verified).toBe(false);
  });

  it("rejects an unexpected verification method (rotation safety)", async () => {
    const { publicJwk, privateJwk } = keypair();
    const signed = await signCredential(
      unsigned(),
      createLocalP256Signer(privateJwk, "issuer-9"),
    );
    const outcome = verifyCredential(signed, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
      expectedVerificationMethod: "did:web:diplom.mn#issuer-1",
    });
    expect(outcome.verified).toBe(false);
  });

  it("proof tampering (created time) breaks the signature", async () => {
    const { publicJwk, privateJwk } = keypair();
    const signed = await signCredential(
      unsigned(),
      createLocalP256Signer(privateJwk, "issuer-1"),
    );
    const tampered = structuredClone(signed);
    tampered.proof.created = "2030-01-01T00:00:00.000Z";
    const outcome = verifyCredential(tampered, {
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
    });
    expect(outcome.verified).toBe(false);
  });
});
