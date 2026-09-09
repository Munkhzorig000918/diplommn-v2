/**
 * Default fetchers for the stateless verifier. All dependency-free (bare
 * fetch + raw JSON-RPC) so the verifier stays statically hostable.
 */
import type { DidWebDocument } from "@diplommn/did";
import type { Signed, StatusListCredential } from "@diplommn/vc";
import type { ProofBundleAnchor } from "./verify.js";

/** did:web resolution URL (bare-domain form) — mirror of @diplommn/did. */
function didWebDocumentUrl(domain: string): string {
  return `https://${domain}/.well-known/did.json`;
}

/** keccak("rootOf(uint256)") selector of the immutable AnchorRegistry. */
const ROOT_OF_SELECTOR = "0xdc299d69";
const ZERO_ROOT = `0x${"0".repeat(64)}`;

export function createDidWebResolver(fetchImpl: typeof fetch = fetch) {
  return async (did: string): Promise<DidWebDocument | null> => {
    const match = /^did:web:([a-z0-9.%-]+)$/i.exec(did);
    if (!match) return null;
    const domain = decodeURIComponent(match[1]!);
    try {
      const response = await fetchImpl(didWebDocumentUrl(domain), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const doc = (await response.json()) as DidWebDocument;
      return doc.id === did ? doc : null;
    } catch {
      return null;
    }
  };
}

export function createStatusListFetcher(fetchImpl: typeof fetch = fetch) {
  return async (url: string): Promise<Signed<StatusListCredential> | null> => {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as Signed<StatusListCredential>;
    } catch {
      return null;
    }
  };
}

/**
 * Read rootOf(batchId) straight from an Ethereum JSON-RPC endpoint. The
 * anchor's chainId must match the endpoint's chain — checked via eth_chainId
 * so a bundle cannot point the verifier at the wrong network.
 */
export function createEthereumRootFetcher(
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (anchor: ProofBundleAnchor): Promise<string | null> => {
    try {
      const call = async (method: string, params: unknown[]) => {
        const response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { result?: string };
        return body.result ?? null;
      };

      const chainId = await call("eth_chainId", []);
      if (!chainId || Number.parseInt(chainId, 16) !== anchor.chainId) {
        return null;
      }
      const batchIdHex = BigInt(anchor.batchId).toString(16).padStart(64, "0");
      const root = await call("eth_call", [
        { to: anchor.contractAddress, data: `${ROOT_OF_SELECTOR}${batchIdHex}` },
        "latest",
      ]);
      if (!root || root === ZERO_ROOT) return null;
      return root;
    } catch {
      return null;
    }
  };
}
