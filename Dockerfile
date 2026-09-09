# diplom.mn v2 — one build, three run targets (api / worker / web).
# The stated load (~55 issuances/day) needs no Kubernetes: these images run
# under docker compose on one or two VMs (docker-compose.prod.yml).
#
# Backend services run TypeScript directly via tsx (the workspace packages
# export .ts sources); the web app is built by Next.js at image build time.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Install with a warm, deterministic store.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- api
FROM base AS api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "@diplommn/api", "start"]

# ---------------------------------------------------------------- worker
FROM base AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@diplommn/worker", "start"]

# ---------------------------------------------------------------- web
FROM base AS web
# NEXT_PUBLIC_* values are inlined at build time.
ARG NEXT_PUBLIC_API_URL=https://diplom.mn
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NODE_ENV=production
RUN pnpm --filter @diplommn/web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@diplommn/web", "start"]
