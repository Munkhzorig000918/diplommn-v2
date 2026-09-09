import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";

// Deploys AnchorRegistry and records the deployment under deployments/.
// The anchorer defaults to the deployer; set ANCHORER_ADDRESS to use a
// separate anchor-service wallet.

const connection = await network.getOrCreate();
const { viem, networkName } = connection;

const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (!deployer) {
  throw new Error("No deployer account configured for this network");
}

const anchorer =
  (process.env.ANCHORER_ADDRESS as `0x${string}` | undefined) ??
  deployer.account.address;

console.log(`network:  ${networkName} (chainId ${await publicClient.getChainId()})`);
console.log(`deployer: ${deployer.account.address}`);
console.log(`anchorer: ${anchorer}`);

const { contract: registry, deploymentTransaction } =
  await viem.sendDeploymentTransaction("AnchorRegistry", [anchorer]);
// Public load-balanced RPCs can briefly 404 a just-broadcast tx — retry hard.
const receipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentTransaction.hash,
  retryCount: 30,
  pollingInterval: 4_000,
  timeout: 300_000,
});

console.log(`AnchorRegistry deployed at ${registry.address}`);
console.log(`tx ${receipt.transactionHash} (block ${receipt.blockNumber})`);

const deployment = {
  contract: "AnchorRegistry",
  network: networkName,
  chainId: await publicClient.getChainId(),
  address: registry.address,
  anchorer,
  deployer: deployer.account.address,
  txHash: receipt.transactionHash,
  blockNumber: Number(receipt.blockNumber),
};

const outDir = path.join(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });
const isLocal = deployment.chainId === 31337;
const outFile = path.join(outDir, `${isLocal ? "local" : networkName}.json`);
await writeFile(outFile, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`deployment record written to ${outFile}`);
