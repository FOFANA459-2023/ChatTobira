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
# runtime-deps — only what serving the built worker needs
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-deps

WORKDIR /app
COPY package-lock.json ./

# ONLY wrangler. The OpenNext bundle in .open-next is a self-contained
# esbuild output, so serving it needs the tool that boots workerd and
# nothing else — not the application's dependencies and emphatically not
# the test toolchain. Shipping the full tree put vitest, vite, eslint,
# typescript and playwright in a running image; vite's own copy of the
# esbuild Go binary alone accounted for 25 HIGH/CRITICAL Trivy findings
# with no bearing on anything this image does.
#
# Installed into a bare project rather than pruned out of the app's, because
# npm reconciles node_modules against package.json on every install and the
# obvious approaches fight each other:
#
#   npm prune --omit=dev && npm i --no-save wrangler  -> devDeps all return
#   npm ci --omit=dev  && npm i --no-save --omit=dev  -> wrangler is pruned
#   npm ci --omit=dev  && npm i wrangler              -> devDeps all return
#
# The version is read out of the lockfile first, so this tracks what CI
# resolved rather than drifting to whatever is latest.
RUN --mount=type=cache,target=/root/.npm \
    WRANGLER="$(node -p "require('./package-lock.json').packages['node_modules/wrangler'].version")" \
 && rm package-lock.json \
 && npm init -y > /dev/null \
 && npm install --no-audit --no-fund "wrangler@${WRANGLER}"

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
#
# npm is deleted in the same layer. Nothing here installs anything at run
# time, so a package manager is pure attack surface — and it is not
# hypothetical: 11 of the 13 remaining HIGH/CRITICAL findings against this
# image came from npm's OWN bundled dependencies (tar, pacote, sigstore,
# brace-expansion, ip-address, picomatch), none of them from anything this
# project wrote or chose. Deleting it is more honest than suppressing them.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# node:*-slim ships an unprivileged `node` user already; use it rather than
# minting another. Nothing here needs root.
WORKDIR /app
COPY --from=runtime-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.open-next ./.open-next
COPY --chown=node:node package.json wrangler.jsonc ./

# wrangler writes its local state under .wrangler at boot. WORKDIR creates
# /app owned by root and COPY --chown only covers the files copied, not the
# directory itself, so the unprivileged user cannot mkdir there and workerd
# dies with EACCES the moment the container starts — a failure that no build
# step and no unit test can see. Not chowned recursively: the copied trees
# already arrive owned by node.
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
# Invoked directly rather than through npx, which no longer exists here.
CMD ["node", "/app/node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "0.0.0.0", "--port", "8787"]
