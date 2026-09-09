/**
 * Merkle tree over salted credential content hashes (daily anchor batches).
 *
 * Construction rules (must stay in lockstep with the open verifier):
 *  - Leaves are sha256 hex strings (the salted content hashes); bare or
 *    0x-prefixed input is accepted and normalized to lowercase 0x form.
 *    Leaves are sorted and deduplicated, so the root is independent of
 *    issuance order.
 *  - Parent = sha256(concat(sorted(left, right))) — sorted-pair hashing, so
 *    proofs carry no left/right position bits.
 *  - An odd node is promoted to the next level unchanged (never duplicated).
 *  - A single-leaf tree's root is the leaf itself.
 */
import { createHash } from "node:crypto";

const HEX_32 = /^0x[0-9a-f]{64}$/;

/** Normalize a bare or 0x-prefixed sha256 hex string to lowercase 0x form. */
export function normalizeLeafHex(value: string): string {
  const lower = value.toLowerCase();
  const prefixed = lower.startsWith("0x") ? lower : `0x${lower}`;
  if (!HEX_32.test(prefixed)) {
    throw new Error("Merkle leaf must be a sha256 hex string");
  }
  return prefixed;
}

function toBytes(hex: string): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}

function hashPair(a: string, b: string): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const digest = createHash("sha256")
    .update(Buffer.concat([toBytes(lo), toBytes(hi)]))
    .digest("hex");
  return `0x${digest}`;
}

function normalizeLeaves(leaves: readonly string[]): string[] {
  if (leaves.length === 0) {
    throw new Error("Merkle tree requires at least one leaf");
  }
  return [...new Set(leaves.map(normalizeLeafHex))].sort();
}

export function computeMerkleRoot(leaves: readonly string[]): string {
  let level = normalizeLeaves(leaves);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(hashPair(level[i]!, level[i + 1]!));
    }
    if (level.length % 2 === 1) {
      next.push(level[level.length - 1]!);
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Sibling hashes from `leaf` up to the root. With sorted-pair hashing the
 * proof is just the sibling list — no positions needed.
 */
export function computeMerkleProof(
  leaves: readonly string[],
  leaf: string,
): string[] {
  let level = normalizeLeaves(leaves);
  let index = level.indexOf(normalizeLeafHex(leaf));
  if (index < 0) {
    throw new Error("Leaf is not part of the tree");
  }

  const proof: string[] = [];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(hashPair(level[i]!, level[i + 1]!));
    }
    const odd = level.length % 2 === 1;
    if (odd) {
      next.push(level[level.length - 1]!);
    }

    if (odd && index === level.length - 1) {
      // Promoted unchanged; no sibling at this level.
      index = next.length - 1;
    } else {
      const sibling = index % 2 === 0 ? level[index + 1]! : level[index - 1]!;
      proof.push(sibling);
      index = Math.floor(index / 2);
    }
    level = next;
  }
  return proof;
}

export function verifyMerkleProof(
  leaf: string,
  proof: readonly string[],
  root: string,
): boolean {
  let current: string;
  try {
    current = normalizeLeafHex(leaf);
    for (const sibling of proof) {
      current = hashPair(current, normalizeLeafHex(sibling));
    }
    return current === normalizeLeafHex(root);
  } catch {
    return false;
  }
}
