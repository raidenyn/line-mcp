# Configurable Base Path Design

**Date:** 2026-07-02
**Status:** Approved

## Problem

Every route (`/mcp`, `/authorize`, `/token`, `/.well-known/*`, `/import-upload`, `/`) is hardcoded at the domain root. Running this server behind a reverse proxy that also hosts other services on the same domain (e.g. `https://tools.example.com/line-mcp/*` alongside a different app at `https://tools.example.com/other-mcp/*`) isn't possible — the app has no notion of its own path prefix, so it can't match proxied requests or generate correct absolute URLs (redirect targets, OAuth metadata, upload links).

## Goals

- All endpoints support being served under a configurable URL prefix.
- Prefix comes from a `BASE_PATH` environment variable.
- Default is `/` (root) — existing deployments are unaffected with no config change.
- Docker files set `BASE_PATH` explicitly (defaulting to `/`) so it's visible and easy to override.
- OAuth discovery (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) follows RFC 8414 / MCP auth spec placement: the path component is appended *after* the well-known segment, not used as a uniform prefix — this is the location MCP clients (including Claude Code) actually probe for a non-root issuer.

## Config & Normalization

New helper, colocated in `src/index.ts` (the only place it's called — `basePath` is computed once in `main()` and passed to `oauth.ts` as a parameter):

```typescript
function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
```

- `undefined`, `''`, `'/'` → `''` (no prefix — root behavior, byte-identical to today's routes).
- `'/line-mcp'`, `'/line-mcp/'`, `'line-mcp'` → `'/line-mcp'`.
- No further validation — same trust level as existing `PORT` / `DATA_DIR` env vars (admin-controlled, not user input).

## Route Mounting

**`src/index.ts`** — wrap the existing route registrations in an `express.Router()`, mounted at the normalized base path:

```typescript
const basePath = normalizeBasePath(process.env.BASE_PATH);
const router = express.Router();

router.get('/', ...);
router.post('/mcp', ...);
router.get('/mcp', ...);
// (import-upload route registration moves from setupOAuthRoutes into here, or
//  setupOAuthRoutes takes the router instead of app — see below)

app.use(basePath || '/', router);
```

**`src/oauth.ts`** — `setupOAuthRoutes(app, port)` changes to accept the mount target and the computed `basePath` so it can build correct absolute URLs:

```typescript
export function setupOAuthRoutes(router: Router, port: number, basePath: string): void
```

Routes moved onto `router` (mounted under `basePath` by the caller): `/authorize`, `/authorize/poll`, `/token`, `/register`, `/import-upload`.

Routes that stay on the top-level `app` (not the router), because their path must not be prefixed the same way: `/.well-known/oauth-authorization-server<basePath>`, `/.well-known/oauth-protected-resource<basePath>`.

## OAuth Discovery Routes

Registered directly on `app`, not the router:

```typescript
app.get(`/.well-known/oauth-authorization-server${basePath}`, ...);
app.get(`/.well-known/oauth-protected-resource${basePath}`, ...);
```

At root (`basePath === ''`), these are exactly today's `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` — unchanged.

## URLs Embedded in Responses

Every place that currently builds `http://localhost:${port}...` gets `basePath` folded in:

| Location | Current | New |
|---|---|---|
| AS metadata `issuer` | `base` | `${base}${basePath}` |
| AS metadata `authorization_endpoint` | `${base}/authorize` | `${base}${basePath}/authorize` |
| AS metadata `token_endpoint` | `${base}/token` | `${base}${basePath}/token` |
| AS metadata `registration_endpoint` | `${base}/register` | `${base}${basePath}/register` |
| Protected-resource metadata `resource` | `${base}/mcp` | `${base}${basePath}/mcp` |
| Protected-resource metadata `authorization_servers` | `[base]` | `[${base}${basePath}]` |
| `makeWwwAuthenticate()` `resource_metadata` | `.../.well-known/oauth-protected-resource` | `.../.well-known/oauth-protected-resource${basePath}` |
| `initiate_import` `upload_url` | `${base}/import-upload?token=...` | `${base}${basePath}/import-upload?token=...` |
| Startup log (`listening on...`, `claude mcp add ...`) | `http://localhost:${PORT}/mcp` | `http://localhost:${PORT}${basePath}/mcp` |

`makeWwwAuthenticate(port)` and `setupOAuthRoutes(...)` both need `basePath` threaded in as a parameter (computed once in `main()`).

## Docker

**`Dockerfile`** — add alongside existing envs:
```dockerfile
ENV BASE_PATH=/
```

**`docker-compose.yml`** — add:
```yaml
environment:
  - BASE_PATH=/
```

## Docs

- **README.md**: short note near the Docker/local-dev quickstart explaining `BASE_PATH` and that the `claude mcp add` URL must include the prefix when non-root.
- **CLAUDE.md**: one line in the env-var-relevant part of the architecture section (where `PORT`/`PUBLIC_URL`/`DATA_DIR` are described) noting `BASE_PATH` and its effect on `index.ts` / `oauth.ts`.

## Testing

- **Unit test** for `normalizeBasePath()`: root variants (`undefined`, `''`, `'/'`) → `''`; `'/foo/'` → `'/foo'`; `'foo'` → `'/foo'`.
- **Unit test** for a non-root `basePath`: verify AS metadata, protected-resource metadata, and `WWW-Authenticate` header contain correctly prefixed URLs (spin up the app with `BASE_PATH` set, hit the relevant routes with `supertest` or equivalent, matching this repo's existing test style).
- **e2e suite** (`npm run test:e2e`): no `BASE_PATH` set by the test harness → defaults to root → existing behavior, existing assertions unaffected. Run once after implementation to confirm no regression.
