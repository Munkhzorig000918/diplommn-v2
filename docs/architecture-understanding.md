# diplom.mn v2 — Consolidated Architecture Understanding

> Derived from the two supplied source-of-truth documents, read in full on 2026-09-08:
>
> 1. **System architecture** — `~/Downloads/diplom-mn-v2-system-architecture(1).docx` (v2.0 target architecture, Mongolian). Supersedes prior documents; explicitly replaces the MVP-era "private/permissioned PoA blockchain" clause with **public Ethereum L1 anchoring + W3C VC/DID**.
> 2. **UI/UX design system & website planning** — `~/Downloads/D2V2.pdf` (63 pages, dated 2026-08-21, Mongolian). Status: *planning only — no frontend implemented yet*.
>
> This document is a faithful consolidation, not a redesign. Gaps are labeled as gaps; assumptions are labeled as assumptions.

## 1. System architecture (summary)

diplom.mn v2 is **trust infrastructure for digital academic credentials in Mongolia**, not a generic Web3 platform. Two layers exist by design:

- **MVP (separate technical spec, the centralized foundation):** QR + random Certificate ID verified against the database; OTP portal login; CSV import; audit log; revoke/reissue. No blockchain, no VC, no DID.
- **V2 (target, this architecture):** layers a trust/proof stack **on top of the MVP without rewriting it**: W3C Verifiable Credentials 2.0, single issuer DID `did:web:diplom.mn`, salted per-VC hashes batched into a **daily Merkle root anchored on Ethereum L1**, an open-source **stateless public verifier**, e-Mongolia/ДАН holder auth, and HEMIS HMAC attestation.

Core goals: (a) anyone can verify a document's authenticity **without contacting diplom.mn servers**; (b) **no data/PII on-chain — hashes only**; (c) 50+ year credential durability; (d) holders see/share all their credentials from one portal.

Architecture principles: data off-chain (NDC); diplom.mn = root of trust (for now); one issuer DID; hash-anchor only; open verifier; **handover-ready** (issuer ownership transferable to БЕГ/ministry later); hardening-by-default (salts, mTLS, separation of duties, crypto-agility).

## 2. Main components

**Off-chain (hosted at NDC):**
- **HEMIS adapter** — validates education data against HEMIS API at issuance time; receives an **HMAC attestation (timestamp + nonce)** in response (decision "D1"). The sole authority on "is this record real".
- **Issuer service** — builds W3C VC, signs inside HSM/KMS under `did:web:diplom.mn`.
- **Off-chain store** — full VC + PII in NDC PostgreSQL/object storage; computes a **salted hash** per VC.
- **Anchor service** — daily Merkle root from the day's hashes → single Ethereum L1 transaction.

**On-chain (Ethereum L1, public):**
- **AnchorRegistry** — minimal (~50–100 lines Solidity), **immutable, NOT upgradeable**, stores only daily Merkle roots. No PII.
- **KeyRegistry** — explicitly **deferred**; if needed later, a separate immutable contract. Do not build now.

**Client layer:**
- **Holder portal** — MVP: OTP; V2: e-Mongolia/ДАН; view/download/share all own VCs via QR/link.
- **Public verifier** — open-source, stateless, no login, statically hostable by third parties; recomputes hash, checks Merkle proof, DID signature, status.

## 3. Technology stack

| Layer | Technology |
|---|---|
| Credential format | W3C Verifiable Credentials 2.0 |
| Issuer identity | `did:web:diplom.mn` (single issuer; institution is a VC field, **not** its own issuer) |
| Signatures | DataIntegrityProof (ECDSA/EdDSA), keys in HSM/KMS; `hashAlg`/`sigAlg` recorded in VC (crypto-agility) |
| Revocation | W3C Bitstring Status List — **off-chain hosted + hash-anchored** (not on-chain) |
| Anchor | Ethereum L1, immutable AnchorRegistry (Solidity) |
| HEMIS boundary | mTLS + HMAC/PSK-signed responses (D1) |
| Storage | NDC: PostgreSQL + object storage (PDFs) |
| Backend | Node/TypeScript (existing stack) |
| Queue/cache | Redis (sessions, rate limits, job queue); worker for PDF/QR/anchor/notifications |
| Portal auth | MVP: OTP → V2: e-Mongolia/ДАН |
| Verifier | Open-source TS/JS, statically hostable |
| Hosting | NDC Tier 3 (data sovereignty) + domestic DR; stateless/public layers may use AWS/CDN |
| References | OpenAttestation / Blockcerts / EBSI |

Explicitly **not** in scope: Kubernetes (over-engineering at this load), upgradeable contracts, on-chain status list, HEMIS running any blockchain/DID infrastructure.

## 4. Blockchain architecture & ADRs

- **ADR-1** Public chain over private/permissioned (single-operator PoA = "slow database", no public verifiability).
- **ADR-2** Ethereum L1 directly (Polygon rejected; dual-chain checkpointing adds cross-chain fragility).
- **ADR-3** HEMIS HMAC attestation (D1) closes the insider "did HEMIS really validate this?" hole. Requires only mTLS/HMAC support from HEMIS — no blockchain on their side.
- **ADR-4** Blockchain's role = **public tamper-evident timestamping (notarization) only**. On-chain work is one hash per day. "A VC system that uses blockchain for one thing", not a blockchain platform.

Transaction reliability: anchoring is asynchronous; per-credential anchor states `NOT_ELIGIBLE → AWAITING_BATCH → BATCHED → SUBMITTED → CONFIRMED / FAILED → (retry, idempotent, nonce-checked) / REANCHORED`. Each VC stores `chainId`, contract address, tx hash, block number. If Ethereum/RPC is down, credentials still issue with "public proof pending".

## 5. On-chain vs off-chain data

- **On-chain:** daily Merkle root only. Nothing else. Ever.
- **Off-chain (NDC):** full VC, PII, student records, institutions, programs, PDFs, QR/share data, admin data, audit logs, status lists (with their hash anchored).
- Salted leaf hashes prevent low-entropy guessing of anchored values; salt values are never displayed even to admins.

## 6. User roles (R1–R10)

1. **R1 Public verifier** — no account; verify only.
2. **R2 Credential holder** — own credentials: view/download/share, revoke own share links.
3. **R3 Issuance operator** — intake/import, trigger HEMIS validation, fix draft data, submit; **cannot approve**.
4. **R4 Issuance approver** — independently reviews evidence, approve/return/reject; **cannot silently edit submissions; cannot self-approve**.
5. **R5 Credential lifecycle admin** — revocation/correction/reissue cases; dual-control proposed.
6. **R6 Institution-scoped manager** — *conditional*: tenancy model is an open gap; keep feature-flagged.
7. **R7 Platform admin** — users/roles/scopes/config; **no issuer-key authority, no default credential access**.
8. **R8 Technical operations admin** — integrations, queues, anchor batches, safe idempotent retries; **cannot modify credential data or approve**.
9. **R9 Security/key custodian** — key lifecycle, rotation ceremonies (dual-control/m-of-n), DID/key history; never sees raw key material.
10. **R10 Auditor** — read-only, purpose-limited, PII-masked; export is a separate audited permission.

Permission principles: submitter ≠ sole approver; signed/issued claims are immutable in UI; corrections spawn linked replacement flows; server-side enforcement only (hiding UI ≠ authorization); break-glass access requires purpose, time limit, strong auth, notification, and audit.

## 7. Organization model

- Institutions (universities) are **attributes/trusted-source references on credentials, not independent issuers** — one issuer DID for the platform.
- A "validation source registry" maps credential type → authoritative source (HEMIS / school / issuer).
- Direct institution user accounts/tenancy are **not defined by the architecture** (gap #2); scoped-access plumbing should exist (Own / Institution / Assigned-queue / Global scopes) but institution-manager features stay behind a flag until governance confirms.
- Tenant boundaries must be enforced on every scoped API regardless.

## 8. Credential lifecycle (separate status dimensions — never one mega-status)

- **Lifecycle:** `DRAFT → PENDING_APPROVAL → (RETURNED | REJECTED) | APPROVED → ISSUED → REVOCATION_PENDING → REVOKED`, plus `SUPERSEDED` (replacement issued) and optional `CANCELLED` for unsubmitted drafts. **No `EXPIRED`** — architecture defines no credential expiry.
- **Source validation:** `NOT_CHECKED → CHECKING → MATCHED | MISMATCH | ATTESTATION_INVALID | UNAVAILABLE | STALE` (attestations have freshness policies; stale evidence blocks approval).
- **Processing stages (worker jobs):** `QUEUED, SIGNING, STORING, GENERATING_PDF, GENERATING_QR, PUBLISHING_STATUS, NOTIFYING, COMPLETE`; each job: pending/processing/success/failed/retrying/dead-letter. Job status never replaces lifecycle status.
- **Anchor status:** `NOT_ELIGIBLE, AWAITING_BATCH, BATCHED, SUBMITTED, CONFIRMED, FAILED, REANCHORED`.
- **Share status:** `ACTIVE, EXPIRED, REVOKED, UNAVAILABLE` (independent of credential validity).

## 9. Issuance flow

Intake (operator form / CSV import / API) → HEMIS adapter validates + returns HMAC attestation → operator reviews match, accepts authoritative values (HEMIS fields read-only, provenance-chipped: HEMIS/Import/API/Operator/System) → submit (immutable submission snapshot) → **independent approver** reviews diff + attestation evidence → approve → issuer service creates VC, signs via HSM/KMS → full VC + PII stored in NDC, salted hash computed → worker generates PDF/QR artifacts → credential ISSUED/shareable → hash joins daily anchor batch → Ethereum tx confirmed → publicly anchored. Idempotency guards prevent double-issue after retries. CSV: per-row progress, valid rows proceed, failed rows exportable/fixable — one bad row never silently rolls back the batch.

## 10. Signing flow

Signing is isolated from the app server (separation of duties): authenticate signer context → verify credential is in signable state (APPROVED) → canonical VC representation → salted hash → sign inside HSM/KMS under did:web key → persist signing metadata (key ID, algorithms, timestamps) → status ISSUED → queue for anchoring. Key custody: HSM/KMS, rotation, m-of-n where possible; key rotation is a ceremony (multi-step approval, DID history publication, valid-at-time verification preserved). Rate-limited issuance; approval workflow mandatory; no operator ever selects algorithms.

## 11. Verification flow

Verifier accepts QR / share URL / full VC file / (MVP path) Certificate ID — no login. Checks: (1) recompute salted hash, verify Merkle proof against on-chain root — content unchanged + anchor date; (2) resolve `did:web:diplom.mn`, verify signature **with key valid at issuance time**; (3) verify HEMIS HMAC attestation where applicable; (4) resolve Bitstring Status List — not revoked. Results: **VALID / REVOKED / NOT_VALID / INDETERMINATE**. "Not found" is never conflated with "invalid"; network/status-list unavailability is never presented as fraud. Explorer link is optional supplementary proof. Public results never support name lookup; registration numbers masked/omitted; URLs use random non-sequential IDs, no PII in query strings, no search-engine indexing.

## 12. HEMIS integration

HEMIS = external source of truth reached through an adapter/integration layer only. HEMIS does **not** run blockchain/DID/crypto infrastructure. Boundary hardening: mTLS + HMAC/PSK-signed responses with timestamp + nonce (D1), anomaly detection. Attestation evidence (reference, timestamps, match results, field diffs) is stored per credential and shown in approval UI. Mismatch blocks issuance (default-block; any exception path needs stronger evidence + dual approval — gap #9). Chain: HEMIS → validation/integration layer → diplom.mn → issuance → anchoring → verification.

## 13. Database / domain model

Core entities: Holder identity (1 → 0..n credentials); **Credential** (type/schema version; institution; one authoritative source-validation event incl. HEMIS attestation; one signed VC + 0/1 PDF artifact; current lifecycle status + status-list index; 0..n share links/QR presentations; 0..n verification events (privacy-limited); 0..n lifecycle events; anchor-batch membership after anchoring); **Anchor batch** (many salted hashes, one Merkle root, 0/1 successful Ethereum tx + retry attempts); **Institution** (on many credentials; operator accounts proposed but undecided); **User** (roles + optional institution scope; generates append-only audit events); lifecycle cases (revoke/correct/reissue) linking old ↔ replacement credentials. Audit log: append-only, hash-chained (this is the basis for anchoring). No hard delete of issued credentials anywhere; deactivate/version instead.

## 14. API architecture

Services are defined, but **API contracts are deliberately not specified yet** (endpoint paths in the design doc are placeholders). Requirements: predictable resource-oriented naming, versioning where appropriate, server-side validation/authz on everything, consistent error taxonomy (validation / authorization / not-found / conflict / server; for blockchain ops additionally submission failure / confirmation failure / timeout / unknown), idempotency keys for issuance and API intake, rate limiting, no stack traces to clients. API-originated issuance (client registration, auth, webhooks, quotas) is an open gap (#22) — UI for it is exception-tracing only.

## 15. Frontend architecture

**Four deliberately separated surfaces:** Public verifier (mobile-first, no login), Holder portal (light, wallet-metaphor, bottom-nav mobile), Issuance operations console (dense admin), System administration console (technical ops/security).

- **79 screens: 31 P0, 39 P1, 9 P2.** ID families: PUB/VER/AUTH (public+auth), HOLD (holder), DASH/CRED/ISS (ops), IMP/APR (import/approval), LIFE (lifecycle), OPS/INT/JOB/ANC/SEC/ADM/CFG/INST (system admin), AUD/REP/NOT/HELP.
- **Visual direction: B — "modern digital government"**: formal deep blue, neutral surfaces, evidence-driven status components; direction-A formality on public trust surfaces, direction-C density in technical ops. One token/component semantics across all surfaces.
- **Design tokens:** primary `#174E8C` (hover `#123F73`, active `#0D315A`, subtle `#EAF2FB`); background `#F6F8FB`; surfaces `#FFFFFF` / `#EEF2F6` / inverse `#142235`; text `#17202B` / `#4E5D6C` / disabled `#7A8795`; border `#C8D1DC`, divider `#E2E7ED`; focus `#0B6FD3` (3px ring); success `#167647`/`#E8F5EE`; warning `#8A4B08`/`#FFF3D6`; error `#B42318`/hover `#8F1D15`/`#FDECEA`; info `#0B63A5`/`#E7F2FA`; neutral `#5B6875`/`#EEF1F4`. Chart palette: `#2368A2 #147D7E #6750A4 #B65C0A #65758B` (status colors reserved for status semantics). WCAG 2.1 AA minimum.
- **Typography:** Noto Sans (MN Cyrillic + EN coverage), Noto Sans Mono only for hashes/tx/correlation IDs. Scale: Display 32/40·700, H1 28/36·700, H2 22/30·700, H3 18/26·600, Body-lg 16/24, Body 14/22, Body-sm 13/20, Label 14/20·600, Caption 12/18, Table 13/20, Table-header 12/18·600, Mono 12/18. Min body 14px; public verification default 16px; tabular numerals for KPIs.
- **Spacing:** 4px scale (4…64). Admin density 8/12/16; public/holder 16/24/32. Radius: 4/8/12/full (status dots+avatars only). 1px dividers over elevation; shadow-sm `0 1px 2px rgba(16,24,40,.08)`, shadow-md `0 8px 24px rgba(16,24,40,.14)` (modals/drawers only). Motion 120–180ms (hover/menu), 180–240ms (drawer/modal), respect `prefers-reduced-motion`.
- **Layout:** admin shell — sidebar 248px/72px collapsed, header 64px, content fluid ≤1600px (reading 960–1120px), 12-col/24px grid. Public/holder max 1200px; verification flow 760–900px reading width. Forms: single 720–840px column + optional 320–400px evidence panel. Breakpoints: 320–599 / 600–1023 / 1024–1279 / 1280–1599 / 1600+.
- **Tables:** server-side search/filter/sort, pagination default 25, sticky header + first ID column, per-user column picker, filter chips, scoped exports (audited, masked); **no bulk approve/revoke/delete by default**; row actions explain why disabled.
- **Page-state contract** for every data screen: skeleton initial load (keep page frame), background-refresh indicator, true-empty vs filtered-empty, partial error (keep healthy widgets), permission-denied (no metadata leak), not-found (don't distinguish missing vs unauthorized publicly), stale-data labeling, async-accepted (ID + stage + navigate away + notify).
- **diplom.mn-specific components:** credential lifecycle status, credential summary (holder-safe / operator-dense / public-minimal variants), source provenance chip (HEMIS/Import/API/Operator/System), HEMIS match panel with field diffs, verification result + four-check evidence rows, public proof status, anchor tx panel, document card, QR share card, lifecycle relation (old↔replacement), approval evidence panel, audit row/diff, integration health row, async pipeline stepper, sensitive-data reveal (permission + reason + audit).
- **Blockchain UX rules:** lay users see "Нийтийн нотолгоо / Public proof" language (Publicly anchored / Awaiting daily proof / Proof delayed / Re-anchored); chain ID/contract/tx/block/Merkle details only for technical roles; **never** say a diploma or personal data is "on the blockchain"; never display salts, raw PII, signing or HMAC secrets.
- **i18n:** Mongolian primary + English from the first frame; status codes stable internally, every label/description localized; components tested at 130–150% English label length and long MN institution names; dates 2026.08.20 (MN) / 20 Aug 2026 (EN); technical timestamps `YYYY-MM-DD HH:mm:ss` + TZ (ops default Asia/Ulaanbaatar; Ethereum timestamps keep UTC); IDs/hashes/DIDs never localized; signed VC claims keep official source-language values — UI translation never silently machine-translates signed claims.
- **Accessibility:** WCAG 2.1 AA (2.2 focus/target-size where possible), full keyboard operation, 44×44px touch targets, icon+text+semantic color (never color alone), 200% zoom/reflow, accessible tables/dialogs/drawers, screen-reader language switching MN/EN.

## 16. Security model

- AuthN: holders via OTP (MVP) → e-Mongolia/ДАН (V2); staff auth/MFA/SSO **not defined** (gap #3 — recommendation: centralized staff identity + phishing-resistant MFA).
- AuthZ: RBAC + scopes (Own/Institution/Assigned-queue/Global), server-enforced; export as separate permission; audit on all sensitive actions with reason capture and re-auth for privilege changes.
- Signing keys: HSM/KMS only, rotation ceremonies, valid-at-time verification, single deterministic key source (did:web vs any future on-chain mirror must have ONE source of truth).
- Hash salting per leaf; crypto-agility fields in each VC; append-only hash-chained audit log (integrity mismatch = critical security event: freeze affected-range claims, alert security/auditor, never "dismiss permanently").
- HEMIS boundary: mTLS + HMAC + anomaly detection. Rate limiting + anomaly detection on public endpoints (no enumeration: exact random IDs only, no partial matches, no existence leaks).
- Never in source code: secrets, private keys, API keys. Never in UI/telemetry/QR/URLs: PII beyond policy, salts, secrets.

## 17. Infrastructure / deployment

- **Sensitive tier** (PII + issuer service + signing keys): NDC primary (Tier 3, ~99.98%) + **domestic** DR (another Mongolian DC — Mobicom/Mogul/S-Systems etc.). No foreign DR — data sovereignty / Mongolian Personal Data Protection Law (2022). AWS must not mirror PII databases.
- **Stateless/no-secret tier** (open verifier, /verify page, status-list mirror, public-field read cache): freely hostable on AWS/CDN.
- **Outage behavior:** NDC down ⇒ new issuance + portal pause (queued, resume on recovery); verification of already-issued credentials **continues** (verifier reads Ethereum + the VC in the user's hand). Availability ≠ integrity.
- **Sizing** (~20,000 docs/yr ≈ 55 issuances/day; verification-read dominated, a few req/s): 2× app (2vCPU/4GB), PostgreSQL + replica (2–4vCPU/8GB/100GB SSD), Redis (1vCPU/1–2GB), worker (2vCPU/4GB), 100GB object storage (+10–20GB/yr), managed KMS. Total ≈ 8–12 vCPU / 20–30GB RAM. **No Kubernetes.**
- **Costs** (AWS-approx): ~$300–450/mo infra; Ethereum gas ~$400–1,800/yr (1 tx/day); contract audit one-time ~$2–6k (small scope); avoid CloudHSM (+$13k/yr) — start with managed KMS.
- **Implementation phases:** Phase 0 (did:web, KMS keys, AnchorRegistry, crypto-agility schema — 2–3 wks) → Phase 1 (VC create/sign, HEMIS D1, salt hashing, SoD, NDC, anchor — 5–6 wks) → Phase 2 (open verifier + status list — 3–4 wks) → Phase 3 (portal: e-Mongolia/ДАН, dashboard, QR/share — 4–5 wks) → Phase 4 (contract audit, immutable audit log, migration, monitoring, handover mechanism, launch — 4–6 wks). Total ~5–6 months.

## 18. Important assumptions (labeled)

- "дх" in the phase table = weeks (долоо хоног) — consistent with the ~5–6 month total.
- The MVP technical specification is a **separate document not yet provided** — MVP feature references (FR-V05 random cert IDs, PDF integrity, OTP, CSV import) come from the v2 docs' cross-references only.
- No Figma file, existing source code, API docs, or DB schemas have been provided yet — the design doc itself states endpoint paths are placeholders and VC claim schemas are pending.
- Node/TS is stated as "current stack"; no specific frameworks (Next.js, Nest, ORM, etc.) are mandated by either document — framework choice must be confirmed at implementation time.
- MVP-first build order is implied (architecture §16: v2 grows on the MVP; don't rewrite it), and the MVP must be built Phase-2-ready: append-only hash-chained audit log from day one; compute certificate/PDF hashes in MVP; random certificate IDs/QR; VC-mappable data model.

## 19. Architecture gaps (34 open questions, D2V2 §37 — decisions needed, not to be invented)

- **Data contracts:** exact VC/claim schemas per credential type (#1); HEMIS API fields, match rules, HMAC canonicalization, freshness (#6); bilingual canonical institution/credential names (#31); public claims disclosure policy (#19).
- **Identity & tenancy:** institution tenancy/user ownership (#2); staff auth & MFA (#3); holder↔credential identity matching (#4); OTP's role and recovery in V2 (#5).
- **Workflow policy:** non-HEMIS credential types' source evidence (#7); approver scoping national vs institutional (#8); no-HEMIS-record exception process — default block (#9); "degraded" health thresholds (#10); revocation reason taxonomy/effective dates/reversibility (#15); correction/reissue ordering & old-credential status transitions (#16); support/fraud reporting workflow (#30).
- **Blockchain ops:** daily anchor cutoff timezone + confirmation/reorg thresholds (#11 — suggested: Asia/Ulaanbaatar cutoff, store UTC); pre-anchor verification claims policy — "Issued; public proof pending" (#12); RPC redundancy, gas wallet custody, retry/replace policy (#13); status-list publication/mirror freshness & outage policy (#14); re-anchor triggers & future chain migration (#28).
- **Artifacts & sharing:** share-link capabilities, expiry, selective disclosure (#17); printed QR capacity & 50-year URL strategy (#18); PDF generation/templates/legal signature status (#21); PDF/QR print accessibility standards (#32).
- **Platform:** API client registration/auth/webhooks/quotas (#22); notification providers & event matrix (#23); audit event schema, retention, PII masking, anchoring cadence (#24); data retention/deletion rights vs immutable public roots (#25); DR RPO/RTO & failover authority (#26); key rotation/m-of-n/handover governance (#27); MVP→V2 record migration labeling — "MVP database-verified" vs "V2 independently verifiable" (#29); environment isolation & production change approval (#33); public verifier OSS distribution/update trust (#34); verification telemetry retention (#20).

## 20. Potential technical risks

| Risk | Level | Mitigation per architecture |
|---|---|---|
| Institutional ownership (private operator = national trust root) | Highest | Build handover mechanism now; legal basis for БЕГ/ministry transfer |
| HEMIS-trust gap (insider fake issuance) | High | D1 HMAC attestation + separation of duties + audit log |
| Issuer key compromise | High | HSM/KMS, rotation, m-of-n where possible |
| Chain longevity | Medium | Ethereum L1 + crypto-agility + periodic re-anchoring |
| did:web takeover | Medium | Single key source + future on-chain key mirror |
| Hash/PDPL privacy | Medium | Salted leaves; only root goes on-chain |

Additional engineering risks: dual-language complexity is pervasive (test early, not last); the many independent status dimensions require disciplined modeling to avoid UI/state drift; the asynchronous issuance pipeline (sign → store → PDF → QR → status → anchor) needs idempotency keys and dead-letter handling from the first line of worker code; the MVP must not paint itself into a corner on audit-log structure and hash computation.
