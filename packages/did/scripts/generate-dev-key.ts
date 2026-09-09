/**
 * DEV-ONLY issuer key + did:web artifacts.
 *
 * Generates a P-256 keypair (matches what a managed KMS will provide in
 * production), then derives dev/key-history.json and dev/did.json from it.
 * The private key never leaves packages/did/dev/ (gitignored). In production
 * the private key lives only in KMS/HSM — the same builders run against the
 * KMS *public* key and a real kmsKeyRef instead.
 *
 * Usage: pnpm --filter @diplommn/did generate:dev [--domain diplom.mn] [--force]
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Cryptosuite,
  KeyStatus,
  buildDidDocument,
  didWebDocumentUrl,
  didWebFromDomain,
  publicKeyMultibaseFromJwk,
  type KeyHistory,
} from "../src/index.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const domainFlag = args.indexOf("--domain");
const domain =
  domainFlag >= 0 && args[domainFlag + 1] ? args[domainFlag + 1]! : "diplom.mn";

const outDir = path.join(import.meta.dirname, "..", "dev");
const privateKeyFile = path.join(outDir, "dev-signing-key.jwk");

if (existsSync(privateKeyFile) && !force) {
  console.error(
    `Refusing to overwrite existing dev key at ${privateKeyFile} (use --force)`,
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicJwk = publicKey.export({ format: "jwk" });
const privateJwk = privateKey.export({ format: "jwk" });

const did = didWebFromDomain(domain);
const now = new Date().toISOString();

const history: KeyHistory = {
  issuer: did,
  updated: now,
  keys: [
    {
      keyId: "issuer-1",
      type: "P-256",
      cryptosuite: Cryptosuite["P-256"],
      publicKeyMultibase: publicKeyMultibaseFromJwk(publicJwk),
      validFrom: now,
      validUntil: null,
      status: KeyStatus.Active,
      kmsKeyRef: null,
    },
  ],
};

const didDocument = buildDidDocument(domain, history);

await mkdir(outDir, { recursive: true });
await writeFile(privateKeyFile, `${JSON.stringify(privateJwk, null, 2)}\n`, {
  mode: 0o600,
});
await writeFile(
  path.join(outDir, "key-history.json"),
  `${JSON.stringify(history, null, 2)}\n`,
);
await writeFile(
  path.join(outDir, "did.json"),
  `${JSON.stringify(didDocument, null, 2)}\n`,
);

console.log("⚠ DEV-ONLY artifacts written to packages/did/dev/ (gitignored):");
console.log(`  did:              ${did}`);
console.log(`  serve did.json at ${didWebDocumentUrl(domain)}`);
console.log(`  key:              issuer-1 (P-256, ${Cryptosuite["P-256"]})`);
console.log(`  publicKey:        ${history.keys[0]!.publicKeyMultibase}`);
console.log("Production keys are generated inside KMS/HSM, never on disk.");
