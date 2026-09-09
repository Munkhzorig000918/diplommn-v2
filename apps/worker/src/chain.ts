/**
 * viem-backed AnchorChain against the deployed AnchorRegistry. Config is
 * env-driven (works for Sepolia now, mainnet later). Public load-balanced
 * RPCs can briefly 404 fresh transactions, hence the hardened receipt wait.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANCHOR_REGISTRY_ABI } from "@diplommn/contracts";
import type { AnchorChain } from "./jobs/anchor-batch.js";

export interface AnchorChainConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  contractAddress: `0x${string}`;
  chainId: number;
}

export function createAnchorChain(cfg: AnchorChainConfig): AnchorChain {
  const chain = defineChain({
    id: cfg.chainId,
    name: `anchor-chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(cfg.rpcUrl),
  });

  return {
    chainId: cfg.chainId,
    contractAddress: cfg.contractAddress,

    async rootOf(batchId) {
      return publicClient.readContract({
        address: cfg.contractAddress,
        abi: ANCHOR_REGISTRY_ABI,
        functionName: "rootOf",
        args: [batchId],
      });
    },

    async anchorRoot(batchId, root) {
      const txHash = await walletClient.writeContract({
        address: cfg.contractAddress,
        abi: ANCHOR_REGISTRY_ABI,
        functionName: "anchorRoot",
        args: [batchId, root as `0x${string}`],
      });
      return { txHash };
    },

    async waitForReceipt(txHash) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        retryCount: 30,
        pollingInterval: 4_000,
        timeout: 300_000,
      });
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    },
  };
}

/** Build chain config from env; null (with a log) when anchoring is not configured. */
export function anchorChainConfigFromEnv(
  env: NodeJS.ProcessEnv,
): AnchorChainConfig | null {
  const rpcUrl = env.ANCHOR_RPC_URL;
  const privateKey = env.ANCHOR_PRIVATE_KEY;
  const contractAddress = env.ANCHOR_CONTRACT_ADDRESS;
  const chainId = env.ANCHOR_CHAIN_ID;
  if (!rpcUrl || !privateKey || !contractAddress || !chainId) return null;
  return {
    rpcUrl,
    privateKey: privateKey as `0x${string}`,
    contractAddress: contractAddress as `0x${string}`,
    chainId: Number(chainId),
  };
}
