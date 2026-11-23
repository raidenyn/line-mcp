# LINE MCP Server — Architecture Reference

> This is the deep architecture reference for this repository;
> `AGENTS.md` is the operational entry point for agents; `CLAUDE.md` imports it.
>
> **Maintenance rule:** any PR that changes packages, tools, guides,
> auth, persistence, or Docker must update this file in the same PR.

This is a **LINE MCP server** — an MCP (Model Context Protocol) server that exposes LINE messenger (and, in the composed build, template-driven parsing of bank notifications delivered over LINE) as tools to an AI assistant. It runs over the Streamable HTTP transport and implements OAuth 2.0 so Claude Code handles authentication natively.

It is an **npm-workspace monorepo** (`packages/*`) built with TypeScript project references (`tsc -b`, CommonJS output). There is no top-level `src/` — the former monolith was split (issue #75) into six packages plus two runnable server entry points.

## Package graph

The dependency graph is strictly one-directional and enforced at test time by `tests/architecture/import-boundaries.test.ts`:

| Package | Role | Depends on |
|---------|------|-----------|
| `@raidenyn/line-client` | LINE Chrome-extension API client: QR login, message fetch, image download, WASM HMAC signing (LTSM). No SQLite. | `happy-dom` (bundled) |
| `@raidenyn/line-client-sqlite` | SQLite message cache + persistence-migration primitives, wrapping the client. | `line-client`, `better-sqlite3` |
| `@raidenyn/mcp-runtime` | Generic MCP-over-HTTP host + token codec. Imports **no** product package; accepts exactly one `AuthProvider`. | `express`, MCP SDK (peer) |
| `@raidenyn/line-mcp` | Messenger product: five messenger tools + guides, LINE auth provider, import service, sync loop, **standalone server**. | `line-client`, `line-client-sqlite`, `mcp-runtime` |
| `@raidenyn/bank-mcp` | Bank product: five transaction tools + guides, template/category/preset stores, parser, FX. Imports **no** `line-mcp`. | `line-client`, `mcp-runtime`, `better-sqlite3` |
| `@raidenyn/server` | Composition root — the **only** package importing both product packages. Owns the data root, secret, and legacy migration. | all of the above + MCP SDK |

Every package's entry point (`src/index.ts`) is **side-effect free**: importing it reads no files, opens no database, starts no timer, binds no socket. All I/O is deferred to explicitly-constructed objects and to the executable `cli.ts` files that own `DATA_DIR` / `process.cwd()` resolution.

## `@raidenyn/mcp-runtime` (`packages/mcp-runtime/src`)

- **`host.ts`** — `createMcpHost<P>({ name, version, basePath, authProvider, registrations })`. Owns only `POST ${basePath}/mcp`: authenticates FIRST (a rejected request allocates no protocol object), then builds a **fresh** `McpServer` + transport per request and passes the resolved principal through an explicit `RequestContext` (never `AsyncLocalStorage`). Defines the `AuthProvider<P>`, `Principal`, `RequestContext`, and `Registration` contracts. One idempotent cleanup closure closes transport + server on completion/disconnect/error.
- **`token-codec.ts`** — `createTokenCodec({ secret, issuer, audience, now? })`. Self-contained HMAC-SHA256 tokens: `base64url(claims).base64url(sig)`. Claims are a strict, versioned discriminated shape (`version:1`, `kind:'access'|'refresh'`, `subject`, `issuer`, `audience`, `scopes`, `issuedAt`, `expiresAt`). Verification is total and schema-checked — access/refresh kinds cannot be exchanged, and the two historical `{ authData, expiresAt }` / `{ authData }` payloads are rejected, never migrated.
- **`base-path.ts`** — `normalizeBasePath()` (`/` and empty → `''`; strips trailing slashes; adds a leading slash).

## `@raidenyn/line-client` (`packages/line-client/src`)

- **`client.ts`** — `LineClient` + `createLineClient()`. All LINE API logic; targets `https://line-chrome-gw.line-apps.com`, impersonating the Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Login flow (QR → certificate/PIN → `qrCodeLoginV2` → identity), message fetch with contact-name resolution, image download, on-demand LINE access-token refresh (per-`mid` in-flight lock).
- **`signer.ts`** — `signForAccount()`. Loads LINE's proprietary LTSM WASM crypto module inside a `happy-dom` sandbox (lazy; first signing call only) to produce request HMACs identical to the genuine extension.
- **`cached-message-reader.ts`** — `withMessageCache()` and the `MessageReader` / `MessageCache` ports the SQLite cache implements.
- **`export-parser.ts`** — LINE chat-export file parsing (`parseExportFile`, `parseExportHeader`). Synthetic IDs hash an unambiguously framed tuple plus a per-identical-message occurrence index, preserving identical same-minute export lines while keeping reimports deterministic.
- **`assets/ltsm/`** — vendored, proprietary LINE artifacts (`ltsm.wasm`, `ltsmSandbox.js`) plus `provenance.json` and `README.md`. **Do not edit.** See `THIRD_PARTY_NOTICES.md`: public publication is **not approved** (legal review pending). `happy-dom` is a `bundledDependencies` entry; `scripts/vendor-happy-dom.js` runs as `prepack` to vendor its real closure so `npm pack` yields a self-contained, registry-free tarball with **no** better-sqlite3.

## `@raidenyn/line-client-sqlite` (`packages/line-client-sqlite/src`)

- **`sqlite-message-cache.ts`** — `SqliteMessageCache` over `better-sqlite3`: one owner-scoped `messages` table (`owner_mid`, `chat_mid`, `message_id`, `created_time`, `raw_json`) with primary-key upserts and an `(owner_mid, chat_mid, created_time)` index. `importMessages` transactionally matches exact text plus UTC minute by multiplicity, while newly seen real LINE IDs replace matching `export-` rows one-for-one. Reads preserve distinct rows and perform no content deduplication. `:memory:` is accepted for tests.
- **`migration.ts`** — one-time legacy-migration SQL primitives consumed by the server's `persistence-migration.ts`: `readLegacyMessages`, `stageLineDb`, `stageQuarantineDb`, `recoverQuarantinedMessagesSql`.

## `@raidenyn/line-mcp` (`packages/line-mcp/src`)

The messenger product and the standalone server.

- **`cli.ts`** — standalone executable. Resolves `DATA_DIR` (`env` or `<cwd>/data`), constructs `createStandaloneServer`, wires SIGTERM/SIGINT shutdown.
- **`standalone.ts`** — `createStandaloneServer({ dataRoot, port?, basePath?, publicUrl? })`. Its own `SqliteMessageCache`, `LineAuthProvider`, `ImportService`, sync loop, composed through `createMcpHost` with exactly the five messenger tools + resources. Exposes `GET ${basePath}/healthz` → `{ status: 'ok', version }`. **Refuses to start** if it finds a legacy combined `cache/messages.db` with no `persistence-current.json` pointer (that migration is the composed server's job). Resolves its line DB from the pointer-committed generation if present, else a fresh `line-mcp/messages.db` layout.
- **`tools/`** — `registerLineTools(server, context, deps)`: the five messenger tools `list_chats`, `get_messages`, `get_image`, `initiate_import`, `complete_import`.
- **`resources.ts`** — `registerLineResources(server, { includeOverview? })`: the messenger `overview.md` (optional) plus the five messenger tool guides, read from this package's `docs/guide/`.
- **`auth/`** — `line-auth-provider.ts` (`LineAuthProvider`, the concrete `AuthProvider<LinePrincipal>`; MID-only principals; token issuance/refresh via the codec; `seedTestToken` e2e bypass; `publicEndpointConfig`; owns the per-MID in-memory freshness map as a private instance field plus the `recordRefreshedAuth` method that updates it and `freshestCredential(mid)` for lazy disk fallback), `credential-store.ts` (purely disk-backed: `FileCredentialStore` + `StoredAuthRecord` at `data/auth/<mid>.json`, `0600`/`0700`; `loadAuthFromDisk` / `persistAuthData`), `oauth-router.ts` (discovery / `/authorize` / `/authorize/poll` / `/token`, multi-account selector).
- **`import-service.ts`**, **`request-client.ts`**, **`sync.ts`** — chat-export upload service (OAuth-independent routes; owner-binds writes and reports parsed versus newly imported rows), the per-request cache-wrapping LINE client factory, and the daily background sync loop.
- **`assets/index.html`** — landing page served at `GET ${basePath}/`.

## `@raidenyn/bank-mcp` (`packages/bank-mcp/src`)

The bank/transaction product (composed server only; never imported by `line-mcp`).

- **`tools/`** — `registerBankTools(server, context, deps)`: `sample_messages`, `manage_templates`, `manage_categories`, `get_transactions`, `summarize_transactions`.
  - `sample_messages` — raw text messages (oldest-first); optional `since`/`until`; runs `detectPresets()` for coverage-gap suggestions.
  - `manage_templates` — CRUD for named regex templates + currency aliases, plus preset `list_presets` / `apply_preset` (additive-by-name).
  - `manage_categories` — CRUD for **global** spending categories (not per-chat).
  - `get_transactions` — auto-loads saved templates when `templates` omitted; `filterByTime()` per message; `getMessagesInRange()` when `since` given (else latest 200); `applyBalanceDiffs()` then `categorize()` then `filterTransactions()` (validated eagerly via `validateFilters()`).
  - `summarize_transactions` — pure-math totals grouped by month / merchant / category. Transactions with `amount` but no `currency` are separated into `unknown_currency` totals and `unknown_by_group` breakdowns (both always present, zeroed when none); the fetch pipeline warns when unlabelled amounts remain.
- **`resources.ts`** — `registerBankResources(server, { includeOverview? })`: the bank `overview.md` (optional) plus the five bank tool guides.
- **`transaction-parser.ts`** — `parseTransaction`, `summarize` (separates transactions with `amount` but no `currency` into `unknown_currency` totals and `unknown_by_group` breakdowns, both always present and zeroed when none), `applyBalanceDiffs` (dominant-currency exact stamp, else historical-FX conversion with `amount_estimated` / `amount_gap_suspected` flags), `categorize`, `validateFilters`, `filterTransactions`. dotAll (`s`) flag throughout for bilingual blobs. Zod schemas for templates/transactions/categories/filters.
- **`fx-rates.ts`** — `getHistoricalRate(date, from, to)` from `api.frankfurter.dev`; in-memory cache of successful lookups (historical rates never change); `null` on failure.
- **`template-store.ts`** — `TemplateStore` + `loadTemplates`/`upsertTemplate`/`deleteTemplate`/`listTemplates`/`filterByTime`, one JSON file per chat MID under `<dataRoot>/templates/<chatMid>.json`; migrates old `(?<amount>)`/`(?<currency>)` group names; path-traversal guard on chatMid. Missing files load as empty stores, while existing-file read/parse/migration failures throw. Mutations and migration rewrites use same-directory temporary files plus atomic rename so a failed write preserves the prior snapshot.
- **`category-store.ts`** — `CategoryStore` over a SQLite `categories` table (`id`, `name` UNIQUE, `pattern`); insertion-order preserving.
- **`preset-store.ts`** — `PresetStore`, `loadAllPresets`, `getPreset`, `detectPresets`; preset JSON in `assets/presets/` (`scb.json`, `cardx.json`).
- **`category-migration.ts`** — `readLegacyCategories`, `stageBankCategories` (category IDs/order survive migration and stay shared across principals).
- **`regex-executor.ts`** — `RegexExecutor` (issue #61 ReDoS containment). All bank-domain regex call sites — template/category/merchant-filter/preset matching — run inside two lazily-spawned worker threads instead of on the server event loop, so catastrophic backtracking cannot stall a request. Each call carries a per-operation timeout (`normalizeRegexTimeoutMs`, default 100 ms, clamped to 10–1000 ms), bounded queue depth, bounded payload size, and bounded input memory; `exec` copies back only the capture groups the caller names, and the worker refuses replies over 131,072 code units, so a user pattern cannot amplify its output into a large main-thread deserialization. A timeout, oversized reply, or worker error fails the whole tool call so financial results are never silently partial. If degradation is required (for example a replacement worker cannot be constructed), every surviving worker is retired so no match outlives its budget, pending and future jobs fail with `worker_failure`, and `close()` still closes the pools. The executor is the single place that defaults and clamps the timeout; `BankToolDeps.regex` is the port every call site consumes.

## `@raidenyn/server` (`packages/server/src`)

The composition root and the default executable.

- **`cli.ts`** — composed executable. Resolves `DATA_DIR`, the `TEST_TOKEN` + `LINE_AUTH_DATA` e2e bypass (this is the ONLY reader of those env vars — passed to `createServer` as `testAuth`), and `BANK_REGEX_TIMEOUT_MS` (the ONLY reader — parsed via the pure `resolveRegexTimeoutMs` helper and passed to `createServer` as `regexTimeoutMs`; the executor, not this CLI, defaults and clamps it), and SIGTERM/SIGINT shutdown.
- **`server.ts`** — `createServer({ dataRoot, port?, basePath?, publicUrl?, testAuth?, regexTimeoutMs? })`. Runs `bootstrapPersistence()` first, then opens two **separate** SQLite files (line messages vs. bank/category), constructs the **shared trusted-tenant** `CategoryStore` + `TemplateStore`, one `LineAuthProvider`, one request-client factory (backing messenger tools, the bank message reader, and the sync loop), the import service, one `RegexExecutor` (issue #61; bounded two-worker pool, `regexTimeoutMs` per op), and wires everything through `createMcpHost`. Exposes `GET ${basePath}/healthz` and `GET ${basePath}/` (serves `@raidenyn/line-mcp`'s `assets/index.html`). `stop()` closes in the reverse order of `start()`: the sync loop is awaited first (so no sync runs against closing DBs), the HTTP server closes, the `RegexExecutor` worker pool closes (after HTTP is down so no in-flight request still holds it; idempotent across repeated `stop()` calls), the `CategoryStore` DB closes, and the line-message cache closes last.
- **`registrations.ts`** — `buildRegistrations({ line, bank, guideDir })`: five messenger + five bank tools, plus resources = the five messenger guides + five bank guides (both registered with `includeOverview:false`) + exactly one composed overview at `line://guide` via `registerComposedOverview`, read from this package's own `docs/guide/overview.md`.
- **`data-layout.ts`** — pure path derivation from one data root (secret, auth, templates, generations, pointer, composed `guideDir`).
- **`persistence-migration.ts`** — `bootstrapPersistence()`. One-time, generation-based, pointer-committed migration of the legacy combined `cache/messages.db` into separate line/bank/quarantine databases. Rows whose owning MID is ambiguous are **quarantined** (never dropped or arbitrarily assigned). An interrupted restart before or after the pointer rename converges on a single authoritative generation.

## MCP resources & guide ownership (`docs/guide/`)

Guides are read from disk at request time (`fs.promises.readFile`); a missing file returns an error string in the content rather than crashing. **Each product package owns its own guides**, and the composed server owns only the combined overview:

| URI | Owning package / file |
|-----|-----------------------|
| `line://guide` (composed overview) | `packages/server/docs/guide/overview.md` |
| `line://guide` (messenger-only overview, standalone) | `packages/line-mcp/docs/guide/overview.md` |
| `line://guide/tools/{list_chats,get_messages,get_image,initiate_import,complete_import}` | `packages/line-mcp/docs/guide/tools/<name>.md` |
| `line://guide/tools/{sample_messages,manage_templates,manage_categories,get_transactions,summarize_transactions}` | `packages/bank-mcp/docs/guide/tools/<name>.md` |

The composed server suppresses both product packages' own overviews (`includeOverview:false`) so only `packages/server/docs/guide/overview.md` wins the shared `line://guide` URI. The standalone server registers `@raidenyn/line-mcp`'s own overview + its five tool guides.

**Maintenance rule:** When a `docs/guide/` file is added, removed, or substantively changed, update this section to match. When a **messenger** tool is added, create `packages/line-mcp/docs/guide/tools/<tool>.md` and add it to `registerLineResources`' `TOOL_GUIDES`; for a **bank** tool, do the same under `packages/bank-mcp`. When a new tool is added to either product package, also update the composed overview and the tool tables above and in `README.md`. Each package's `docs/`, `assets/`, and `dist/` are copied into the Docker image by the corresponding `COPY` in the `Dockerfile` (whole `packages/` for the `server` target; the four-package closure for `line-mcp`).

## Auth flow

**Transport:** Streamable HTTP on `http://localhost:PORT` (default 3000). Routes mount under `BASE_PATH` (default `/`, normalized to `''`) — the OAuth discovery routes insert the well-known segment *before* the path per RFC 8414/9728: `/.well-known/oauth-authorization-server${BASE_PATH}` and `/.well-known/oauth-protected-resource${BASE_PATH}/mcp`.

**Public origin (behind a reverse proxy).** Both servers validate all OAuth-facing configuration in `resolveOAuthConfig()` as the **first statement of `start()`** — before `bootstrapPersistence`, any SQLite handle, the signing secret or a worker — so a bad value aborts with the data root untouched. `resolveOAuthConfig` produces the normalized `publicOrigin` (`PUBLIC_URL`, origin only; `http://localhost:PORT` when unset; non-loopback `http` warns), the `RedirectPolicy` (`OAUTH_ALLOWED_REDIRECT_URIS`) and the parsed `TRUST_PROXY`. The origin is passed to `publicEndpointConfig(port, basePath, requiredScopes, publicUrl)`, which sets the issuer to `<origin><BASE_PATH>` and the resource to `<issuer>/mcp`. The token codec's issuer/audience, both discovery documents and the `WWW-Authenticate` challenge all derive from that one object; none read `Host` or `X-Forwarded-*`. `PUBLIC_URL` also drives the import-upload URL (normalized identically) and with it set no request header is consulted.

**Redirect policy.** `createRedirectPolicy(raw)` is injected into `LineAuthProvider` → `OAuthRouterDeps`. Loopback `http(s)://localhost` / `127.0.0.1` is always allowed (RFC 8252); all other candidates must be `https` with no userinfo/fragment and match an origin entry or an exact-URL entry. It is enforced at `/register` (400 `invalid_redirect_uri` when `redirect_uris` is present and not an array of allowed strings), at `/authorize` (400, never redirecting), and the QR/login and account-selector pages show the destination host. `/token` rejects a `redirect_uri` or `client_id` that is present and differs from the value stored with the code (400 `invalid_grant`).

**Proxy trust.** `TRUST_PROXY` is parsed and validated by `parseTrustProxy()` (own numeric/CIDR checks, so Express never raises an unnamed error) and applied as `createMcpHost({ trustProxy })` → `app.set('trust proxy', …)`. It affects only request-derived values such as the import-upload fallback (`req.protocol` + `req.host`, formerly `req.get('host')`); it never influences the OAuth issuer, claims, discovery or challenge.

**Breaking token cutover (issue #75, Task 8):** MCP tokens are finite-lived, **MID-only**, versioned, schema-checked claims that embed **no** LINE credential. Token claims carry MID identity only and enforce issuer, audience, scope, and finite expiry. The two historical embedded-credential formats are rejected on both the access and refresh paths — never migrated — so **every previously issued token requires a one-time reauthorization** after upgrading.

**Token lifecycle:**
- Tokens are HMAC-SHA256-signed by the codec; the key lives in `data/secret` (auto-created; persisted across restarts). Access tokens ~24 h, refresh tokens ~90 days.
- Refresh (`POST /token`, `grant_type=refresh_token`) verifies the refresh token's signature and reloads the LINE credential by MID from the `LineAuthProvider` instance's own `freshness` map (memory), falling back to a lazy disk load via `freshestCredential(mid)` (`data/auth/<mid>.json`) — a missing record means the account must reauthorize. Refresh survives restart while `data/secret` and the auth record are retained.
- LINE access tokens are refreshed on-demand inside `LineClient` when < 24 h remain; `LineAuthProvider.recordRefreshedAuth(authData)` updates the provider's in-memory freshness map first, then atomically persists, preserving the profile name (persistence failure is non-fatal).
- Multiple independent LINE accounts are supported; each principal's credential is resolved by its own MID and never shared. The freshness map is **instance-owned, not module-global**, so two `LineAuthProvider` instances in one process with the same MID but different `dataRoot`s never resolve each other's credentials via `resolveCredentials` (issue #79). Note: `LineClient.refreshLocks` (in `packages/line-client/src/client.ts`) is still a process-global, MID-keyed single-flight map for LINE token refresh; two providers on the same MID in one process share refresh-coalescing state, so a concurrent refresh on root B can apply root A's rotated LINE tokens. The `resolveCredentials` isolation does not cover this refresh-coalescing path.

## Data model & one-process-per-root rule

- The **line-message cache is owner-scoped** (per MID); the **bank category/template stores are shared across every principal** on a data root by explicit design (trusted-tenant model, Task 10). Only trust principals that may share bank/category state on the same root.
- **Never run two servers against the same data root on one host.** The composed server owns bank/category data the standalone server knows nothing about, and the standalone server refuses a legacy pre-migration combined database. Under Docker, give each target its own `/data` volume.

## Docker

One multi-stage `Dockerfile`, two runtime targets. The `builder` stage (`node:24`) runs `npm ci` + `tsc -b` once, then `npm prune --omit=dev` (keeping better-sqlite3's already-compiled native addon) and strips `src`/tests/tsconfig from `packages/`. Both runtime targets use `node:24-slim` (glibc — matches the builder so the prebuilt better-sqlite3 addon loads) and copy the pruned production `node_modules` plus their own package closure:

- `--target server` → `packages/server/dist/cli.js`, whole `packages/` tree (ten tools).
- `--target line-mcp` → `packages/line-mcp/dist/cli.js`, only the four-package closure (five tools).

Both run as the non-root `node` user, expose `/data` as a volume, and healthcheck `GET ${BASE_PATH}/healthz` via Node's http client. `docker-compose.yml` defaults to the `server` target (service `line-mcp-full`, volume `bank-mcp-data`); the `line-mcp` standalone service is under the `min` profile with its **own** volume (`line-mcp-data`).

## Delivery & publication (`.github/workflows/release.yml`, `.github/workflows/publish-docker.yml`)

`Release` is the only path to a version tag and a GitHub Release. It is manual only (`workflow_dispatch`), owner-only (`github.triggering_actor` compared case-insensitively with `github.repository_owner`), and `main`-only (`refs/heads/main`); `authorize` enforces all three before any job writes, and the `plan`/`draft`/`publish` jobs repeat it because "re-run failed jobs" skips jobs that already succeeded. There is no push trigger: a merge publishes nothing. Five stages run in order:

- **`authorize`** — owner, `main`, and the `raidenyn/line-mcp` repository, or the run stops.
- **`plan`** — `npm run release:plan` (a `semantic-release` dry run that creates no tag) resolves the next `vX.Y.Z`, its generated notes, and the planned commit. "No releasable commits" is a successful no-op; later stages are skipped.
- **`draft`** — creates a **draft** GitHub Release titled with the tag, targeted at the planned commit, with the planned notes. A draft creates no git tag, which is what keeps the pipeline safe to abandon: the tag is created only when the draft is published. A stale draft for the same tag is deleted and replaced; an already-published release or an existing remote tag fails the run.
- **`images`** — calls the reusable `Publish Docker` workflow (`.github/workflows/publish-docker.yml` declares `workflow_call`) with the planned tag, to build both images at the planned commit and push the version tags.
- **`publish`** — logs in to GHCR with `GITHUB_TOKEN`, reads both image digests, strips any previous image section, appends one `## Docker images` section (pull command, digest reference, package page per image) to the notes, and publishes the draft with `gh release edit --draft=false`. Publishing the draft is what creates the git tag at the planned commit; the job then verifies the tag resolves to that commit.

`Publish Docker` is otherwise reachable only from `pull_request: [labeled]`. The removed triggers are `repository_dispatch: release-published`, `release: published`, and `workflow_dispatch`, along with the `edge` tag they produced. In the called path a caller guard rejects any event that is not `workflow_dispatch`, any `github.workflow_ref` other than `release.yml@refs/heads/main`, and any ref other than `refs/heads/main`, so only `Release` can publish release images.

- **Images** — `linux/amd64` in **GHCR only** — `ghcr.io/raidenyn/line-mcp-full` (target `server`, ten tools) and `ghcr.io/raidenyn/line-mcp` (target `line-mcp`, five tools). Both packages are **public once the owner completes the one-time visibility flip** (the first publication creates them private; the owner's 2026-11-16 acceptance of the LINE LTSM redistribution risk covers the public images), an anonymous `docker pull` then succeeds, and there is no Docker Hub or other registry push. `v0.1.0` has no images.
- **Release tags** — `vX.Y.Z` publishes `X.Y.Z` and `sha-<short>`, plus `X.Y`/`X`/`latest` only when that tag is the newest stable release (`X` never on `0.x`). The tag does not exist while the images are built — the planned commit is the caller's commit — so the newest-stable comparison includes the tag being published. `sha-<short>` identifies the built commit, not the default-branch head; a rebuild of the same commit yields a new digest, so deployments should pin a digest.
- **Pull-request tags** — the `publish-docker` label publishes a same-repository PR head as `pr-<number>` and `sha-<short>` and nothing else; a tag allowlist asserted immediately before the push rejects any other tag, so a PR build can never push `latest`, `X.Y`, `X`, or a version tag. Later pushes do not republish (remove and re-add the label), other labels publish nothing, and a fork head is refused with a warning before the protected environment.
- **Job shape** — a `prepare` job (only `contents: read`) resolves the checkout ref, commit SHA, PR number, and tag flags; a matrix `publish` job runs in the protected `ghcr-publish` environment with `contents: read` and `packages: write`, authenticates with `${{ github.actor }}` / `secrets.GITHUB_TOKEN` (no personal access token), and builds each target with Buildx under its own registry cache tag (never a GHA cache, which fork pull requests could restore). Each metadata step sets `org.opencontainers.image.revision` plus `org.opencontainers.image.licenses=NOASSERTION`. Every release and PR deployment needs the owner's approval in the environment, which keeps permitting `main` and pull-request refs and remains the abuse control now that the images are public.
- **Runbook** — the first-publication visibility flip (the first publication creates private packages; only the owner makes them public, once and irreversibly), anonymous verification, stage-by-stage failure recovery, and the PR label path live in `docs/RELEASING.md` ("Docker Images" / "First publication: the one-way visibility flip" / "Pull-request images").

## Specs & artifact policy

- `packages/line-client/assets/ltsm/*` — LINE's proprietary WASM crypto + sandbox (binary, do not edit). Provenance/notice in `THIRD_PARTY_NOTICES.md` and `provenance.json`.
- `specs/LINE_Chrome_API_Specification.md` / `specs/LINE_Login_Protocol_Specification.md` — reverse-engineered API reference.
- `openspec/specs/` — behavioral source of truth. The pinned `@fission-ai/openspec` devDependency validates it with `npx openspec validate --all --strict` in the CI `check` job. `openspec/config.yaml` adds the `Verify: <exact command>` rule for tasks and the apply guidance for TDD plus session handoffs.
- `openspec/changes/` — active changes. Every unchecked task in a non-archived `tasks.md` must carry an indented `Verify:` line, enforced by `tests/release/openspec-tasks.test.ts`; `openspec/templates/handoff.md` is the multi-session handoff template.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — frozen archive; new designs go through `openspec/changes/`.
- **No public npm publish.** No npm package is published to the public npm registry or any other package index. CI and the artifact tests `npm pack`/install for verification only; a new public distribution form requires the issue #75 provenance review. Public **container images** are the one approved exception: the owner accepted the LINE LTSM redistribution risk permanently on 2026-11-16.

## Tests

- `tests/release/*` — documentation and repository-policy contracts: the release runbook, the public-image notices, the committed agent permission policy, and the secret-scanning wiring (`.claude/settings.json`, `.gitleaks.toml`, the Husky `pre-commit` hook, and the `check` job).
- **Verification ladder** — `npm run verify:changed` is the seconds-long inner loop: it lints changed/untracked JS/TS files against `git merge-base origin/main HEAD` and runs only the affected in-process tests under `packages`, `tests/architecture`, `tests/release`, and `tests/harness`. It only reaches tests inside the changed package, because workspace packages import each other from compiled `dist`; changing exported package code needs `verify` for dependent-package tests. `npm run verify` is the pre-PR gate: lint, exactly one `tsc -b`, strict OpenSpec validation, then the unit, architecture, release, and mock-backed smoke suites in one Vitest run (never `test:smoke`, which builds again). `npm run verify:all` adds two explicit image builds (so a missing Docker daemon fails instead of skipping), the Docker smoke, and the packed line-client artifact check. Agent-facing rungs use `--reporter=dot`; CI keeps the verbose per-job output.
- `packages/**/*.test.ts` — unit / contract / migration tests co-located with each package. Run by `npm run test:unit` alongside `tests/architecture`. Includes the issue #61 regex-containment regressions in `@raidenyn/bank-mcp`: `regex-executor.test.ts` exercises per-operation timeout, worker-pool bounds, and idempotent close; the co-located transaction-parser/preset-store/register-tools suites cover the routed call sites; `packages/server/src/startup.test.ts` asserts the executor is constructed between the bank store and the sync loop and that its close is idempotent across repeated `stop()` calls; `packages/server/src/cli.test.ts` covers `resolveRegexTimeoutMs` parsing (unset → `undefined`, non-numeric → `NaN`, otherwise the parsed number — the executor does the clamping).
- **Agent hooks** — `.claude/hooks/lint-on-edit.mjs` (Claude Code `PostToolUse` on `Edit|Write|MultiEdit`) runs `eslint --fix` on an edited in-repo `.ts` file (not `dist/`, `node_modules/` or `assets/ltsm/`) and exits 2 with at most 20 lines of remaining errors; `.claude/hooks/session-context.mjs` (`SessionStart`) prints at most 30 lines: branch, short status, diff against the merge-base with `origin/main`, `openspec list`, and the branch's last `gh run`, each probe optional and time-boxed, always exiting 0. Both are wired in `.claude/settings.json`. `.opencode/plugin/line-mcp-harness.ts` (implementation in `.opencode/harness/hooks.ts`) runs the same scripts with the same payload in OpenCode: lint errors are appended to the `edit`/`write`/`apply_patch` tool result, and the context block is computed once per session and appended to the system prompt. `tests/harness/*` covers the scripts and the plugin; `npm run test:unit` includes it.
- `tests/architecture/import-boundaries.test.ts` — enforces the package dependency graph above.
- `tests/release/openspec-tasks.test.ts` — requires a `Verify:` line on every unchecked task in every non-archived OpenSpec change.
- `tests/artifacts/line-client-pack.test.ts` — real `npm pack` + offline install of `@raidenyn/line-client` outside the checkout, real WASM HMAC, asserts no better-sqlite3. (CI `pack-line-client` job.)
- `tests/docker/docker-smoke.test.ts` — builds both Docker targets, runs each container against a throwaway data root, waits for `/healthz`, and asserts the tool surface over a real MCP `tools/list` (composed = ten, standalone = five). (CI `docker` job.)
- `tests/smoke/*` — strict local LINE mock + compiled composed and standalone CLIs, run as real child processes against a deterministic in-process mock gateway. `npm run test:smoke` builds the workspace once, then runs four scenarios: composed seeded credentials, standalone seeded credentials, composed full OAuth (PKCE → PIN → certificate reuse → MCP token issuance → MCP token refresh), and standalone full OAuth. Composed exercises all ten tools; standalone exercises the five messenger tools and asserts the bank surfaces are absent. Requires no `.line-auth.json`, no LINE credentials, and no Docker — the process-level compiled-CLI boundary is what distinguishes it from `test:unit` (in-process) and Docker smoke (runtime-image startup). (CI `smoke` job.) A fifth in-process scenario, `tests/smoke/auth-cross-root-isolation.test.ts`, constructs two `createServer` instances directly in the test process (no CLI subprocess, no mock gateway — its HTTP stubs are inline) to reproduce issue #79's cross-root credential bleed through the same-process, multi-instance construction path that the CLI-subprocess scenarios cannot exercise.
- `tests/e2e.test.ts` — live LINE e2e; launches the composed server, seeds a `TEST_TOKEN` bypass, connects over the MCP HTTP transport. Requires `.line-auth.json`; **excluded from the PR-blocking CI gate**, run manually pre-release.
