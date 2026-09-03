# syntax=docker/dockerfile:1.7
#
# Web app: reproducible build, test, and a production-parity smoke test.
#
# An honest note about what this image is and is not. Production is Cloudflare
# Workers — V8 isolates running workerd — NOT a Node container. So a Docker
# image that merely runs `next start` would prove nothing about production and
# would quietly pass code that workerd rejects (Node built-ins, unsupported
# APIs, oversized bundles).
#
# The runtime stage therefore boots the real OpenNext bundle under wrangler,
# which runs workerd locally. That is the same engine Cloudflare runs, so a
# green smoke test here means the worker actually starts and serves in the
# production runtime — the check `next build` and `tsc` cannot give you.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# deps — node_modules, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app
# Manifests only: a source edit must not re-resolve the dependency tree.
COPY package.json package-lock.json ./
# `npm ci` not `npm install` — it installs exactly the lockfile, so the image
# cannot silently drift to a different dependency set than CI resolved.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------------------
# test — lint, types, unit and component tests
# ---------------------------------------------------------------------------
FROM deps AS test

WORKDIR /app
COPY . .
RUN npm run lint \
 && npx tsc --noEmit \
 && npx vitest run

# ---------------------------------------------------------------------------
# build — the real production artefact
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app
COPY . .

# Inlined into the client bundle at build time; without them the deployed
# login page renders "Setup incomplete". These are the anon/publishable keys
# that ship to every browser anyway, so baking them into a layer discloses
# nothing — but the service-role key and model keys are runtime secrets and
# must NEVER be passed here.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_TELEMETRY_DISABLED=1

# This is the step that catches what tsc does not: Next.js validates route
# module exports here, and a route exporting anything outside its allowlist
# fails the build while typechecking and unit tests pass happily.
RUN npx opennextjs-cloudflare build

# ---------------------------------------------------------------------------
# runtime — the built worker under workerd, for the smoke test
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="chattobira-web" \
      org.opencontainers.image.description="ChatTobira Next.js worker, run under workerd for production-parity checks" \
      org.opencontainers.image.source="https://github.com/FOFANA459-2023/ChatTobira" \
      org.opencontainers.image.licenses="UNLICENSED"

# tini reaps the workerd child process wrangler spawns; without an init a
# stopped container leaves it behind.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# node:*-slim ships an unprivileged `node` user already; use it rather than
# minting another. Nothing here needs root.
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.open-next ./.open-next
COPY --chown=node:node package.json wrangler.jsonc ./

# wrangler writes its local state under .wrangler at boot. WORKDIR creates
# /app owned by root and COPY --chown only covers the files copied, not the
# directory itself, so the unprivileged user cannot mkdir there and workerd
# dies with EACCES the moment the container starts — a failure that no build
# step and no unit test can see. Not chowned recursively: node_modules is
# ~1 GB and already arrives owned by node.
RUN mkdir -p /app/.wrangler && chown node:node /app /app/.wrangler

USER node

ENV PORT=8787 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
EXPOSE 8787

# A container that is "up" but serving 500s is worse than one that is down,
# because nothing downstream notices. The check asks the app for a real page.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]
