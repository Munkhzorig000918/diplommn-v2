import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  credentials,
  credentialTypes,
  holders,
  institutions,
  statusLists,
  users,
  type Db,
} from "@diplommn/db";
import { generateCertificateId, generateSaltHex, computeContentHash } from "@diplommn/shared";
import { publicKeyMultibaseFromJwk } from "@diplommn/did";
import {
  createLocalP256Signer,
  isRevokedInStatusList,
  verifyCredential,
  type Signed,
  type StatusListCredential,
} from "@diplommn/vc";
import { publishStatusList, type StatusListContext } from "../src/jobs/publish-status-list.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://diplommn:diplommn_dev@localhost:5433/diplommn";

describe("publish-status-list job (integration)", () => {
  let db: Db;
  let ctx: StatusListContext;
  let publicJwk: Parameters<typeof publicKeyMultibaseFromJwk>[0];
  let revokedIndex: number;

  beforeAll(async () => {
    ({ db } = createDb(DATABASE_URL));
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    publicJwk = publicKey.export({ format: "jwk" });
    ctx = {
      signer: createLocalP256Signer(privateKey.export({ format: "jwk" }), "issuer-1"),
      issuerDid: "did:web:diplom.mn",
      statusListCredential: "https://diplom.mn/status/1",
    };

    // Seed one REVOKED credential holding a status-list slot.
    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        email: `sl-test-${suffix}@test.diplom.mn`,
        fullName: "SL Test",
        status: "ACTIVE",
      })
      .returning({ id: users.id });
    const [inst] = await db
      .insert(institutions)
      .values({ code: `SL-${suffix}`, nameMn: "Тест ИС", nameEn: "Test U" })
      .returning({ id: institutions.id });
    const [type] = await db
      .insert(credentialTypes)
      .values({
        code: `SL_DIPLOMA_${suffix}`,
        kind: "DIPLOMA",
        nameMn: "Тест диплом",
        nameEn: "Test diploma",
      })
      .returning({ id: credentialTypes.id });
    const [holder] = await db
      .insert(holders)
      .values({
        lastName: "Тест",
        firstName: `Holder ${suffix}`,
        registrationNumber: `SL${randomUUID().slice(0, 10)}`,
      })
      .returning({ id: holders.id });
    const claims = { educationLevel: "бакалаврын боловсрол" };
    const salt = generateSaltHex();
    const { hash, alg, canonicalization } = computeContentHash(claims, salt);
    // Same sequence the sign job uses.
    const allocated = await db.execute(
      sql`SELECT nextval('credentials_status_list_index_seq') AS idx`,
    );
    revokedIndex = Number((allocated.rows[0] as { idx: string }).idx);
    await db.insert(credentials).values({
      credentialTypeId: type!.id,
      institutionId: inst!.id,
      holderId: holder!.id,
      claims,
      certificateId: generateCertificateId(),
      lifecycleStatus: "REVOKED",
      contentSalt: salt,
      contentHash: hash,
      contentHashAlg: alg,
      canonicalization,
      issuedAt: new Date(),
      statusListIndex: revokedIndex,
      createdBy: user!.id,
    });
  });

  it("publishes a signed list with the revoked bit set", async () => {
    const result = await publishStatusList(db, ctx);
    expect(result.revokedCount).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(statusLists)
      .where(eq(statusLists.listId, 1));
    expect(row?.sha256).toBe(result.sha256);

    const credential = row!.credential as Signed<StatusListCredential>;
    expect(
      verifyCredential(credential, {
        publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
      }),
    ).toEqual({ verified: true });
    expect(isRevokedInStatusList(credential, revokedIndex)).toBe(true);
    expect(isRevokedInStatusList(credential, revokedIndex + 1)).toBe(false);
  });

  it("re-publishing overwrites the same list id (upsert)", async () => {
    const first = await publishStatusList(db, ctx);
    const second = await publishStatusList(db, ctx);
    expect(second.listId).toBe(first.listId);
    const rows = await db.select().from(statusLists);
    expect(rows.filter((r) => r.listId === 1)).toHaveLength(1);
  });
});
