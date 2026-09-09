# diplom.mn v2 — one build, three run targets (api / worker / web).
# The stated load (~55 issuances/day) needs no Kubernetes: these images run
# under docker compose on one or two VMs (docker-compose.prod.yml).
#
# Layering is deliberate so unrelated edits don't churn images:
#   deps     — manifests only → pnpm install (cache survives source edits)
#   backend  — deps + packages/* (shared workspace code)
#   api      — backend + apps/api        } an apps/web edit leaves the
#   worker   — backend + apps/worker     } api/worker image hashes
#   web      — backend + apps/web build  } unchanged → compose won't
#                                          restart them.
# Backend services run TypeScript directly via tsx; the web app is built
# by Next.js at image build time.

FROM node:22-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Manifests only — this layer (and the install below) only invalidates
# when dependencies change, not on source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/did/package.json packages/did/
COPY packages/hemis/package.json packages/hemis/
COPY packages/notify/package.json packages/notify/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/vc/package.json packages/vc/
COPY packages/verifier/package.json packages/verifier/
RUN pnpm install --frozen-lockfile

# Shared workspace sources — common to every service.
FROM deps AS backend
COPY packages ./packages

# ---------------------------------------------------------------- api
FROM backend AS api
COPY apps/api ./apps/api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@diplommn/api", "start"]

# ---------------------------------------------------------------- worker
FROM backend AS worker
COPY apps/worker ./apps/worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@diplommn/worker", "start"]

# ---------------------------------------------------------------- web
FROM backend AS web
COPY apps/web ./apps/web
# NEXT_PUBLIC_* values are inlined at build time.
ARG NEXT_PUBLIC_API_URL=https://diplom.mn
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=production
RUN pnpm --filter @diplommn/web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@diplommn/web", "start"]
