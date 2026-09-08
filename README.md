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

## Security posture (MVP)

- Staff auth: invitation → own password (argon2id) + TOTP MFA. Admins never set passwords.
- All authorization server-side (RBAC + institution scoping). Submitter ≠ approver, enforced in DB transactions.
- Audit log is append-only and hash-chained; integrity verifiable via API.
- Certificate IDs are cryptographically random (Crockford base32, 100 bits) — no enumeration, exact-match lookup only, rate-limited.
- Issued credential records are immutable; corrections go through lifecycle cases and replacement credentials.
- No secrets in source. Configuration via environment only.
