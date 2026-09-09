/**
 * did:web surface (Phase 2). Serves /.well-known/did.json derived from the
 * issuer key history — the document that lets any verifier resolve
 * did:web:diplom.mn without contacting our application APIs. Static,
 * cacheable, CDN-mirrorable (stateless tier; contains public keys only).
 */
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  buildDidDocument,
  type DidWebDocument,
  type KeyHistory,
} from "@diplommn/did";
import type { ApiConfig } from "../../config.js";

export function loadLocalDidDocument(
  config: ApiConfig,
  log: { warn: (obj: unknown, msg: string) => void },
): DidWebDocument | null {
  if (!config.DID_KEY_HISTORY_FILE) return null;
  try {
    const history = JSON.parse(
      readFileSync(config.DID_KEY_HISTORY_FILE, "utf8"),
    ) as KeyHistory;
    return buildDidDocument(config.VC_ISSUER_DOMAIN, history);
  } catch (err) {
    log.warn({ err }, "failed to load DID key history — did.json disabled");
    return null;
  }
}

export function registerDidRoutes(
  app: FastifyInstance,
  didDocument: DidWebDocument | null,
): void {
  if (!didDocument) return;
  app.get("/.well-known/did.json", async (_request, reply) => {
    reply
      .header("cache-control", "public, max-age=3600")
      .type("application/did+json");
    return didDocument;
  });
}
