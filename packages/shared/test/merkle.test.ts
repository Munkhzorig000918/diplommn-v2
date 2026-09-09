import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeMerkleProof,
  computeMerkleRoot,
  normalizeLeafHex,
  verifyMerkleProof,
} from "../src/merkle.js";

function leaf(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const LEAVES = Array.from({ length: 7 }, (_, i) => leaf(`credential-${i}`));

describe("computeMerkleRoot", () => {
  it("is a single leaf for one-element trees", () => {
    expect(computeMerkleRoot([LEAVES[0]!])).toBe(normalizeLeafHex(LEAVES[0]!));
  });

  it("is independent of leaf order and 0x prefixing", () => {
    const shuffled = [...LEAVES].reverse().map((l, i) => (i % 2 ? `0x${l}` : l));
    expect(computeMerkleRoot(shuffled)).toBe(computeMerkleRoot(LEAVES));
  });

  it("changes when any leaf changes", () => {
    const tampered = [...LEAVES];
    tampered[3] = leaf("credential-tampered");
    expect(computeMerkleRoot(tampered)).not.toBe(computeMerkleRoot(LEAVES));
  });

  it("rejects empty and malformed input", () => {
    expect(() => computeMerkleRoot([])).toThrow(/at least one leaf/);
    expect(() => computeMerkleRoot(["nope"])).toThrow(/sha256 hex/);
  });
});

describe("computeMerkleProof / verifyMerkleProof", () => {
  it("produces verifying proofs for every leaf at every tree size", () => {
    for (let size = 1; size <= 9; size += 1) {
      const leaves = Array.from({ length: size }, (_, i) => leaf(`n-${i}`));
      const root = computeMerkleRoot(leaves);
      for (const l of leaves) {
        const proof = computeMerkleProof(leaves, l);
        expect(verifyMerkleProof(l, proof, root)).toBe(true);
      }
    }
  });

  it("rejects proofs for non-member leaves", () => {
    const root = computeMerkleRoot(LEAVES);
    const outsider = leaf("not-in-tree");
    const proof = computeMerkleProof(LEAVES, LEAVES[0]!);
    expect(verifyMerkleProof(outsider, proof, root)).toBe(false);
    expect(() => computeMerkleProof(LEAVES, outsider)).toThrow(/not part/);
  });

  it("rejects a valid proof against the wrong root", () => {
    const proof = computeMerkleProof(LEAVES, LEAVES[2]!);
    expect(verifyMerkleProof(LEAVES[2]!, proof, leaf("wrong-root"))).toBe(false);
  });

  it("rejects tampered proofs without throwing", () => {
    const root = computeMerkleRoot(LEAVES);
    const proof = computeMerkleProof(LEAVES, LEAVES[1]!);
    const tampered = [...proof];
    tampered[0] = leaf("evil-sibling");
    expect(verifyMerkleProof(LEAVES[1]!, tampered, root)).toBe(false);
    expect(verifyMerkleProof(LEAVES[1]!, ["garbage"], root)).toBe(false);
  });
});
