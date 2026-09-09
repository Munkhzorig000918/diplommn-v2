# diplom.mn v2 — MVP core

Digital diploma / certificate issuance and verification platform for Mongolia.
This repository contains the **MVP core** (centralized foundation): DB-backed
verification by QR / random Certificate ID, staff issuance workflow with
separation of duties, hash-chained audit log, revoke/reissue lifecycle.
Built Phase-2-ready for the v2 trust layer (W3C VC + DID + Ethereum L1 anchoring).

See `docs/architecture-understanding.md` for the consolidated architecture
and the invariants every change must respect.

## Layout

| Path | Package | Purpose |
|---|---|---|
| `apps/api` | `@diplommn/api` | Fastify REST API — auth, RBAC, issuance workflow, audit, public verification |
| `apps/web` | `@diplommn/web` | Next.js — public verifier, holder portal, ops console (M2+) |
| `apps/worker` | `@diplommn/worker` | BullMQ worker — PDF/QR/notifications (M4) |
| `packages/db` | `@diplommn/db` | Drizzle schema, migrations, seed |
| `packages/shared` | `@diplommn/shared` | Status enums, certificate-ID utils, canonical hashing, error taxonomy |
| `packages/contracts` | `@diplommn/contracts` | Solidity AnchorRegistry (daily Merkle root anchor, Phase 0) — Hardhat 3 + viem |
| `packages/did` | `@diplommn/did` | `did:web:diplom.mn` document builder, Multikey encoding, issuer key history (Phase 0) |
| `packages/hemis` | `@diplommn/hemis` | HEMIS adapter — v1-evidenced API client, claim matching, validation evidence (Phase 1) |
| `packages/vc` | `@diplommn/vc` | W3C VC 2.0 — diploma claim schema 1.0, DataIntegrityProof (ecdsa-jcs-2019) sign/verify, Bitstring Status List (Phases 1–2) |
| `packages/verifier` | `@diplommn/verifier` | Open stateless verifier — signature + revocation + Merkle/anchor checks → VALID/REVOKED/NOT_VALID/INDETERMINATE (Phase 2) |

## Getting started

```bash
pnpm install
cp .env.example .env            # adjust if needed
docker compose up -d            # Postgres :5433, Redis :6380, MinIO :9002
pnpm db:migrate
pnpm db:seed                    # creates bootstrap platform admin + demo data
pnpm dev:api                    # http://localhost:4000
pnpm dev:web                    # http://localhost:3000
```

Run tests: `pnpm test` · Typecheck: `pnpm typecheck`

## Contracts (Phase 0)

```bash
pnpm --filter @diplommn/contracts build           # hardhat compile
pnpm --filter @diplommn/contracts test            # contract tests (in-process EVM)
pnpm --filter @diplommn/contracts deploy:local    # smoke-test deploy
pnpm --filter @diplommn/contracts deploy:sepolia  # needs funded key in packages/contracts/.env
```

`AnchorRegistry` is deliberately minimal and immutable: one fixed anchorer
address, `anchorRoot(batchId, root)` once per batch, hashes only — no PII,
no upgrade path, no owner. Batch numbering / daily-cutoff policy stays
off-chain (open decision #11). Deployment records land in
`packages/contracts/deployments/`.

Current testnet deployment (Sepolia, chainId 11155111):
[`0x189E57eA448D04D684D195BBd9642162042F2441`](https://sepolia.etherscan.io/address/0x189E57eA448D04D684D195BBd9642162042F2441)

## Issuer DID (Phase 0)

`packages/did` derives the `did:web:diplom.mn` document from an issuer key
history (ACTIVE keys sign, RETIRED keys stay resolvable for old credentials,
REVOKED keys disappear — valid-at-time verification). Production keys live
only in KMS/HSM; the builders take the KMS *public* key. For local work:

```bash
pnpm --filter @diplommn/did generate:dev   # dev P-256 key + did.json in packages/did/dev/ (gitignored)
```

In production, publish the generated document at
`https://diplom.mn/.well-known/did.json` alongside the key-history file.

## Phase 2 (in progress)

- **Bitstring Status List**: the worker publishes a signed
  BitstringStatusListCredential (revocation purpose, 131,072-slot herd
  privacy floor) after every revocation and daily at 00:10 UB; the public
  API serves it at `GET /status/:listId` (cacheable, CDN-mirrorable).
- **Anchor leaf correction**: with VCs in place the anchored leaf is the
  salted hash of the *signed VC* (architecture §2); claims-hash remains the
  fallback for kinds without a VC schema (labeled per gap #29).
- **Proof bundle**: `GET /api/v1/holder/credentials/:id/proof-bundle`
  returns the signed VC, this credential's leaf salt and the Merkle proof —
  everything an independent verifier needs offline.
- **Open verifier** (`packages/verifier`): stateless, dependency-light
  (fetch + raw JSON-RPC), injectable fetchers for did:web, status list and
  AnchorRegistry `rootOf`. Outages are never fraud (INDETERMINATE), unanchored
  credentials are VALID with "public proof pending", tampering is NOT_VALID.

## Phase 1 (in progress)

- **Anchoring**: the worker runs a daily job (00:05 Asia/Ulaanbaatar) that
  Merkle-batches the closed day's salted content hashes and anchors the root
  in AnchorRegistry (`ANCHOR_*` env; disabled when unset). Batch ids are
  YYYYMMDD of the closed UB day (open decision #11's suggestion). Idempotent:
  an on-chain root is never overwritten; a divergent root dead-letters as a
  critical integrity event.
- **VC signing**: after issuance the worker builds the diploma VC (claim
  schema 1.0 — no registration number, no GPA, no system state in signed
  claims), allocates its Bitstring Status List slot from day one, signs with
  DataIntegrityProof/ecdsa-jcs-2019 under `did:web:diplom.mn` and stores the
  VC on the credential. Dev signs with the local P-256 JWK
  (`VC_SIGNING_KEY_FILE`); production replaces the signer with KMS/HSM on an
  isolated host. JCS suite chosen so the open verifier needs no JSON-LD.
- **HEMIS**: `POST /api/v1/credentials/:id/validate-source` fetches the
  authoritative record (bearer endpoint, Basic fallback — the v1-proven
  contract against hub.esis.edu.mn), matches on degree number / registration
  number / first name, stores raw evidence as a credential event and sets the
  source-validation status. D1 HMAC attestation is a pluggable hook awaiting
  the HEMIS-side contract (gap #6). v1's leaked credentials must be
  re-provisioned — see `.env.example`.

## Security posture (MVP)

- Staff auth: invitation → own password (argon2id) + TOTP MFA. Admins never set passwords.
- All authorization server-side (RBAC + institution scoping). Submitter ≠ approver, enforced in DB transactions.
- Audit log is append-only and hash-chained; integrity verifiable via API.
- Certificate IDs are cryptographically random (Crockford base32, 100 bits) — no enumeration, exact-match lookup only, rate-limited.
- Issued credential records are immutable; corrections go through lifecycle cases and replacement credentials.
- No secrets in source. Configuration via environment only.
