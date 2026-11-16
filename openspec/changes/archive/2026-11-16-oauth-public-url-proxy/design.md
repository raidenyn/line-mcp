## Context

line-mcp runs in a container, listens on `0.0.0.0:PORT`, and is exposed by a reverse proxy at a public https URL, optionally under `BASE_PATH`. The MCP client is a remote OAuth client with an https `redirect_uri`; the user's browser reaches `/authorize` through the proxy, while the client calls `/token` server to server, possibly with a different `Host`.

Current state (verified in code):

- `publicEndpointConfig(port, basePath)` builds the single `PublicEndpointConfig` (issuer, resource, basePath, scopes). `LineAuthProvider` derives the token codec issuer/audience, the discovery documents (`oauth-router.ts`) and the `WWW-Authenticate` challenge from it. It always yields `http://localhost:PORT...`.
- `ImportService.initiate()` builds upload URLs from `PUBLIC_URL`, else `req.protocol://req.get('host')`.
- `isLoopbackRedirectUri` gates `/authorize` only; `/register` accepts anything and `client_id` is a random unstored value.
- The login page uses relative URLs and the client's own `redirect_uri`; pending codes are keyed by code; none of it reads `Host`.
- Smoke harness (`tests/support/process-harness.ts`) always sets `PUBLIC_URL=http://127.0.0.1:<port>` and the smoke helpers mint tokens/expect challenges for `http://localhost:<port>`; the issuer will now follow `PUBLIC_URL`, so the harness default must become `http://localhost:<port>`.
- Discovery routes live at the origin root, outside `BASE_PATH` (`/.well-known/oauth-authorization-server<BASE_PATH>`, `/.well-known/oauth-protected-resource<BASE_PATH>/mcp`).
- Express 5: `req.protocol` and `req.host` honor `X-Forwarded-*` only when `trust proxy` is set; `req.get('host')` never does.

## Goals / Non-Goals

**Goals:**
- One validated public origin drives issuer, resource, all advertised endpoints, the challenge and token claims; import URLs use it whenever `PUBLIC_URL` is set.
- An opt-in, fail-closed redirect allowlist enforced at `/register` and `/authorize`; loopback-only default unchanged.
- `TRUST_PROXY` controls request-derived values; the OAuth flow never depends on `Host`.
- Unchanged behavior when `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` and `TRUST_PROXY` are unset.

**Non-Goals:**
- Binding a registered `redirect_uri` to a `client_id` or persisting dynamic clients.
- Wildcard or pattern redirect entries; non-https entries other than loopback.
- Rate limiting, token-type binding or other open OAuth hardening issues (#15, #46, ...).
- Deriving the issuer from request headers.
- Changes to the Docker publish workflow.

## Decisions

1. **Single origin resolver, injected into the existing seam.** New `resolvePublicOrigin(raw, port)` in `packages/line-mcp/src/public-url.ts`; `publicEndpointConfig(port, basePath, requiredScopes, publicUrl?)` calls it. The change stays where issue #51's triage said it would: both servers pass `options.publicUrl ?? process.env.PUBLIC_URL`. Rejected: a global `getPublicOrigin()` reading `process.env` (PR #76) because it hides a dependency and complicates tests.
2. **`PUBLIC_URL` is an origin.** `https:` or `http:`; a non-loopback `http:` origin (loopback = `localhost`, `127.0.0.1`, `[::1]`) is accepted with a startup warning so existing http deployments keep starting. No userinfo/query/fragment, path empty or `/`. A path is rejected with a message pointing to `BASE_PATH`. This guarantees `BASE_PATH` is applied exactly once. Case, default port and trailing slash are normalized by `URL.origin`.
3. **Redirect policy as a small pure module.** `createRedirectPolicy(raw: string | undefined)` returns `{ isAllowed(uri): boolean }`. Loopback (`http`/`https`, `localhost`/`127.0.0.1`, any port/path) is always allowed. Allowlist entries: no-path entry = origin match; path entry = exact normalized-URL match; fragments, userinfo, wildcards, non-https entries throw. Entries with a query are exact-URL entries and compare including the query. A `*` anywhere in an entry is rejected explicitly (WHATWG `URL` would otherwise parse it inside a hostname). A candidate redirect URI with a fragment or userinfo never matches an allowlist entry. The loopback host check keeps the existing scheme restriction, so `javascript:`/`data:` can never pass. The policy instance is injected via `LineAuthProviderOptions.redirectPolicy` (default: loopback-only) into `OAuthRouterDeps`.
4. **Enforcement points.** `/authorize`: replace `isLoopbackRedirectUri` with `policy.isAllowed`, 400 with a message naming `OAUTH_ALLOWED_REDIRECT_URIS`, never redirecting to the rejected URI. `/register`: when `redirect_uris` is present it must be an array of strings all allowed, else 400 `{ error: 'invalid_redirect_uri' }`; absent `redirect_uris` is still accepted (unchanged) because `/authorize` remains authoritative. The QR login page and the account-selector page show "You will be returned to <host>" (HTML-escaped, server-rendered). `/token` rejects with `invalid_grant` a `redirect_uri` or `client_id` that is present and differs from the values stored with the code.
5. **`TRUST_PROXY` parsed once, applied in the runtime host.** `parseTrustProxy(raw)` accepts `true`/`false` (case-insensitive), a non-negative integer, or a comma-separated list of `loopback`/`linklocal`/`uniquelocal`/IP/CIDR entries that it validates itself with `node:net` (so Express never throws an unnamed error). It lives in `public-url.ts`; `McpHostOptions.trustProxy` is applied via `app.set('trust proxy', value)` before routes are mounted. `ImportService` switches `req.get('host')` to `req.host` so forwarded host is honored when trusted. With `PUBLIC_URL` set, request values are never consulted for any emitted URL.
6. **Host independence by construction.** Issuer, audience, discovery documents and challenge come only from `PublicEndpointConfig`; none read the request. Covered by a test that calls `/token` with a `Host` and `X-Forwarded-*` headers that differ from the browser leg.
7. **Fail closed on bad config, before side effects.** `resolveOAuthConfig({ publicUrl, allowedRedirectUris, trustProxy, port })` in `packages/line-mcp/src/oauth-config.ts` validates all three and returns `{ publicOrigin, explicitPublicUrl, redirectPolicy, trustProxy }`. Both servers call it as the first statement of `start()`, ahead of `bootstrapPersistence`, SQLite, secret creation and worker pools, so a bad value aborts with nothing created. Errors name the variable.
8. **Reverse-proxy routing.** Discovery paths are origin-rooted, so the documented proxy config forwards `/.well-known/oauth-authorization-server<BASE_PATH>` and `/.well-known/oauth-protected-resource<BASE_PATH>/` in addition to `<BASE_PATH>/`, and must not strip the prefix.

## Risks / Trade-offs

- [An origin entry lets anything on that origin that forwards the browser onward (open redirect, user-hosted content) capture an authorization code from an attacker-started flow; PKCE does not help because the attacker supplies the challenge, and a `client_id` is not bound to a redirect URI] → The default is empty; entries must be https; docs warn and recommend exact URLs; the login pages show the redirect host so a user can notice a foreign destination. Accepted trade-off (origin entries kept by decision).
- [`TRUST_PROXY=true` trusts any client's `X-Forwarded-*`] → Documented; the OAuth flow does not use those headers, so impact is limited to the import-URL fallback when `PUBLIC_URL` is unset; docs recommend setting `PUBLIC_URL` and a hop count instead.
- [Existing `PUBLIC_URL` values with a path now fail startup] → Previously such a value produced import URLs with the path prefixed before `BASE_PATH`; the error message states the fix. Judged rare; documented in the PR and README, not marked breaking.
- [Issuer changes when `PUBLIC_URL` is set, invalidating tokens signed for the old audience; this includes deployments that already set `PUBLIC_URL` only for import links] → Unavoidable; clients reauthorize once; documented in the README and PR text. Unset deployments are unaffected. Not marked breaking.
- [Registration remains unauthenticated and stateless] → Out of scope; the redirect allowlist is the control.

## Migration Plan

No data migration. Existing deployments with the three variables unset behave identically. To adopt: set `PUBLIC_URL` (origin only) and `BASE_PATH` if prefixed, add the client's callback to `OAUTH_ALLOWED_REDIRECT_URIS`, and set `TRUST_PROXY` only if relying on forwarded headers. Clients must reauthorize once because the token issuer/audience change. Rollback: unset the variables and restart.

## Open Questions

- When to close superseded PR #76 (proposed: on merge of the replacement, with the user's go-ahead).
- Whether to apply the `publish-docker` label after implementation (proposed: only on explicit user confirmation, since it publishes a public image).
