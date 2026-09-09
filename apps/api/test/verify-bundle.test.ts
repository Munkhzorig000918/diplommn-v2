import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, statusLists, type Db } from "@diplommn/db";
import {
  Cryptosuite,
  KeyStatus,
  publicKeyMultibaseFromJwk,
  type KeyHistory,
} from "@diplommn/did";
import {
  buildDiplomaCredential,
  buildSignedStatusListCredential,
  createLocalP256Signer,
  signCredential,
  type Signed,
  type UnsignedDiplomaCredential,
  type VcSigner,
} from "@diplommn/vc";
import type pg from "pg";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const ISSUER = "did:web:diplom.mn";
const STATUS_URL = "https://diplom.mn/status/1";
const STATUS_INDEX = 77_001;

describe("VC bundle verification endpoint (integration)", () => {
  let app: FastifyInstance;
  let db: Db;
  let pool: pg.Pool;
  let signer: VcSigner;
  let signedVc: Signed<UnsignedDiplomaCredential>;

  async function publishStatusListRow(revoked: number[]): Promise<void> {
    const credential = await buildSignedStatusListCredential(
      { url: STATUS_URL, issuerDid: ISSUER, revokedIndexes: revoked },
      signer,
    );
    await db
      .insert(statusLists)
      .values({
        listId: 1,
        credential,
        sha256: "test",
        revokedCount: revoked.length,
        generatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: statusLists.listId,
        set: {
          credential,
          revokedCount: revoked.length,
          generatedAt: new Date(),
        },
      });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";
    process.env.SESSION_SECRET ??= "test-secret-0123456789abcdef";

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    signer = createLocalP256Signer(privateKey.export({ format: "jwk" }), "issuer-1");

    const history: KeyHistory = {
      issuer: ISSUER,
      updated: new Date().toISOString(),
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
    const dir = mkdtempSync(path.join(tmpdir(), "did-test-"));
    const historyFile = path.join(dir, "key-history.json");
    writeFileSync(historyFile, JSON.stringify(history));

    const config = loadConfig({ DID_KEY_HISTORY_FILE: historyFile });
    ({ db, pool } = createDb(config.DATABASE_URL));
    app = await buildServer(db, config, { logger: false });

    signedVc = await signCredential(
      buildDiplomaCredential({
        certificateId: randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase(),
        issuerDid: ISSUER,
        baseUrl: "https://diplom.mn",
        issuedAt: new Date("2026-09-01T08:00:00Z"),
        subject: {
          diplomaNumber: "D202609099",
          holder: { lastName: "Батбаяр", firstName: "Мөнхсайхан" },
          institution: { nameMn: "Тест Их Сургууль" },
        },
        status: {
          statusListIndex: STATUS_INDEX,
          statusListCredential: STATUS_URL,
        },
      }),
      signer,
    );
    await publishStatusListRow([]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("serves the issuer DID document at /.well-known/did.json", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/did.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.id).toBe(ISSUER);
    expect(doc.assertionMethod).toEqual([`${ISSUER}#issuer-1`]);
  });

  it("verifies a bare signed VC as VALID (anchor pending)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify/bundle",
      payload: signedVc,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBe("VALID");
    expect(body.checks).toEqual({
      signature: "PASS",
      revocation: "PASS",
      anchor: "PENDING",
    });
    expect(body.credential.issuer).toBe(ISSUER);
    expect(body.credential.subject.holder.firstName).toBe("Мөнхсайхан");
    expect(body.technical.verificationMethod).toBe(`${ISSUER}#issuer-1`);
  });

  it("accepts the wrapped proof-bundle shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify/bundle",
      payload: {
        bundleVersion: "1.0",
        vc: signedVc,
        leaf: { salt: null, source: "vc", hashAlg: "SHA-256" },
        anchor: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("VALID");
  });

  it("returns NOT_VALID for a tampered credential", async () => {
    const tampered = structuredClone(signedVc);
    tampered.credentialSubject.holder.firstName = "Хуурамч";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify/bundle",
      payload: tampered,
    });
    expect(res.json().result).toBe("NOT_VALID");
  });

  it("returns REVOKED once the status bit is set", async () => {
    await publishStatusListRow([STATUS_INDEX]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify/bundle",
      payload: signedVc,
    });
    expect(res.json().result).toBe("REVOKED");
    await publishStatusListRow([]);
  });

  it("rejects bodies without a proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/verify/bundle",
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(400);
  });
});
