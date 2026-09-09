import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Cryptosuite,
  KeyStatus,
  buildDidDocument,
  publicKeyMultibaseFromJwk,
  type KeyHistory,
} from "@diplommn/did";
import {
  canonicalJson,
  computeMerkleProof,
  computeMerkleRoot,
  generateSaltHex,
  sha256Hex,
} from "@diplommn/shared";
import {
  buildDiplomaCredential,
  buildSignedStatusListCredential,
  createLocalP256Signer,
  signCredential,
  type Signed,
  type StatusListCredential,
  type UnsignedDiplomaCredential,
  type VcSigner,
} from "@diplommn/vc";
import {
  verifyProofBundle,
  type ProofBundle,
  type VerifierOptions,
} from "../src/index.js";

const ISSUER = "did:web:diplom.mn";
const STATUS_URL = "https://diplom.mn/status/1";

describe("verifyProofBundle", () => {
  let signer: VcSigner;
  let didDocument: ReturnType<typeof buildDidDocument>;
  let statusListEmpty: Signed<StatusListCredential>;
  let statusListRevoked42: Signed<StatusListCredential>;
  let bundle: ProofBundle;
  let siblingLeaves: string[];

  function makeOptions(overrides: Partial<VerifierOptions> = {}): VerifierOptions {
    return {
      resolveDidDocument: async () => didDocument,
      fetchStatusList: async () => statusListEmpty,
      fetchAnchoredRoot: async (anchor) => anchor.merkleRoot,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    signer = createLocalP256Signer(privateKey.export({ format: "jwk" }), "issuer-1");
    const history: KeyHistory = {
      issuer: ISSUER,
      updated: "2026-09-09T00:00:00Z",
      keys: [
        {
          keyId: "issuer-1",
          type: "P-256",
          cryptosuite: Cryptosuite["P-256"],
          publicKeyMultibase: publicKeyMultibaseFromJwk(
            publicKey.export({ format: "jwk" }),
          ),
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: null,
          status: KeyStatus.Active,
          kmsKeyRef: null,
        },
      ],
    };
    didDocument = buildDidDocument("diplom.mn", history);

    statusListEmpty = await buildSignedStatusListCredential(
      { url: STATUS_URL, issuerDid: ISSUER, revokedIndexes: [] },
      signer,
    );
    statusListRevoked42 = await buildSignedStatusListCredential(
      { url: STATUS_URL, issuerDid: ISSUER, revokedIndexes: [42] },
      signer,
    );

    const unsigned = buildDiplomaCredential({
      certificateId: "3G8Q2M5T7Z9B4C6D1E0F",
      issuerDid: ISSUER,
      baseUrl: "https://diplom.mn",
      issuedAt: new Date("2026-09-08T08:00:00Z"),
      subject: {
        diplomaNumber: "D202609001",
        holder: { lastName: "Батбаяр", firstName: "Мөнхсайхан" },
        institution: { nameMn: "Тест Их Сургууль" },
      },
      status: { statusListIndex: 42, statusListCredential: STATUS_URL },
    });
    const vc = await signCredential(unsigned, signer);

    // Anchor batch: our salted VC hash + two sibling leaves.
    const salt = generateSaltHex();
    const leaf = sha256Hex(
      Buffer.concat([
        Buffer.from(salt, "hex"),
        Buffer.from(canonicalJson(vc), "utf8"),
      ]),
    );
    siblingLeaves = [sha256Hex("sibling-a"), sha256Hex("sibling-b"), leaf];
    const merkleRoot = computeMerkleRoot(siblingLeaves);

    bundle = {
      bundleVersion: "1.0",
      vc: vc as unknown as ProofBundle["vc"],
      leaf: { salt, source: "vc", hashAlg: "SHA-256" },
      anchor: {
        batchId: "20260908",
        merkleRoot,
        merkleProof: computeMerkleProof(siblingLeaves, leaf),
        chainId: 11155111,
        contractAddress: "0x189E57eA448D04D684D195BBd9642162042F2441",
        txHash: "0xabc",
        blockNumber: "11666143",
        status: "CONFIRMED",
      },
    };
  });

  it("returns VALID with all three checks passing", async () => {
    const report = await verifyProofBundle(bundle, makeOptions());
    expect(report.result).toBe("VALID");
    expect(report.checks).toEqual({
      signature: "PASS",
      revocation: "PASS",
      anchor: "PASS",
    });
  });

  it("returns REVOKED when the status bit is set", async () => {
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ fetchStatusList: async () => statusListRevoked42 }),
    );
    expect(report.result).toBe("REVOKED");
    expect(report.checks.signature).toBe("PASS");
  });

  it("returns NOT_VALID for a tampered credential", async () => {
    const tampered = structuredClone(bundle);
    (
      tampered.vc as unknown as Signed<UnsignedDiplomaCredential>
    ).credentialSubject.holder.firstName = "Хуурамч";
    const report = await verifyProofBundle(tampered, makeOptions());
    expect(report.result).toBe("NOT_VALID");
  });

  it("returns NOT_VALID when the on-chain root differs", async () => {
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ fetchAnchoredRoot: async () => sha256Hex("evil-root") }),
    );
    expect(report.result).toBe("NOT_VALID");
    expect(report.details.join(" ")).toMatch(/root does not match/);
  });

  it("returns NOT_VALID when the Merkle proof is broken", async () => {
    const broken = structuredClone(bundle);
    broken.anchor!.merkleProof = [sha256Hex("wrong-sibling")];
    const report = await verifyProofBundle(broken, makeOptions());
    expect(report.result).toBe("NOT_VALID");
  });

  it("returns INDETERMINATE when the DID document is unreachable", async () => {
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ resolveDidDocument: async () => null }),
    );
    expect(report.result).toBe("INDETERMINATE");
    expect(report.checks.signature).toBe("UNAVAILABLE");
  });

  it("returns INDETERMINATE when the status list is unreachable", async () => {
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ fetchStatusList: async () => null }),
    );
    expect(report.result).toBe("INDETERMINATE");
    expect(report.checks.revocation).toBe("UNAVAILABLE");
  });

  it("treats a forged status list as unavailable, not as revocation truth", async () => {
    const forged = structuredClone(statusListRevoked42);
    forged.proof.proofValue = statusListEmpty.proof.proofValue;
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ fetchStatusList: async () => forged }),
    );
    expect(report.result).toBe("INDETERMINATE");
    expect(report.checks.revocation).toBe("UNAVAILABLE");
  });

  it("stays VALID with anchor PENDING when not anchored yet (public proof pending)", async () => {
    const pending = structuredClone(bundle);
    pending.anchor = null;
    const report = await verifyProofBundle(pending, makeOptions());
    expect(report.result).toBe("VALID");
    expect(report.checks.anchor).toBe("PENDING");
  });

  it("stays VALID when the chain is unreachable (outage ≠ fraud)", async () => {
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ fetchAnchoredRoot: async () => null }),
    );
    expect(report.result).toBe("VALID");
    expect(report.checks.anchor).toBe("UNAVAILABLE");
  });

  it("verifies credentials signed by a retired key that is still resolvable", async () => {
    // Same key marked RETIRED (rotation happened after issuance).
    const rotated = buildDidDocument("diplom.mn", {
      issuer: ISSUER,
      updated: "2027-01-01T00:00:00Z",
      keys: [
        {
          keyId: "issuer-1",
          type: "P-256",
          cryptosuite: Cryptosuite["P-256"],
          publicKeyMultibase:
            didDocument.verificationMethod[0]!.publicKeyMultibase,
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: "2026-12-31T00:00:00Z",
          status: KeyStatus.Retired,
          kmsKeyRef: null,
        },
        {
          keyId: "issuer-2",
          type: "P-256",
          cryptosuite: Cryptosuite["P-256"],
          publicKeyMultibase:
            didDocument.verificationMethod[0]!.publicKeyMultibase,
          validFrom: "2026-12-31T00:00:00Z",
          validUntil: null,
          status: KeyStatus.Active,
          kmsKeyRef: null,
        },
      ],
    });
    const report = await verifyProofBundle(
      bundle,
      makeOptions({ resolveDidDocument: async () => rotated }),
    );
    expect(report.result).toBe("VALID");
  });
});
