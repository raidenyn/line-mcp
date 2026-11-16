## Why

Behind a TLS-terminating reverse proxy, OAuth cannot work today. Discovery metadata, token claims and the 401 challenge advertise `http://localhost:<port>`, and `/authorize` rejects every non-loopback `redirect_uri`, so a remote MCP client with an https callback cannot connect. Issue #51 reports the origin half; stale PR #76 targets a layout that no longer exists.

## What Changes

**Public origin for OAuth**
- From: issuer and resource hardcoded to `http://localhost:${port}${basePath}`; `PUBLIC_URL` only affects import upload URLs.
- To: issuer, resource and every advertised endpoint (authorize, token, register, protected-resource, challenge) derive from a validated `PUBLIC_URL` plus `BASE_PATH`; localhost only when `PUBLIC_URL` is unset. `/mcp` stays consistent with the advertised resource.
- Impact: unchanged when `PUBLIC_URL` is unset. When it is already set, tokens issued before the upgrade stop validating (the issuer changes) and clients reauthorize once; a `PUBLIC_URL` with a path is now rejected at startup (use `BASE_PATH`). Not marked as a breaking change.

**Redirect URI policy**
- From: only `http(s)://localhost|127.0.0.1`, checked at `/authorize` only.
- To: loopback plus an opt-in `OAUTH_ALLOWED_REDIRECT_URIS` allowlist (https exact URLs or origins), enforced at both `/register` and `/authorize`, failing closed. Default stays loopback-only. The login pages show the redirect host, and `/token` rejects a mismatching `redirect_uri`/`client_id` when sent.
- Impact: non-breaking by default.

**Proxy trust**
- From: import-URL fallback uses `req.protocol` and `req.get('host')` with no way to honor forwarded headers.
- To: `TRUST_PROXY` enables Express proxy trust so request-derived values honor `X-Forwarded-Proto`/`X-Forwarded-Host`; OAuth issuer, claims and the token flow never depend on `Host`.
- Impact: non-breaking; off by default.

**Docs and delivery**
- README configuration table and a reverse-proxy example (`https://mcp.example.com`) that forwards the root-level discovery paths; `docs/ARCHITECTURE.md` updated.
- The result is published as a PR image tag through the existing `publish-docker` label flow.
- Replaces PR #76; closes issue #51.

## Capabilities

### New Capabilities
- `oauth-public-origin`: how the externally advertised issuer, resource and OAuth endpoints are derived from `PUBLIC_URL` and `BASE_PATH`, and the Host-independence of the flow.
- `oauth-redirect-policy`: the configurable `redirect_uri` allowlist and its enforcement at registration and authorization.
- `proxy-trust`: the `TRUST_PROXY` setting and which request-derived values it may influence.

### Modified Capabilities

None. The existing `docker-image-publishing` requirements are unchanged; the image is published through its current PR-label flow.

## Impact

- `packages/line-mcp/src/auth/line-auth-provider.ts` (`publicEndpointConfig`, provider options), `auth/oauth-router.ts` (policy at `/register` and `/authorize`, host display, `/token` checks), new `public-url.ts`, `oauth-config.ts` and `auth/redirect-policy.ts`, `index.ts` exports, `import-service.ts` (`req.host`).
- `packages/mcp-runtime/src/host.ts` (optional `trustProxy`), `packages/line-mcp/src/standalone.ts` and `packages/server/src/server.ts` (env wiring).
- Tests in `packages/line-mcp`, `packages/mcp-runtime`, `packages/server`, and the smoke harness (`tests/support`, which currently sets `PUBLIC_URL=http://127.0.0.1:<port>` and must move to `localhost`); README and `docs/ARCHITECTURE.md`.
- No new dependencies, no data-format changes, no change to existing issued tokens for deployments that leave the new variables unset.
