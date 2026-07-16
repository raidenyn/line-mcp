# syntax=docker/dockerfile:1
#
# Workspace-aware multi-stage build for the modular LINE MCP monorepo.
#
# Two runtime targets:
#   * server   — the fully composed server (ten tools, eleven resources).
#                `docker build --target server .`   (Compose default)
#   * line-mcp — the standalone messenger-only server (five tools).
#                `docker build --target line-mcp .`
#
# Both targets share ONE builder stage that runs `npm ci` + the composite
# `tsc -b` once, then prunes dev dependencies. The runtime stages copy only the
# pruned production `node_modules` (which already carries better-sqlite3's
# glibc-built native addon) plus each target's own compiled package closure.

# ─── Builder: full toolchain, builds all six workspace packages ──────────────
FROM node:24 AS builder
WORKDIR /app

# Copy the root manifest + lockfile and EVERY workspace manifest before any
# source, so the dependency-install layer is keyed on manifests alone and only
# busts when a package.json or the lockfile changes — not on every source edit.
COPY package.json package-lock.json ./
COPY packages/line-client/package.json         packages/line-client/package.json
COPY packages/line-client-sqlite/package.json  packages/line-client-sqlite/package.json
COPY packages/mcp-runtime/package.json         packages/mcp-runtime/package.json
COPY packages/line-mcp/package.json            packages/line-mcp/package.json
COPY packages/bank-mcp/package.json            packages/bank-mcp/package.json
COPY packages/server/package.json              packages/server/package.json

# Installs every workspace's deps (prod + dev) and compiles better-sqlite3's
# native addon against this stage's glibc + Node 24 ABI.
RUN npm ci

# Sources + TS project config, then one composite build across all six packages.
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# Reduce the installed tree to production dependencies only. The compiled
# better-sqlite3 addon is a production dependency (of line-client-sqlite and
# bank-mcp) and survives; typescript/vitest/eslint/ts-node/@types do not.
RUN npm prune --omit=dev

# Strip everything the runtime never loads from each package directory
# (TypeScript sources, test files, build info, pack-time helper scripts),
# leaving only package.json + dist/ + assets/ + docs/.
RUN find packages -type d -name src -prune -exec rm -rf {} + \
 && find packages -type d -name scripts -prune -exec rm -rf {} + \
 && find packages -name '*.tsbuildinfo' -delete \
 && find packages -name 'tsconfig*.json' -delete

# ─── Shared runtime base ─────────────────────────────────────────────────────
# node:24-slim is Debian (glibc), matching the builder, so the prebuilt
# better-sqlite3 native addon copied from the builder loads without rebuilding.
FROM node:24-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV BASE_PATH=/

# Pruned production node_modules (includes the compiled better-sqlite3 addon
# and the workspace symlinks under node_modules/@raidenyn/*).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000

# Healthcheck via Node's own http client (Debian slim ships no wget/curl).
# Mirrors the server's `${normalizeBasePath(BASE_PATH)}/healthz` route.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "let p=process.env.BASE_PATH||'';let bp=p.replace(/\/+$/,'');if(bp&&!bp.startsWith('/'))bp='/'+bp;require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:bp+'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER node

# ─── Target: composed server (ten tools) ─────────────────────────────────────
# Depends on all six packages, so the whole pruned packages/ tree is copied.
FROM runtime-base AS server
COPY --from=builder /app/packages ./packages
CMD ["node", "packages/server/dist/cli.js"]

# ─── Target: standalone messenger server (five tools) ────────────────────────
# Copies ONLY line-mcp's own runtime closure (line-mcp + line-client +
# line-client-sqlite + mcp-runtime); bank-mcp and server are never present.
FROM runtime-base AS line-mcp
COPY --from=builder /app/packages/line-client         ./packages/line-client
COPY --from=builder /app/packages/line-client-sqlite  ./packages/line-client-sqlite
COPY --from=builder /app/packages/mcp-runtime         ./packages/mcp-runtime
COPY --from=builder /app/packages/line-mcp            ./packages/line-mcp
CMD ["node", "packages/line-mcp/dist/cli.js"]
