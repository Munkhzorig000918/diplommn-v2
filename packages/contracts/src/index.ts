/**
 * Consumable surface of the contracts package: the AnchorRegistry ABI
 * (mirrors contracts/AnchorRegistry.sol — the contract is immutable, so the
 * ABI is frozen) and deployment-record access for workers/services that must
 * not depend on gitignored Hardhat artifacts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const ANCHOR_REGISTRY_ABI = [
  {
    inputs: [{ internalType: "address", name: "anchorer_", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [{ internalType: "uint256", name: "batchId", type: "uint256" }],
    name: "AlreadyAnchored",
    type: "error",
  },
  { inputs: [], name: "NotAnchorer", type: "error" },
  { inputs: [], name: "ZeroAnchorer", type: "error" },
  { inputs: [], name: "ZeroRoot", type: "error" },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "batchId", type: "uint256" },
      { indexed: false, internalType: "bytes32", name: "root", type: "bytes32" },
      { indexed: false, internalType: "uint64", name: "anchoredAt", type: "uint64" },
    ],
    name: "RootAnchored",
    type: "event",
  },
  {
    inputs: [
      { internalType: "uint256", name: "batchId", type: "uint256" },
      { internalType: "bytes32", name: "root", type: "bytes32" },
    ],
    name: "anchorRoot",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "batchId", type: "uint256" }],
    name: "anchoredAt",
    outputs: [{ internalType: "uint64", name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "anchorer",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "batchId", type: "uint256" }],
    name: "rootOf",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface AnchorDeployment {
  contract: string;
  network: string;
  chainId: number;
  address: `0x${string}`;
  anchorer: `0x${string}`;
  deployer: `0x${string}`;
  txHash: `0x${string}` | null;
  blockNumber: number | null;
}

/** Read deployments/<network>.json (e.g. "sepolia"). */
export function loadAnchorDeployment(network: string): AnchorDeployment {
  const file = path.join(
    import.meta.dirname,
    "..",
    "deployments",
    `${network}.json`,
  );
  return JSON.parse(readFileSync(file, "utf8")) as AnchorDeployment;
}
