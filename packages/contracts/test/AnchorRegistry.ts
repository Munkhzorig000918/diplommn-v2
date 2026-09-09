import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, toHex, zeroAddress, zeroHash } from "viem";

const { viem } = await network.getOrCreate();

const ROOT_1 = keccak256(toHex("diplom.mn test merkle root 1"));
const ROOT_2 = keccak256(toHex("diplom.mn test merkle root 2"));

async function deployRegistry() {
  const [anchorerClient, strangerClient] = await viem.getWalletClients();
  if (!anchorerClient || !strangerClient) {
    throw new Error("expected at least two wallet clients");
  }
  const registry = await viem.deployContract("AnchorRegistry", [
    anchorerClient.account.address,
  ]);
  const publicClient = await viem.getPublicClient();
  return { registry, anchorerClient, strangerClient, publicClient };
}

describe("AnchorRegistry", () => {
  it("rejects a zero anchorer address at deployment", async () => {
    await assert.rejects(
      viem.deployContract("AnchorRegistry", [zeroAddress]),
      (err) => /ZeroAnchorer/.test(String(err)),
    );
  });

  it("exposes the anchorer set at deployment", async () => {
    const { registry, anchorerClient } = await deployRegistry();
    assert.equal(
      (await registry.read.anchorer()).toLowerCase(),
      anchorerClient.account.address.toLowerCase(),
    );
  });

  it("anchors a root and records the block timestamp", async () => {
    const { registry, publicClient } = await deployRegistry();

    const txHash = await registry.write.anchorRoot([1n, ROOT_1]);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });

    assert.equal(await registry.read.rootOf([1n]), ROOT_1);
    assert.equal(await registry.read.anchoredAt([1n]), block.timestamp);
  });

  it("emits RootAnchored with batch id, root and timestamp", async () => {
    const { registry, publicClient } = await deployRegistry();

    const txHash = await registry.write.anchorRoot([42n, ROOT_1]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const events = await publicClient.getContractEvents({
      address: registry.address,
      abi: registry.abi,
      eventName: "RootAnchored",
      fromBlock: 0n,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.args.batchId, 42n);
    assert.equal(events[0]?.args.root, ROOT_1);
    assert.equal(events[0]?.args.anchoredAt, await registry.read.anchoredAt([42n]));
  });

  it("keeps unanchored batches at zero", async () => {
    const { registry } = await deployRegistry();
    assert.equal(await registry.read.rootOf([999n]), zeroHash);
    assert.equal(await registry.read.anchoredAt([999n]), 0n);
  });

  it("rejects anchoring from any address other than the anchorer", async () => {
    const { registry, strangerClient } = await deployRegistry();
    await assert.rejects(
      registry.write.anchorRoot([1n, ROOT_1], {
        account: strangerClient.account,
      }),
      (err) => /NotAnchorer/.test(String(err)),
    );
    assert.equal(await registry.read.rootOf([1n]), zeroHash);
  });

  it("rejects a zero root", async () => {
    const { registry } = await deployRegistry();
    await assert.rejects(
      registry.write.anchorRoot([1n, zeroHash]),
      (err) => /ZeroRoot/.test(String(err)),
    );
  });

  it("rejects anchoring the same batch twice (idempotency guard)", async () => {
    const { registry } = await deployRegistry();
    await registry.write.anchorRoot([7n, ROOT_1]);
    await assert.rejects(
      registry.write.anchorRoot([7n, ROOT_2]),
      (err) => /AlreadyAnchored/.test(String(err)),
    );
    assert.equal(await registry.read.rootOf([7n]), ROOT_1);
  });

  it("anchors independent batches independently", async () => {
    const { registry } = await deployRegistry();
    await registry.write.anchorRoot([20260908n, ROOT_1]);
    await registry.write.anchorRoot([20260909n, ROOT_2]);
    assert.equal(await registry.read.rootOf([20260908n]), ROOT_1);
    assert.equal(await registry.read.rootOf([20260909n]), ROOT_2);
  });
});
