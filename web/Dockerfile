# The one image for all three roles.
#
#   docker build -f web/Dockerfile -t voting-web:<tag> .
#
# ---------------------------------------------------------------------------
# Why the context is the repository root, and not web/
# ---------------------------------------------------------------------------
#
# pnpm-workspace.yaml and pnpm-lock.yaml live at the root. Building with a
# context of web/ would either fail --frozen-lockfile or resolve a dependency
# tree that differs from the one CI gated on. So the context is `..` from here,
# which is why every COPY path below starts at the repository root.
#
# ---------------------------------------------------------------------------
# Why one image serves web, migrate and indexer
# ---------------------------------------------------------------------------
#
# The frontend and the backend are the same Next.js process: the App Router
# serves the UI and /api/*, and the indexer reads the same event-decoding code.
# Splitting these into separate images would produce a second build of the
# decoding logic and a second place for it to drift from the schema. So the
# roles differ by `command` and `working_dir` only, and the image carries what
# all three need.
#
# That decision has a visible cost, marked at the tsx install below: the scripts
# run TypeScript at runtime, so a devDependency has to be present in the image.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install with the full lockfile, from manifests only.
#
# Only manifests are copied first. Source changes then leave this layer cached,
# which is the difference between a rebuild that reinstalls everything and one
# that only re-runs the build. Nothing here is copied into the runtime image --
# this stage exists so the build has the same dependency tree CI verified.
# ---------------------------------------------------------------------------
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/
COPY contracts/package.json contracts/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder: the Next.js build, with the public variables baked in.
#
# NEXT_PUBLIC_* is inlined into the client bundle at build time, not read at
# runtime -- so these are build arguments, and changing one requires a rebuild
# and therefore a new tag. That is why the deploy tags by git sha.
# ---------------------------------------------------------------------------
FROM base AS builder

ARG NEXT_PUBLIC_LOCAL_RPC_URL
ARG NEXT_PUBLIC_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_IPFS_GATEWAY

ENV NEXT_PUBLIC_LOCAL_RPC_URL=$NEXT_PUBLIC_LOCAL_RPC_URL
ENV NEXT_PUBLIC_SEPOLIA_RPC_URL=$NEXT_PUBLIC_SEPOLIA_RPC_URL
ENV NEXT_PUBLIC_IPFS_GATEWAY=$NEXT_PUBLIC_IPFS_GATEWAY

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY --from=deps /app/contracts/node_modules ./contracts/node_modules

COPY . .

RUN pnpm --filter @voting/web build

# ---------------------------------------------------------------------------
# runtime-deps: production dependencies only.
#
# Copied as a tree rather than taken from Next's standalone output. Standalone
# traces the modules the *server* loads, and on its own that is not enough for
# this image: `web/scripts/migrate.ts` starts from `../src/lib/config`, and
# neither web/scripts nor web/src is part of the Next build's graph, so they are
# never traced. A pnpm install produces relative symlinks, which survive being
# copied into the image -- unlike the junctions a Windows install produces, whose
# absolute targets are what broke standalone's portability in the first place.
# ---------------------------------------------------------------------------
FROM base AS runtime-deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/
COPY contracts/package.json contracts/

RUN pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

ENV NODE_ENV=production
ENV PORT=3000

# Without this, the standalone server binds to the container's hostname and is
# unreachable from outside the container -- the single most common way this
# setup appears to work while serving nothing.
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Runtime dependencies, with pnpm's relative symlinks intact.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/web/node_modules ./web/node_modules

# The built application.
#
# standalone/web/.next holds the compiled server; static assets are deliberately
# not part of standalone and have to be copied to the path the server expects, or
# every page renders without CSS and JavaScript.
COPY --from=builder /app/web/.next/standalone/web/.next ./web/.next
COPY --from=builder /app/web/.next/static ./web/.next/static
COPY --from=builder /app/web/.next/standalone/web/server.js ./web/server.js
COPY --from=builder /app/web/.next/standalone/web/package.json ./web/package.json
COPY --from=builder /app/web/public ./web/public

# The migrate and indexer roles run these directly, and they are not in the
# standalone output -- see the note on runtime-deps above.
COPY --from=builder /app/web/scripts ./web/scripts
COPY --from=builder /app/web/src ./web/src
COPY --from=builder /app/web/tsconfig.json ./web/tsconfig.json

# tsx executes the TypeScript scripts at runtime, and it is a *devDependency* --
# `--prod` above deliberately does not install it. The plan called for a global
# `npm i -g tsx`, which does not work: `node --import tsx` resolves the specifier
# from the working directory with Node's normal rules, and a globally installed
# package is not on that path (the global prefix is not searched, and NODE_PATH
# does not apply to ESM resolution). So it is installed into this image's own
# node_modules, which is where the resolution actually looks.
#
# This is the price of one image serving three roles, and it is recorded in the
# ADR that covers the tsx decision.
#
# Keep this version identical to the `tsx` devDependency in web/package.json.
# It is a second place the same version is written, so it can drift -- and it
# did: at 4.20.6 this pulled esbuild 0.25.12, whose embedded Go runtime
# (go1.23.12) carries roughly two dozen HIGH/CRITICAL Go standard library CVEs
# that the image scanner reports. 4.23.13 pulls esbuild 0.28.2, which is built
# with a Go that has those fixed. Both are already resolved in pnpm-lock.yaml,
# so this moves the image onto a tree the lockfile already describes rather than
# introducing anything new.
#
# npm itself is upgraded first, and it is the last scanner finding this image can
# fix. The four remaining HIGH entries -- brace-expansion, ip-address, tar and
# undici -- are all bundled dependencies of npm 11.19.0, which is what the base
# image ships: they live under /usr/local/lib/node_modules/npm/node_modules, and
# none of them is in our own tree. npm 12.1.0 depends on tar ^7.5.22 and carries
# the newer versions of the rest, so upgrading npm removes them.
#
# `npm install -g npm@12.1.0` rather than `@latest`: 12.1.0 declares
# engines.node "^22.22.2 || ^24.15.0 || >=26.0.0", and the base image resolves to
# node 24.21.0, which satisfies it. Pinning keeps the upgrade reviewable instead
# of letting it drift with whatever latest happens to be.
#
# This runs before the tsx install so that install uses the new npm, which also
# keeps the two in one layer.
RUN npm install -g npm@12.1.0 --no-audit --no-fund \
 && npm install --prefix /app --no-save --no-audit --no-fund tsx@4.23.13

COPY ops/indexer/entrypoint.sh /app/ops/indexer/entrypoint.sh
RUN chmod +x /app/ops/indexer/entrypoint.sh

# `next build` copies web/.env into the standalone output, so the image would
# otherwise ship whatever was in the build machine's environment file. The
# context filter cannot prevent this: the file is produced by the build, not
# taken from the context. Removing it here and asserting its absence below is
# what keeps a production .env out of a published image.
RUN rm -f /app/web/.env /app/web/.env.* \
 && test ! -e /app/web/.env \
 && echo "verified: no .env in the image"

# Fails the build, rather than the container, if the runtime dependency layout is
# not self-contained. Windows-built standalone output was not portable; a Linux
# build is expected to be, and this is the check that settles it instead of
# leaving it to be discovered in production.
WORKDIR /app/web
RUN node -e "require.resolve('mysql2/promise'); console.log('verified: mysql2/promise resolvable')"

WORKDIR /app

# The official image already provides an unprivileged `node` user. The server
# binds 3000, which is above the reserved range, and writes nothing to disk, so
# nothing here needs root at runtime.
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# CMD, not ENTRYPOINT, and the difference is load-bearing here. The compose file
# gives migrate and indexer their own `command`, and `command` replaces CMD only:
# with an ENTRYPOINT in place, those overrides would be appended as arguments to
# the web server instead of replacing it, so every role would run the web server
# and silently ignore its own command.
CMD ["node", "web/server.js"]
