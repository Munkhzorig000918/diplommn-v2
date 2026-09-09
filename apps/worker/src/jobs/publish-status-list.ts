/**
 * Publish the Bitstring Status List (architecture: off-chain hosted,
 * signed by the issuer, hash recorded for anchoring). Regenerated after
 * every revocation and on a daily freshness schedule; the API only serves
 * the stored copy — it never holds signing keys.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { credentials, statusLists, type Db } from "@diplommn/db";
import { canonicalJson, sha256Hex } from "@diplommn/shared";
import { buildSignedStatusListCredential, type VcSigner } from "@diplommn/vc";

export interface StatusListContext {
  signer: VcSigner;
  issuerDid: string;
  /** Public URL of the list, e.g. https://diplom.mn/status/1 */
  statusListCredential: string;
}

export async function publishStatusList(
  db: Db,
  ctx: StatusListContext,
  listId = 1,
): Promise<{ listId: number; revokedCount: number; sha256: string }> {
  const revoked = await db
    .select({ statusListIndex: credentials.statusListIndex })
    .from(credentials)
    .where(
      and(
        eq(credentials.lifecycleStatus, "REVOKED"),
        isNotNull(credentials.statusListIndex),
      ),
    );
  const revokedIndexes = revoked.map((r) => r.statusListIndex!);

  const signed = await buildSignedStatusListCredential(
    {
      url: ctx.statusListCredential,
      issuerDid: ctx.issuerDid,
      revokedIndexes,
    },
    ctx.signer,
  );
  const hash = sha256Hex(canonicalJson(signed));

  await db
    .insert(statusLists)
    .values({
      listId,
      credential: signed,
      sha256: hash,
      revokedCount: revokedIndexes.length,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: statusLists.listId,
      set: {
        credential: signed,
        sha256: hash,
        revokedCount: revokedIndexes.length,
        generatedAt: new Date(),
      },
    });

  return { listId, revokedCount: revokedIndexes.length, sha256: hash };
}
