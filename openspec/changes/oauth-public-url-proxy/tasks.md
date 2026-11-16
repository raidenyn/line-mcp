## 1. Parsing and configuration

- [x] 1.1 Add `packages/line-mcp/src/public-url.ts` with `resolvePublicOrigin(raw, port)` and `parseTrustProxy(raw)`, including fail-closed validation, non-loopback-http warning hook, and unit tests
- [x] 1.2 Add `packages/line-mcp/src/auth/redirect-policy.ts` (`createRedirectPolicy`, loopback default, origin and exact entries, `*`/fragment/userinfo rejection) with unit tests
- [x] 1.3 Add `packages/line-mcp/src/oauth-config.ts` (`resolveOAuthConfig`) and export it, `createRedirectPolicy`, `RedirectPolicy` from `packages/line-mcp/src/index.ts`

## 2. Advertised endpoints

- [x] 2.1 Extend `publicEndpointConfig(port, basePath, requiredScopes?, publicUrl?)` so issuer and resource derive from the resolved origin
- [x] 2.2 Call `resolveOAuthConfig` as the first statement of `start()` in `standalone.ts` and `server.ts` (before any persistence/DB/secret/worker), wire the resolved origin into `publicEndpointConfig` and `ImportService`, and fix the startup log hints
- [x] 2.3 Move the smoke harness default `PUBLIC_URL` to `http://localhost:<port>` and update the upload-URL rewrite in `tests/support/smoke-helpers.ts`

## 3. Redirect policy enforcement

- [x] 3.1 Inject `redirectPolicy` through `LineAuthProviderOptions` and `OAuthRouterDeps`; replace `isLoopbackRedirectUri` in `/authorize`
- [x] 3.2 Validate `redirect_uris` at `POST /register` (400 `invalid_redirect_uri`)
- [x] 3.3 Show the redirect host on the QR login page and the account-selector page
- [x] 3.4 Check `redirect_uri` and `client_id` at `/token` when present (400 `invalid_grant` on mismatch)

## 4. Proxy trust

- [x] 4.1 Add optional `trustProxy` to `McpHostOptions` in `packages/mcp-runtime/src/host.ts` and apply `app.set('trust proxy', ...)`; real-Express tests for on/off
- [x] 4.2 Switch `ImportService.initiate()` fallback to `req.host`; pass the parsed `TRUST_PROXY` into `createMcpHost` from both servers

## 5. Behavioral tests

- [x] 5.1 Discovery metadata, protected-resource metadata and challenge use PUBLIC_URL (+ BASE_PATH); unset PUBLIC_URL unchanged
- [x] 5.2 `/authorize` accepts allowed https redirect (origin and exact entries) and rejects others, non-http schemes and look-alike hosts
- [x] 5.3 `/register` accepts allowed and rejects disallowed or malformed `redirect_uris`
- [x] 5.4 `/token` with a different Host and forwarded headers succeeds and the token authenticates a real `POST /mcp`; discovery is unaffected by forwarded headers
- [x] 5.5 Invalid configuration aborts `start()` with no files created in the data root; non-loopback http `PUBLIC_URL` warns on real stderr once; import URL uses the normalized origin
- [x] 5.6 Regression: with all new variables unset, existing tests pass; the only existing-test edits are the `import-service.test.ts` request fake, the `providerFor`/`setupOAuthRoutes`/`withOAuthServer` helper parameters in `oauth-router.test.ts`, and the smoke harness/helper localhost change
- [x] 5.7 Smoke test boots the compiled CLIs with `PUBLIC_URL`, `BASE_PATH` and `OAUTH_ALLOWED_REDIRECT_URIS` and checks the root-level discovery documents

## 6. Documentation

- [x] 6.1 README configuration table (`PORT`, `BASE_PATH`, `DATA_DIR`, `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` with the origin-entry warning, `TRUST_PROXY`) and a "Behind a reverse proxy" example that forwards the root-level `/.well-known/oauth-*` paths and keeps the prefix; update the Security notes line
- [x] 6.2 Update `docs/ARCHITECTURE.md` (auth flow, public origin, redirect policy, trust proxy, validation order)

## 7. Delivery

- [x] 7.1 Run the pre-PR gate: `npm run lint && npm run build && npm run test:unit && npm run test:smoke`
- [x] 7.2 Push `feat/oauth-public-url-proxy`, open a PR titled `feat(oauth): support public https URL behind a reverse proxy` (not marked breaking) saying `Fixes #51`, superseding #76, with a note that clients reauthorize once when `PUBLIC_URL` is first set
- [ ] 7.3 With the user's confirmation, apply the `publish-docker` label so the `pr-<N>` and `sha-` GHCR tags are published; report the tags
- [ ] 7.4 With the user's confirmation, comment on and close PR #76 as superseded
