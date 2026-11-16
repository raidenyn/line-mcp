# OAuth Behind a Public URL / Reverse Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make line-mcp's OAuth work for a remote https MCP client when the server sits behind a reverse proxy at `PUBLIC_URL` (+ `BASE_PATH`), with an opt-in redirect allowlist and opt-in proxy trust.

**Architecture:** One function, `resolveOAuthConfig`, validates `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` and `TRUST_PROXY` at the very top of `start()` and feeds the existing `PublicEndpointConfig` seam, a new pure `RedirectPolicy` injected into the OAuth router, and a new optional `trustProxy` on `createMcpHost`. Nothing in the OAuth path reads request headers.

**Tech Stack:** TypeScript (CommonJS, `tsc -b`), Express 5.2, vitest, `node:net`.

**Spec:** `openspec/changes/oauth-public-url-proxy/` — `proposal.md`, `design.md`, `specs/oauth-public-origin/spec.md`, `specs/oauth-redirect-policy/spec.md`, `specs/proxy-trust/spec.md`, `tasks.md`.

## Global Constraints

- Branch `feat/oauth-public-url-proxy`; never commit to `main`; no worktrees.
- Commits: Conventional Commits (`feat|fix|refactor|test|docs|chore|ci|build|perf`), NOT marked breaking (no `!`), each ending with the attribution trailer given in the implementing session's own instructions. PR title: `feat(oauth): support public https URL behind a reverse proxy`.
- Env vars (exact names): `PUBLIC_URL`, `BASE_PATH`, `OAUTH_ALLOWED_REDIRECT_URIS`, `TRUST_PROXY`. Blank (whitespace-only) values count as unset.
- `PUBLIC_URL`: origin only, `https:` or `http:`; non-loopback (`localhost`, `127.0.0.1`, `[::1]`) `http:` is accepted with a stderr warning containing `PUBLIC_URL`; no userinfo/query/fragment; path must be empty or `/`. Other invalid → throw `Error` whose message names `PUBLIC_URL` (path case also names `BASE_PATH`).
- Allowlist entries: `https:` only; no userinfo, fragment or `*`; no-path entry = origin match, path entry = exact normalized-URL match. Loopback (`http`/`https` on exactly `localhost`/`127.0.0.1`) always allowed, unchanged; no other scheme ever.
- The `/authorize` rejection message MUST still contain the word `loopback` (existing tests assert it).
- Issuer, resource, token claims, discovery documents and the challenge never read `Host` or `X-Forwarded-*`.
- Validation happens before any side effect: `resolveOAuthConfig` is the first statement of `start()` in both servers.
- Never edit `packages/line-client/assets/ltsm/*`; never `npm publish`; never run two servers on one data root.
- Pre-PR gate: `npm run lint && npm run build && npm run test:unit && npm run test:smoke`.

## Review Focus

1. `PUBLIC_URL=https://MCP.Example.com:443/` → issuer `https://mcp.example.com`; the import upload URL uses the same normalized origin.
2. Look-alike redirects against an origin entry (`…com.evil.test`, `…com@evil.test`, `:8443`, fragment, userinfo) are all rejected.
3. Empty-string env values (docker-compose passes `""` for unset `${VAR}`): `PUBLIC_URL=`, `OAUTH_ALLOWED_REDIRECT_URIS=" , "`, `TRUST_PROXY=` behave as unset and never abort start-up.
4. `POST /register` with `redirect_uris` as a string, `null`, or containing a non-string → 400 `invalid_redirect_uri`, no `client_id`.
5. Invalid configuration aborts `start()` with nothing created in an empty data root (no `secret`, no DB, no migration pointer).
6. `TRUST_PROXY=yes`, `TRUE`, `-3`, `10.0.0.0/99` are handled by our validation (naming `TRUST_PROXY`), never by an Express exception.

---

## Task 1: Public origin and trust-proxy parsing

**Files:**
- Create: `packages/line-mcp/src/public-url.ts`
- Test: `packages/line-mcp/src/public-url.test.ts`

**Interfaces:**
- Produces: `resolvePublicOrigin(raw: string | undefined, port: number, warn?: (message: string) => void): string` — origin with no trailing slash; `http://localhost:${port}` when `raw` is undefined/blank; `warn` defaults to a `process.stderr.write` of `[config] ...` and is called once for a non-loopback `http:` origin.
- Produces: `parseTrustProxy(raw: string | undefined): boolean | number | string` — `false` for undefined/blank/`false`/`0`; `true` for `true` (both case-insensitive); the number for `/^\d+$/`; for any other value a comma-separated list whose every trimmed entry is `loopback`, `linklocal`, `uniquelocal`, a `net.isIP` address, or an address with a numeric prefix in range (0–32 v4, 0–128 v6) — returned as the trimmed string; anything else throws `Error` naming `TRUST_PROXY`.

- [ ] **Step 1: Write failing tests** in `public-url.test.ts`. `resolvePublicOrigin`: unset/blank → `http://localhost:3000`; `https://mcp.example.com/` → `https://mcp.example.com`; `https://MCP.Example.com:443` → `https://mcp.example.com`; `http://localhost:8080`, `http://[::1]:8080` accepted without warning; `http://192.168.1.10:3000` accepted and the injected `warn` called once with a message containing `PUBLIC_URL`; throws `/PUBLIC_URL/` for `https://mcp.example.com/line-mcp` (message also `/BASE_PATH/`), `https://u:p@mcp.example.com`, `https://mcp.example.com?x=1`, `https://mcp.example.com#f`, `not a url`, `ftp://x`. `parseTrustProxy`: `undefined`, `''`, `' '`, `'false'`, `'FALSE'`, `'0'` → `false`; `'true'`, `'TRUE'` → `true`; `'2'` → `2`; `'loopback'`, `'loopback, 10.0.0.0/8'`, `'::1'` returned as given/trimmed; throws `/TRUST_PROXY/` for `'-3'`, `'1.5'`, `'yes'`, `'10.0.0.0/99'`, `'loopback,,x'`.
- [ ] **Step 2: Run** `npx vitest run packages/line-mcp/src/public-url.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement both functions in `public-url.ts`** using `new URL` (result built from `url.origin`) and `node:net`.
- [ ] **Step 4: Run the same command** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): add public origin and trust-proxy parsing`

## Task 2: Redirect policy module

**Files:**
- Create: `packages/line-mcp/src/auth/redirect-policy.ts`
- Test: `packages/line-mcp/src/auth/redirect-policy.test.ts`

**Interfaces:**
- Produces: `interface RedirectPolicy { isAllowed(uri: string): boolean }` and `createRedirectPolicy(raw: string | undefined): RedirectPolicy`; throws `Error` naming `OAUTH_ALLOWED_REDIRECT_URIS` for an invalid entry.

- [ ] **Step 1: Write failing tests** asserting: default (`undefined`, `''`, `' , '`) allows `http://localhost:8123/callback` and `https://127.0.0.1/x`, rejects `https://client.example.com/cb`, `javascript://localhost/evil`, `data://localhost`, `file://127.0.0.1/x`, `not a url`, `http://[::1]/cb`; with `'https://client.example.com'` allows `https://client.example.com/oauth/callback?x=1` and rejects `https://client.example.com.evil.test/cb`, `https://client.example.com@evil.test/cb`, `https://client.example.com:8443/cb`, `http://client.example.com/cb`, `https://client.example.com/cb#x`, `https://u@client.example.com/cb`; with `'https://client.example.com/oauth/callback'` allows exactly that URL and rejects `https://client.example.com/other`; two comma-separated entries (with surrounding spaces) both work; loopback is still allowed when an allowlist is set; the factory throws `/OAUTH_ALLOWED_REDIRECT_URIS/` for `http://a.com/cb`, `https://*.example.com`, `https://a.com/*`, `javascript:alert(1)`, `https://a.com/cb#frag`, `https://u:p@a.com`, `garbage`.
- [ ] **Step 2: Run** `npx vitest run packages/line-mcp/src/auth/redirect-policy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `createRedirectPolicy`. Entry parsing: reject if it contains `*`; `new URL`; require `https:`, empty username/password/hash. Classify as an origin entry iff it matches `/^https:\/\/[^/?#]+\/?$/i` (store `url.origin`), else exact (store `url.href`). `isAllowed`: parse (false on throw); loopback predicate kept verbatim from the old `isLoopbackRedirectUri` (scheme `http:`/`https:` and hostname exactly `localhost` or `127.0.0.1`); otherwise require `protocol === 'https:'`, empty `username`/`password`/`hash`, and membership of `origin` or `href`.
- [ ] **Step 4: Run the same command** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): add configurable redirect_uri policy`

## Task 3: `resolveOAuthConfig` and barrel exports

**Files:**
- Create: `packages/line-mcp/src/oauth-config.ts`, `packages/line-mcp/src/oauth-config.test.ts`
- Modify: `packages/line-mcp/src/index.ts` (export `resolveOAuthConfig`, `ResolvedOAuthConfig`, `createRedirectPolicy`, `RedirectPolicy`)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `resolveOAuthConfig(input: { publicUrl?: string; allowedRedirectUris?: string; trustProxy?: string; port: number; warn?: (message: string) => void }): ResolvedOAuthConfig` with `ResolvedOAuthConfig = { publicOrigin: string; explicitPublicUrl: boolean; redirectPolicy: RedirectPolicy; trustProxy: boolean | number | string }`. `explicitPublicUrl` is true iff `publicUrl` is non-blank.

- [ ] **Step 1: Write failing tests**: all-unset input with `port: 3000` → `{ publicOrigin: 'http://localhost:3000', explicitPublicUrl: false, trustProxy: false }` and a policy that rejects `https://client.example.com/cb`; all three set → origin `https://mcp.example.com`, `explicitPublicUrl: true`, policy allows the configured callback, `trustProxy: 1` for `'1'`; each invalid input rejects naming its variable; blank strings behave as unset (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run packages/line-mcp/src/oauth-config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** by composing Task 1/2 functions (trim, blank → undefined first); add the barrel exports.
- [ ] **Step 4: Run** the same command plus `npm run build` — Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `feat(oauth): add resolveOAuthConfig`

## Task 4: Advertised endpoints, validation order, smoke-harness localhost

**Files:**
- Modify: `packages/line-mcp/src/auth/line-auth-provider.ts` (`publicEndpointConfig`, stale comment above it)
- Modify: `packages/line-mcp/src/standalone.ts` (`StandaloneOptions`, `start()`), `packages/server/src/server.ts` (`ServerOptions`, `start()`, the two startup log lines)
- Modify: `tests/support/process-harness.ts` (`startApplication` default `publicUrl` → `http://localhost:${options.port}`), `tests/support/smoke-helpers.ts:117` (upload-URL rewrite regex accepts `localhost` as well as `127.0.0.1`)
- Test: `packages/line-mcp/src/auth/oauth-router.test.ts`, `packages/line-mcp/src/standalone.test.ts`, `packages/server/src/startup.test.ts` (the in-process `createServer(...).start()` pattern; `composition.test.ts` builds its own fixture and does not call `start()`)

**Interfaces:**
- Consumes: `resolveOAuthConfig`.
- Produces: `publicEndpointConfig(port: number, basePath: string, requiredScopes?: readonly string[], publicUrl?: string): PublicEndpointConfig` — when `publicUrl` is given it is passed through `resolvePublicOrigin(publicUrl, port, () => {})` (idempotent on an already-resolved origin; the no-op `warn` avoids a duplicate warning, since `resolveOAuthConfig` already warned) and issuer = `origin + basePath`, resource = `issuer + '/mcp'`; omitted → `http://localhost:${port}` as today.
- Produces: new options `oauthAllowedRedirectUris?: string` and `trustProxy?: string` on `StandaloneOptions`/`ServerOptions` (consumed in Tasks 5–6). First statement of both `start()` bodies: `const oauth = resolveOAuthConfig({ publicUrl: options.publicUrl ?? process.env.PUBLIC_URL, allowedRedirectUris: options.oauthAllowedRedirectUris ?? process.env.OAUTH_ALLOWED_REDIRECT_URIS, trustProxy: options.trustProxy ?? process.env.TRUST_PROXY, port })`; `ImportService` gets `publicUrl: oauth.explicitPublicUrl ? oauth.publicOrigin : undefined`.

- [ ] **Step 1: Extend the test helper** `providerFor(port, basePath, authStoreDir, lineApiBaseUrl?)` and `setupOAuthRoutes` in `oauth-router.test.ts` with a trailing optional `extra?: { publicUrl?: string; redirectPolicy?: RedirectPolicy }` (redirectPolicy used in Task 5), forwarding `extra.publicUrl` to `publicEndpointConfig`.
- [ ] **Step 2: Write failing tests** (`describe('PUBLIC_URL', …)`): with `publicUrl: 'https://mcp.example.com'` and basePath `/line-mcp`, authorization-server metadata has `issuer === 'https://mcp.example.com/line-mcp'` and `authorization_endpoint`/`token_endpoint`/`registration_endpoint` equal to `https://mcp.example.com/line-mcp/authorize|token|register`; protected-resource metadata `resource === 'https://mcp.example.com/line-mcp/mcp'`, `authorization_servers` equals `['https://mcp.example.com/line-mcp']`; `challenge(stubReq)` contains `resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/line-mcp/mcp"`; omitted `publicUrl` keeps `http://localhost:<port>/line-mcp`; `publicUrl: 'https://MCP.Example.com:443/'` yields issuer `https://mcp.example.com/line-mcp`. In `standalone.test.ts` and `startup.test.ts` (follow each file's existing start/stop pattern with a fresh empty temp `dataRoot`): for each of `{ publicUrl: 'https://mcp.example.com/line-mcp' }`, `{ oauthAllowedRedirectUris: 'http://a.com/cb' }`, `{ trustProxy: 'yes' }`, `start()` rejects with the matching variable name and `fs.readdirSync(dataRoot)` is `[]` (Review Focus 5, 6); blank `publicUrl: ''`, `oauthAllowedRedirectUris: ' , '`, `trustProxy: ''` start normally. In `startup.test.ts` add one test that starts the composed server with `publicUrl: 'https://MCP.Example.com/'` (seeded secret and a minted access token, as the file's other tests do), calls the import-initiate tool/route, and asserts the returned `upload_url` starts with `https://mcp.example.com` — this is the only test that proves `server.ts` passes the normalized origin to `ImportService`. Add one `standalone.test.ts` case that spies on `process.stderr.write` while starting with `publicUrl: 'http://192.168.1.10:3000'` and sees a `PUBLIC_URL` warning exactly once.
- [ ] **Step 3: Run** `npx vitest run packages/line-mcp packages/server` — Expected: new tests FAIL.
- [ ] **Step 4: Implement** the signature change, the `start()` wiring above, the harness/helper localhost edits, and update the two `http://localhost:${port}` startup log hints in `server.ts` so they remain accurate (print the public origin when `explicitPublicUrl`).
- [ ] **Step 5: Run** `npm run build && npx vitest run packages/line-mcp packages/server` — Expected: PASS with existing tests green. Then `npm run test:smoke` — Expected: PASS (proves the harness change keeps the issuer consistent).
- [ ] **Step 6: Commit** `feat(oauth): derive issuer and endpoints from PUBLIC_URL`

## Task 5: Enforce the policy; show redirect host; check /token

**Files:**
- Modify: `packages/line-mcp/src/auth/oauth-router.ts` (`OAuthRouterDeps`, remove `isLoopbackRedirectUri`, `/register`, `/authorize`, `authorizePageHtml`, `accountSelectorHtml`, `/token`)
- Modify: `packages/line-mcp/src/auth/line-auth-provider.ts` (`LineAuthProviderOptions.redirectPolicy?: RedirectPolicy`, default `createRedirectPolicy(undefined)`, pass into `mountOAuthRoutes`)
- Modify: `packages/line-mcp/src/standalone.ts`, `packages/server/src/server.ts` (pass `redirectPolicy: oauth.redirectPolicy`)
- Test: `packages/line-mcp/src/auth/oauth-router.test.ts`

**Interfaces:**
- Consumes: `RedirectPolicy`; test-helper `extra.redirectPolicy` from Task 4.
- Produces: `OAuthRouterDeps.redirectPolicy: RedirectPolicy`.

- [ ] **Step 1: Give `withOAuthServer` (`oauth-router.test.ts:159`) the same optional trailing `extra` parameter as `providerFor`** (it currently hardcodes `setupOAuthRoutes(app, port, '', path)`), then write failing tests (provider built with `createRedirectPolicy('https://client.example.com/oauth/callback')`): `/authorize` with that `redirect_uri` and valid PKCE params is non-400 and constructs a mocked `LineClient`; its HTML contains `client.example.com` in text beginning `You will be returned to`; `https://attacker.example/cb` → 400, no `LineClient` constructed; loopback still non-400; `javascript://localhost/evil` still 400; the 400 body contains both `loopback` and `OAUTH_ALLOWED_REDIRECT_URIS`; with two stored accounts the selector HTML contains the same notice for an allowed redirect. `/register`: allowed URI → 201 echoing `redirect_uris`; `["https://attacker.example/cb"]` → 400 `{ error: 'invalid_redirect_uri' }`; one allowed + one disallowed → 400; no `redirect_uris` → 201; string, `null`, `[123]` → 400 (Review Focus 4). `/token` (reuse the login-completion pattern of `describe('OAuth completion persistence')` to obtain a code, then redeem with form-encoded body): matching `redirect_uri` and `client_id` → 200; differing `redirect_uri` → 400 `invalid_grant`; differing `client_id` → 400 `invalid_grant`; both omitted → 200. Default-policy provider: allowed-looking `https://client.example.com/oauth/callback` → 400 at `/authorize` and `/register`.
- [ ] **Step 2: Run** `npx vitest run packages/line-mcp/src/auth/oauth-router.test.ts` — Expected: the allowlist, `/register` rejection, host-notice and `/token` mismatch tests FAIL; the cases "no `redirect_uris` → 201", "loopback still accepted", "omitted `/token` values → 200" and the default-policy rejections are regression tests that already PASS (keep them: they pin unchanged behavior). Existing tests still pass.
- [ ] **Step 3: Implement.** `/authorize` message: `redirect_uri must be a loopback (http://localhost:*/callback or http://127.0.0.1:*/callback) or match OAUTH_ALLOWED_REDIRECT_URIS`. `/register`: when `body.redirect_uris !== undefined` require `Array.isArray` with every element a string passing `isAllowed`, else `400 { error: 'invalid_redirect_uri', error_description }` before a `client_id` is generated. Pass `new URL(redirectUri).host` (HTML-escaped by the existing `escapeHtml`) into both page templates as `<p class="hint">You will be returned to <strong>HOST</strong> after login.</p>`. `/token`: after the pending code is found and before PKCE, if `redirect_uri` or `client_id` is present in the body and differs from `pending.redirectUri`/`pending.clientId`, delete the code and return `400 invalid_grant`.
- [ ] **Step 4: Run** `npx vitest run packages/line-mcp packages/server` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): enforce redirect_uri allowlist and show redirect host`

## Task 6: TRUST_PROXY and Host-independence

**Files:**
- Modify: `packages/mcp-runtime/src/host.ts` (`McpHostOptions.trustProxy?: boolean | number | string`; `app.set('trust proxy', trustProxy)` right after `express()` when defined)
- Modify: `packages/line-mcp/src/import-service.ts` (`initiate` fallback `req.get('host')` → `req.host`) and its test fake (`import-service.test.ts` `makeFakeExpressRequest`: provide `host: '127.0.0.1:9999'` instead of `get`)
- Modify: `packages/line-mcp/src/standalone.ts`, `packages/server/src/server.ts` (pass `trustProxy: oauth.trustProxy` to `createMcpHost`)
- Test: `packages/mcp-runtime/src/host.test.ts`, `packages/line-mcp/src/import-service.test.ts`, `packages/line-mcp/src/auth/oauth-router.test.ts`

**Interfaces:**
- Consumes: `oauth.trustProxy` (Task 4). Produces: `McpHostOptions.trustProxy`.

- [ ] **Step 1: Write failing tests**: (a) `host.test.ts` — through real Express: create the host with `trustProxy: true`, add `host.app.get('/_probe', (req, res) => res.json({ protocol: req.protocol, host: req.host }))`, listen on port 0, and with `http.request` send `X-Forwarded-Proto: https`, `X-Forwarded-Host: mcp.example.com` → body `{ protocol: 'https', host: 'mcp.example.com' }`; the same request against a host created with no `trustProxy` and with `trustProxy: false` returns `protocol: 'http'` and the connection's `Host`. (b) `import-service.test.ts` — fake request `{ protocol: 'https', host: 'mcp.example.com' }` yields `https://mcp.example.com/line-mcp/import-upload?token=id-1`; an explicit `publicUrl` still wins. (c) `oauth-router.test.ts` (use `http.request`, since fetch cannot override `Host`; run once with the test app's `trust proxy` set to `true` via `app.set('trust proxy', true)` and once off, to cover "whether or not `TRUST_PROXY` is set"): with `publicUrl` set, both well-known documents fetched with `Host: internal:3000`, `X-Forwarded-Host: evil.example`, `X-Forwarded-Proto: http` are byte-identical to those fetched without the extra headers; the `/authorize` HTML contains neither `evil.example` nor `internal:3000`. (d) Cross-host flow, all four calls against ONE app (each `mountOAuthRoutes` call owns its own pending-code map): build `const host = createMcpHost({ name: 't', version: '0', basePath: '', authProvider: provider, registrations: [] })` from `@raidenyn/mcp-runtime` (it mounts the provider's routes itself), listen on port 0, then obtain a code via `/authorize` (sent with `Host: mcp.example.com`) and `/authorize/poll`; `POST /token` with `Host: internal:3000` returns 200 with an `access_token`; `POST /mcp` with `Authorization: Bearer <token>`, `Host: third.example` and a minimal JSON-RPC `initialize` body returns a status other than 401.
- [ ] **Step 2: Run** `npx vitest run packages/mcp-runtime packages/line-mcp` — Expected: (a) and (b) FAIL; (c) and (d) are regression tests that already PASS because the flow is already Host-independent (they pin it; keep them).
- [ ] **Step 3: Implement** the host option, the `req.host` change, and the server wiring.
- [ ] **Step 4: Run** `npx vitest run packages/mcp-runtime packages/line-mcp packages/server` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(oauth): add opt-in TRUST_PROXY and prove host-independent flow`

## Task 7: Compiled-CLI smoke test

**Files:**
- Modify: `tests/support/process-harness.ts` (`StartApplicationOptions.extraEnv?: Record<string, string>`, merged into the child env)
- Create: `tests/smoke/public-origin-smoke.test.ts` (model on `tests/smoke/mock-line-smoke.test.ts`; reuse `startApplication`, `startMockLineServer`, `reserveFreePort`, `registerCleanup`, `spawnManagedNode`)

- [ ] **Step 1: Write the test**: for each target (`composed`, `standalone`) start the CLI with `basePath: '/line-mcp'`, `publicUrl: 'https://mcp.example.com'`, `extraEnv: { OAUTH_ALLOWED_REDIRECT_URIS: 'https://client.example.com/oauth/callback' }`; assert `GET /line-mcp/healthz` is 200; the **origin-root** `GET /.well-known/oauth-authorization-server/line-mcp` has `issuer === 'https://mcp.example.com/line-mcp'`; `GET /.well-known/oauth-protected-resource/line-mcp/mcp` has `resource === 'https://mcp.example.com/line-mcp/mcp'`; `GET /line-mcp/authorize` with the allowed `redirect_uri` and PKCE params is not 400 while `https://attacker.example/cb` is 400; unauthenticated `POST /line-mcp/mcp` returns 401 with `WWW-Authenticate` containing `https://mcp.example.com/.well-known/oauth-protected-resource/line-mcp/mcp`. Add a case: `startApplication` with `publicUrl: 'https://mcp.example.com/bad'` rejects, and the error text matches the CLI's own `/Fatal: .*PUBLIC_URL.*BASE_PATH/` line (do NOT match on the bare names `PUBLIC_URL`/`BASE_PATH` alone: `buildReadyError` appends an env summary that always contains them).
- [ ] **Step 2: Run** `npm run build && npx vitest run tests/smoke/public-origin-smoke.test.ts` — Expected: PASS.
- [ ] **Step 3: Commit** `test(oauth): smoke-test public origin and redirect allowlist in compiled CLIs`

## Task 8: Documentation

**Files:**
- Modify: `README.md` (new "Configuration" table before "Local development"; "Behind a reverse proxy" subsection; Security notes bullet "The server binds `0.0.0.0`…")
- Modify: `docs/ARCHITECTURE.md` (`## Auth flow`, `## Docker`)

- [ ] **Step 1: README configuration table** (Variable / Default / Meaning): `PORT` (3000), `BASE_PATH` (empty), `DATA_DIR` (`./data`, `/data` in Docker), `PUBLIC_URL` (unset → `http://localhost:PORT`; origin only; https expected, non-loopback http logs a warning; setting it changes the token issuer so clients reauthorize once), `OAUTH_ALLOWED_REDIRECT_URIS` (unset → loopback only; comma-separated https origins or exact URLs; no wildcards; **warning**: an origin entry authorizes every URL on that origin, so any onward-redirecting page there can capture an authorization code from a flow an attacker started; prefer exact callback URLs; the login page shows the destination host), `TRUST_PROXY` (off; `true`, hop count, or `loopback`/IP/CIDR list; affects only request-derived URLs such as the import-upload fallback, never the OAuth issuer), plus `LINE_API_BASE_URL` (tests/dev only) and `BANK_REGEX_TIMEOUT_MS` (composed target).
- [ ] **Step 2: README "Behind a reverse proxy"** with a `docker run` example (`-e PUBLIC_URL=https://mcp.example.com -e BASE_PATH=/line-mcp -e OAUTH_ALLOWED_REDIRECT_URIS=https://client.example.com/oauth/callback -e TRUST_PROXY=1`), the `claude mcp add --transport http line https://mcp.example.com/line-mcp/mcp` line, and an nginx snippet with three `location` blocks that forward to the container **without stripping the prefix** (`proxy_pass http://127.0.0.1:3000;`, no trailing slash) and set `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host`: `/line-mcp/`, `= /.well-known/oauth-authorization-server/line-mcp`, `/.well-known/oauth-protected-resource/line-mcp/`. State that the two `/.well-known` paths live at the origin root, outside `BASE_PATH`.
- [ ] **Step 3: `docs/ARCHITECTURE.md`**: document `resolveOAuthConfig` (validation-first), the public-origin seam, the redirect policy and its enforcement points (`/register`, `/authorize`, `/token` checks), the `trustProxy` host option and the Host-independence guarantee.
- [ ] **Step 4: Run** `npm run lint` — Expected: no errors. **Commit** `docs: document PUBLIC_URL, OAUTH_ALLOWED_REDIRECT_URIS and TRUST_PROXY`

## Task 9: Gate, PR and image tag

- [ ] **Step 1: Run the gate** `npm run lint && npm run build && npm run test:unit && npm run test:smoke`; Expected: all pass. Fix failures before continuing and report any faithfully.
- [ ] **Step 2: Push and open the PR** (`gh pr create`) titled `feat(oauth): support public https URL behind a reverse proxy` (no `!`), body with `Fixes #51`, a note that it supersedes #76, the three env vars, the note that setting `PUBLIC_URL` changes the issuer so clients reauthorize once and that a `PUBLIC_URL` containing a path is rejected (use `BASE_PATH`), and the PR-description attribution line from the session's instructions. Link the PR via `link_pull_request`.
- [ ] **Step 3: Ask the user to confirm**, then `gh pr edit <N> --add-label publish-docker`; the owner approves the `ghcr-publish` environment. Report `ghcr.io/raidenyn/line-mcp-full:pr-<N>`, `ghcr.io/raidenyn/line-mcp:pr-<N>` and the `sha-<short>` tags once the workflow succeeds.
- [ ] **Step 4: Ask the user to confirm**, then comment on #76 pointing to the new PR and close it as superseded.
