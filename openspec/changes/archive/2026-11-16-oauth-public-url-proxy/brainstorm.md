## Design Summary

Make the OAuth surface work for a remote MCP client when line-mcp runs in a container behind a TLS-terminating reverse proxy at an arbitrary public https URL. This replaces stale PR #76 (which targets the pre-workspace `src/` layout) and closes issue #51.

**Confirmed current behavior** (both of the reported problems are real):

1. `publicEndpointConfig()` (`packages/line-mcp/src/auth/line-auth-provider.ts:38`) hardcodes `http://localhost:${port}${basePath}` as issuer and `.../mcp` as resource. Both call sites (`packages/line-mcp/src/standalone.ts:158`, `packages/server/src/server.ts:135`) ignore `PUBLIC_URL`. The same object feeds the discovery documents, the token codec's issuer/audience, and the `WWW-Authenticate` challenge, so all of them advertise localhost. `PUBLIC_URL` only reaches `ImportService`, which falls back to `req.protocol` + `req.get('host')`.
2. `isLoopbackRedirectUri()` (`oauth-router.ts:87`) accepts only `http(s)://localhost|127.0.0.1`. It is enforced at `/authorize` only. `/register` does not validate `redirect_uris` at all, and `client_id`s are random, unstored values, so a redirect URI is never bound to a client.

**Findings that shape the design**

- Everything in the auth layer already derives from the single `PublicEndpointConfig`. Fixing the issuer there fixes metadata, token claims and challenge in one place.
- The flow is already Host-independent apart from the import fallback: login page URLs are relative (`basePath + '/authorize/poll'`), the final redirect uses the client's own `redirect_uri` in browser JS, pending codes are keyed by the code alone, and token claims use the configured issuer. The Host-independence requirement therefore needs a regression test, not new mechanism.
- The only request-derived absolute URL in the system is `ImportService.initiate()` (`req.protocol://req.get('host')`). `TRUST_PROXY` is what makes this correct behind a proxy when `PUBLIC_URL` is unset.
- Express is v5: with `trust proxy` enabled, `req.protocol` and `req.host` honor `X-Forwarded-Proto` / `X-Forwarded-Host`. `req.get('host')` does not, so the import fallback must move to `req.host`.

**Design**

1. **Public origin** — new module `packages/line-mcp/src/public-url.ts`: `resolvePublicOrigin(raw, port)` returns the validated origin, or `http://localhost:${port}` when unset or blank. Validation: absolute URL; `https:` or `http:` (a non-loopback `http:` origin is accepted but logs a startup warning, so existing http deployments keep starting); no userinfo, query, or fragment; path must be empty or `/` (the path belongs in `BASE_PATH`, which is applied exactly once). Anything else throws (fail closed). `publicEndpointConfig(port, basePath, requiredScopes, publicUrl?)` uses it for issuer (`origin + basePath`) and resource (`issuer + /mcp`). `standalone.ts` and `server.ts` pass `options.publicUrl ?? process.env.PUBLIC_URL`. `ImportService` receives the same resolved value only when `PUBLIC_URL` was explicitly set.
2. **Redirect policy** — new module `packages/line-mcp/src/auth/redirect-policy.ts`: `createRedirectPolicy(raw)` parses `OAUTH_ALLOWED_REDIRECT_URIS` (comma-separated). An entry with no path is an origin and matches any `redirect_uri` with that exact origin. An entry with a path (or a query) is an exact URL and must match after URL normalization, including its query; fragments are rejected. Every entry must be `https:`; entries with userinfo, fragment, `*`, or other schemes make startup fail. **Origin entries are riskier than exact URLs** (anything on that origin that redirects onward, such as an open redirect or user-hosted page, can capture a code from an attacker-started flow, and PKCE does not prevent that because the attacker chose the challenge). They stay supported, with a documented warning, and the login pages show the redirect host to the user. `isAllowed(uri)` is true for loopback `http(s)://localhost|127.0.0.1` (always, preserving the default) or an allowlist match. The default policy with the env var unset is exactly today's loopback-only behavior. The policy is injected through `LineAuthProviderOptions.redirectPolicy` into the router.
3. **Enforcement** — at `/authorize` (400, never redirects to the offending URI) and at `/register` (400 `invalid_redirect_uri` per RFC 7591 when `redirect_uris` is present but is not an array of allowed strings). A registration without `redirect_uris` stays accepted, as today; `/authorize` is the authoritative gate. The QR login page and the account-selector page display "You will be returned to <host>" so a user can notice a foreign destination. `/token` additionally rejects (`invalid_grant`) a `redirect_uri` or `client_id` that is sent and differs from the one the code was issued for (RFC 6749 §4.1.3).
4. **Validate first** — one function, `resolveOAuthConfig`, validates `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` and `TRUST_PROXY` and runs at the very top of `start()` in both servers, before any migration, database, secret or worker is created, so a bad value aborts with no side effects.
5. **TRUST_PROXY** — `McpHostOptions.trustProxy` (new, optional) is applied with `app.set('trust proxy', …)` in `createMcpHost`. `parseTrustProxy` accepts `true`/`false` (case-insensitive), a non-negative integer hop count, or a comma-separated Express trust list (`loopback`, `linklocal`, `uniquelocal`, IPs, CIDRs), validating the list itself so a bad value names `TRUST_PROXY`; the servers pass the parsed value down and pass it down. It affects only request-derived values. Issuer, resource, token claims, discovery documents and challenges NEVER read forwarded headers or `Host`, so a server-to-server `/token` call with a different Host behaves identically.
6. **Docs and delivery** — README gets a configuration table (`PUBLIC_URL`, `BASE_PATH`, `OAUTH_ALLOWED_REDIRECT_URIS`, `TRUST_PROXY`, plus existing env vars) and a reverse-proxy example with `https://mcp.example.com` that also forwards the root-level `/.well-known/oauth-*` discovery paths (they sit outside `BASE_PATH`) and does not strip the prefix. `docs/ARCHITECTURE.md` auth-flow section is updated. The image is published by opening the PR and applying the existing `publish-docker` label, which publishes `pr-<N>` and `sha-<short>` tags to GHCR.

## Alternatives Considered

### Alternative A: Derive the public origin from forwarded headers per request
- **Approach**: Compute issuer/endpoints per request from `X-Forwarded-Proto`/`X-Forwarded-Host` (gated by `TRUST_PROXY`); no `PUBLIC_URL` needed.
- **Pros**: Zero configuration behind a well-behaved proxy.
- **Cons**: Issuer and audience in signed tokens would vary with the request, so a token minted via one hostname fails verification via another. It violates the requirement that the flow must not depend on the Host header, and a spoofed header could poison discovery documents. RFC 8414 requires a stable issuer.
- **Why not chosen**: It directly contradicts the Host-independence requirement.

### Alternative B: Rebase and extend PR #76
- **Approach**: Port its `getPublicOrigin()` onto the new package layout.
- **Pros**: Preserves prior work and attribution.
- **Cons**: It is written against `src/oauth.ts` and `src/index.ts`, which no longer exist. It covers only the issuer half and its `getPublicOrigin(port)` signature does not fit `publicEndpointConfig`. Porting it is a rewrite of every hunk.
- **Why not chosen**: A fresh change on the current layout is smaller than the port. The useful ideas (one validated origin, tests with a non-root BASE_PATH) are carried over. PR #76 is closed as superseded once the replacement PR exists.

### Alternative C: Allow any https redirect_uri by default
- **Approach**: Relax `isLoopbackRedirectUri` to accept any https URL.
- **Pros**: Works with every remote client with no configuration.
- **Cons**: Registration is unauthenticated and stateless, so any site could start an authorization flow that ends by delivering a code to an arbitrary https host. It also silently changes the default for existing deployments.
- **Why not chosen**: The requirement is opt-in via an explicit allowlist with a loopback-only default.

## Agreed Approach

Alternative-free core (single configured origin, explicit allowlist, opt-in proxy trust), as described under Design. It reuses the existing single `PublicEndpointConfig` seam, adds two small focused modules, and touches the runtime host in one line.

## Key Decisions

Calls made without asking, for the user to confirm or override:

1. `PUBLIC_URL` is an **origin only**. A non-root path is rejected at startup with a message pointing to `BASE_PATH`, so the base path is applied exactly once. (Previously a path in `PUBLIC_URL` would have been silently prefixed to import URLs; considered unlikely in use.)
2. `PUBLIC_URL` may be http for non-loopback hosts but then a startup warning is logged; this keeps existing http deployments starting (the change is not marked breaking). Once `PUBLIC_URL` is set the token issuer changes, so clients reauthorize once; this is documented, not flagged `!`.
3. Origin vs exact-URL entries in `OAUTH_ALLOWED_REDIRECT_URIS` are distinguished by whether the entry has a path. Wildcards and non-https entries are refused rather than ignored.
4. Loopback redirects stay allowed regardless of the allowlist (RFC 8252), so the allowlist only adds, never removes.
5. `/register` validates `redirect_uris` when present but still tolerates their absence; no client/redirect binding is introduced (out of scope; tokens are stateless).
6. Invalid `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` or `TRUST_PROXY` values fail startup (fail closed) rather than falling back, before any side effect.
7. Env vars are read in `server.ts` / `standalone.ts` as defaults overridable by options, matching how `PORT`/`BASE_PATH`/`PUBLIC_URL` are handled today.
8. "Publish as an image tag" means: open the PR and apply the existing `publish-docker` label (owner approval via the `ghcr-publish` environment), producing `ghcr.io/raidenyn/line-mcp-full:pr-<N>` and `line-mcp:pr-<N>` plus `sha-` tags. No workflow changes.
9. Origin entries are kept (user's decision) with a warning in the README and design, plus redirect-host display on the login pages.
10. Redirect-policy loopback matching is unchanged (`localhost`, `127.0.0.1` only); `http://[::1]` stays non-loopback there.

## Open Questions

- Should PR #76 be closed right after the replacement PR is opened, or only after it merges? Proposed: comment on it when the new PR opens, close it on merge, and only with the user's go-ahead.
- Applying the `publish-docker` label is an outward-facing action (public GHCR image). Proposed: do it only after the user confirms at the end of implementation.
