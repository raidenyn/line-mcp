# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsc -b — composite build of all six packages
npm run clean        # tsc -b --clean
npm start            # composed server: node packages/server/dist/cli.js  (HTTP MCP on localhost:3000)
npm run lint         # eslint .
```

```bash
npm run test:unit    # in-process unit / contract / migration + import-boundary tests (no LINE session, no Docker)
npm run test:smoke   # strict local LINE mock + compiled composed and standalone CLIs (no credentials, no Docker)
npm run test:e2e     # live LINE e2e (requires .line-auth.json)
```

Extra deterministic gates (run explicitly; also wired into CI):

```bash
npx vitest run tests/architecture/import-boundaries.test.ts   # package dependency-graph guard
npx vitest run tests/artifacts/line-client-pack.test.ts       # packed line-client: offline install, real WASM, no SQLite
npx vitest run tests/docker/docker-smoke.test.ts              # both Docker targets: healthz + real MCP tools/list
```

To run a single test file:
```bash
npx vitest run packages/server/src/composition.test.ts
```

The standalone messenger-only server runs from `node packages/line-mcp/dist/cli.js`.

`LINE_API_BASE_URL` is a test/development override that repoints the LINE client at a different gateway (the smoke suite sets it to the local strict mock). Production deployments leave it unset: the default gateway is LINE, and any configured override still receives real LINE authorization headers, so only point it at a trusted endpoint.

## Working Branches

Do not create or offer Git worktrees for this project. For topic-specific
changes, create a standalone `fix/<topic>` branch from `origin/main` and keep
unrelated branch changes out of it. If `origin/master` is requested but absent,
use `origin/main`.

## Architecture

This is a **LINE MCP server** — an MCP (Model Context Protocol) server that exposes LINE messenger (and, in the composed build, template-driven parsing of bank notifications delivered over LINE) as tools to an AI assistant. It runs over the Streamable HTTP transport and implements OAuth 2.0 so Claude Code handles authentication natively.

It is an **npm-workspace monorepo** (`packages/*`) built with TypeScript project references (`tsc -b`, CommonJS output). There is no top-level `src/` — the former monolith was split (issue #75) into six packages plus two runnable server entry points.

### Package graph

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

### `@raidenyn/mcp-runtime` (`packages/mcp-runtime/src`)

- **`host.ts`** — `createMcpHost<P>({ name, version, basePath, authProvider, registrations })`. Owns only `POST ${basePath}/mcp`: authenticates FIRST (a rejected request allocates no protocol object), then builds a **fresh** `McpServer` + transport per request and passes the resolved principal through an explicit `RequestContext` (never `AsyncLocalStorage`). Defines the `AuthProvider<P>`, `Principal`, `RequestContext`, and `Registration` contracts. One idempotent cleanup closure closes transport + server on completion/disconnect/error.
- **`token-codec.ts`** — `createTokenCodec({ secret, issuer, audience, now? })`. Self-contained HMAC-SHA256 tokens: `base64url(claims).base64url(sig)`. Claims are a strict, versioned discriminated shape (`version:1`, `kind:'access'|'refresh'`, `subject`, `issuer`, `audience`, `scopes`, `issuedAt`, `expiresAt`). Verification is total and schema-checked — access/refresh kinds cannot be exchanged, and the two historical `{ authData, expiresAt }` / `{ authData }` payloads are rejected, never migrated.
- **`base-path.ts`** — `normalizeBasePath()` (`/` and empty → `''`; strips trailing slashes; adds a leading slash).

### `@raidenyn/line-client` (`packages/line-client/src`)

- **`client.ts`** — `LineClient` + `createLineClient()`. All LINE API logic; targets `https://line-chrome-gw.line-apps.com`, impersonating the Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Login flow (QR → certificate/PIN → `qrCodeLoginV2` → identity), message fetch with contact-name resolution, image download, on-demand LINE access-token refresh (per-`mid` in-flight lock).
- **`signer.ts`** — `signForAccount()`. Loads LINE's proprietary LTSM WASM crypto module inside a `happy-dom` sandbox (lazy; first signing call only) to produce request HMACs identical to the genuine extension.
- **`cached-message-reader.ts`** — `withMessageCache()` and the `MessageReader` / `MessageCache` ports the SQLite cache implements.
- **`export-parser.ts`** — LINE chat-export file parsing (`parseExportFile`, `parseExportHeader`).
- **`assets/ltsm/`** — vendored, proprietary LINE artifacts (`ltsm.wasm`, `ltsmSandbox.js`) plus `provenance.json` and `README.md`. **Do not edit.** See `THIRD_PARTY_NOTICES.md`: public publication is **not approved** (legal review pending). `happy-dom` is a `bundledDependencies` entry; `scripts/vendor-happy-dom.js` runs as `prepack` to vendor its real closure so `npm pack` yields a self-contained, registry-free tarball with **no** better-sqlite3.

### `@raidenyn/line-client-sqlite` (`packages/line-client-sqlite/src`)

- **`sqlite-message-cache.ts`** — `SqliteMessageCache` over `better-sqlite3`: one `messages` table (`chat_mid`, `message_id`, `created_time`, `raw_json`), `INSERT OR REPLACE` dedup, index on `(chat_mid, created_time)`. Owner-scoped: the same chat/message IDs under two MIDs stay isolated. `:memory:` accepted for tests.
- **`migration.ts`** — one-time legacy-migration SQL primitives consumed by the server's `persistence-migration.ts`: `readLegacyMessages`, `stageLineDb`, `stageQuarantineDb`, `recoverQuarantinedMessagesSql`.

### `@raidenyn/line-mcp` (`packages/line-mcp/src`)

The messenger product and the standalone server.

- **`cli.ts`** — standalone executable. Resolves `DATA_DIR` (`env` or `<cwd>/data`), constructs `createStandaloneServer`, wires SIGTERM/SIGINT shutdown.
- **`standalone.ts`** — `createStandaloneServer({ dataRoot, port?, basePath?, publicUrl? })`. Its own `SqliteMessageCache`, `LineAuthProvider`, `ImportService`, sync loop, composed through `createMcpHost` with exactly the five messenger tools + resources. Exposes `GET ${basePath}/healthz` → `{ status: 'ok', version }`. **Refuses to start** if it finds a legacy combined `cache/messages.db` with no `persistence-current.json` pointer (that migration is the composed server's job). Resolves its line DB from the pointer-committed generation if present, else a fresh `line-mcp/messages.db` layout.
- **`tools/`** — `registerLineTools(server, context, deps)`: the five messenger tools `list_chats`, `get_messages`, `get_image`, `initiate_import`, `complete_import`.
- **`resources.ts`** — `registerLineResources(server, { includeOverview? })`: the messenger `overview.md` (optional) plus the five messenger tool guides, read from this package's `docs/guide/`.
- **`auth/`** — `line-auth-provider.ts` (`LineAuthProvider`, the concrete `AuthProvider<LinePrincipal>`; MID-only principals; token issuance/refresh via the codec; `seedTestToken` e2e bypass; `publicEndpointConfig`), `credential-store.ts` (`FileCredentialStore` + `StoredAuthRecord` at `data/auth/<mid>.json`, `0600`/`0700`; `latestAuthData` freshness map; `recordRefreshedAuth`), `oauth-router.ts` (discovery / `/authorize` / `/authorize/poll` / `/token`, multi-account selector).
- **`import-service.ts`**, **`request-client.ts`**, **`sync.ts`** — chat-export upload service (OAuth-independent routes; owner-binds writes), the per-request cache-wrapping LINE client factory, and the daily background sync loop.
- **`assets/index.html`** — landing page served at `GET ${basePath}/`.

### `@raidenyn/bank-mcp` (`packages/bank-mcp/src`)

The bank/transaction product (composed server only; never imported by `line-mcp`).

- **`tools/`** — `registerBankTools(server, context, deps)`: `sample_messages`, `manage_templates`, `manage_categories`, `get_transactions`, `summarize_transactions`.
  - `sample_messages` — raw text messages (oldest-first); optional `since`/`until`; runs `detectPresets()` for coverage-gap suggestions.
  - `manage_templates` — CRUD for named regex templates + currency aliases, plus preset `list_presets` / `apply_preset` (additive-by-name).
  - `manage_categories` — CRUD for **global** spending categories (not per-chat).
  - `get_transactions` — auto-loads saved templates when `templates` omitted; `filterByTime()` per message; `getMessagesInRange()` when `since` given (else latest 200); `applyBalanceDiffs()` then `categorize()` then `filterTransactions()` (validated eagerly via `validateFilters()`).
  - `summarize_transactions` — pure-math totals grouped by month / merchant / category.
- **`resources.ts`** — `registerBankResources(server, { includeOverview? })`: the bank `overview.md` (optional) plus the five bank tool guides.
- **`transaction-parser.ts`** — `parseTransaction`, `summarize`, `applyBalanceDiffs` (dominant-currency exact stamp, else historical-FX conversion with `amount_estimated` / `amount_gap_suspected` flags), `categorize`, `validateFilters`, `filterTransactions`. dotAll (`s`) flag throughout for bilingual blobs. Zod schemas for templates/transactions/categories/filters.
- **`fx-rates.ts`** — `getHistoricalRate(date, from, to)` from `api.frankfurter.dev`; in-memory cache of successful lookups (historical rates never change); `null` on failure.
- **`template-store.ts`** — `TemplateStore` + `loadTemplates`/`upsertTemplate`/`deleteTemplate`/`listTemplates`/`filterByTime`, one JSON file per chat MID under `<dataRoot>/templates/<chatMid>.json`; migrates old `(?<amount>)`/`(?<currency>)` group names; path-traversal guard on chatMid.
- **`category-store.ts`** — `CategoryStore` over a SQLite `categories` table (`id`, `name` UNIQUE, `pattern`); insertion-order preserving.
- **`preset-store.ts`** — `PresetStore`, `loadAllPresets`, `getPreset`, `detectPresets`; preset JSON in `assets/presets/` (`scb.json`, `cardx.json`).
- **`category-migration.ts`** — `readLegacyCategories`, `stageBankCategories` (category IDs/order survive migration and stay shared across principals).

### `@raidenyn/server` (`packages/server/src`)

The composition root and the default executable.

- **`cli.ts`** — composed executable. Resolves `DATA_DIR`, the `TEST_TOKEN` + `LINE_AUTH_DATA` e2e bypass (this is the ONLY reader of those env vars — passed to `createServer` as `testAuth`), and SIGTERM/SIGINT shutdown.
- **`server.ts`** — `createServer({ dataRoot, port?, basePath?, publicUrl?, testAuth? })`. Runs `bootstrapPersistence()` first, then opens two **separate** SQLite files (line messages vs. bank/category), constructs the **shared trusted-tenant** `CategoryStore` + `TemplateStore`, one `LineAuthProvider`, one request-client factory (backing messenger tools, the bank message reader, and the sync loop), the import service, and wires everything through `createMcpHost`. Exposes `GET ${basePath}/healthz` and `GET ${basePath}/` (serves `@raidenyn/line-mcp`'s `assets/index.html`).
- **`registrations.ts`** — `buildRegistrations({ line, bank, guideDir })`: five messenger + five bank tools, plus resources = the five messenger guides + five bank guides (both registered with `includeOverview:false`) + exactly one composed overview at `line://guide` via `registerComposedOverview`, read from this package's own `docs/guide/overview.md`.
- **`data-layout.ts`** — pure path derivation from one data root (secret, auth, templates, generations, pointer, composed `guideDir`).
- **`persistence-migration.ts`** — `bootstrapPersistence()`. One-time, generation-based, pointer-committed migration of the legacy combined `cache/messages.db` into separate line/bank/quarantine databases. Rows whose owning MID is ambiguous are **quarantined** (never dropped or arbitrarily assigned). An interrupted restart before or after the pointer rename converges on a single authoritative generation.

### MCP resources & guide ownership (`docs/guide/`)

Guides are read from disk at request time (`fs.promises.readFile`); a missing file returns an error string in the content rather than crashing. **Each product package owns its own guides**, and the composed server owns only the combined overview:

| URI | Owning package / file |
|-----|-----------------------|
| `line://guide` (composed overview) | `packages/server/docs/guide/overview.md` |
| `line://guide` (messenger-only overview, standalone) | `packages/line-mcp/docs/guide/overview.md` |
| `line://guide/tools/{list_chats,get_messages,get_image,initiate_import,complete_import}` | `packages/line-mcp/docs/guide/tools/<name>.md` |
| `line://guide/tools/{sample_messages,manage_templates,manage_categories,get_transactions,summarize_transactions}` | `packages/bank-mcp/docs/guide/tools/<name>.md` |

The composed server suppresses both product packages' own overviews (`includeOverview:false`) so only `packages/server/docs/guide/overview.md` wins the shared `line://guide` URI. The standalone server registers `@raidenyn/line-mcp`'s own overview + its five tool guides.

**Maintenance rule:** When a `docs/guide/` file is added, removed, or substantively changed, update this section to match. When a **messenger** tool is added, create `packages/line-mcp/docs/guide/tools/<tool>.md` and add it to `registerLineResources`' `TOOL_GUIDES`; for a **bank** tool, do the same under `packages/bank-mcp`. When a new tool is added to either product package, also update the composed overview and the tool tables above and in `README.md`. Each package's `docs/`, `assets/`, and `dist/` are copied into the Docker image by the corresponding `COPY` in the `Dockerfile` (whole `packages/` for the `server` target; the four-package closure for `line-mcp`).

### Auth flow

**Transport:** Streamable HTTP on `http://localhost:PORT` (default 3000). Routes mount under `BASE_PATH` (default `/`, normalized to `''`) — the OAuth discovery routes insert the well-known segment *before* the path per RFC 8414/9728: `/.well-known/oauth-authorization-server${BASE_PATH}` and `/.well-known/oauth-protected-resource${BASE_PATH}/mcp`.

**Breaking token cutover (issue #75, Task 8):** MCP tokens are finite-lived, **MID-only**, versioned, schema-checked claims that embed **no** LINE credential. Token claims carry MID identity only and enforce issuer, audience, scope, and finite expiry. The two historical embedded-credential formats are rejected on both the access and refresh paths — never migrated — so **every previously issued token requires a one-time reauthorization** after upgrading.

**Token lifecycle:**
- Tokens are HMAC-SHA256-signed by the codec; the key lives in `data/secret` (auto-created; persisted across restarts). Access tokens ~24 h, refresh tokens ~90 days.
- Refresh (`POST /token`, `grant_type=refresh_token`) verifies the refresh token's signature and reloads the LINE credential by MID from `latestAuthData` (memory) or `data/auth/<mid>.json` — a missing record means the account must reauthorize. Refresh survives restart while `data/secret` and the auth record are retained.
- LINE access tokens are refreshed on-demand inside `LineClient` when < 24 h remain; `recordRefreshedAuth()` updates memory then atomically persists, preserving the profile name (persistence failure is non-fatal).
- Multiple independent LINE accounts are supported; each principal's credential is resolved by its own MID and never shared.

### Data model & one-process-per-root rule

- The **line-message cache is owner-scoped** (per MID); the **bank category/template stores are shared across every principal** on a data root by explicit design (trusted-tenant model, Task 10). Only trust principals that may share bank/category state on the same root.
- **Never run two servers against the same data root on one host.** The composed server owns bank/category data the standalone server knows nothing about, and the standalone server refuses a legacy pre-migration combined database. Under Docker, give each target its own `/data` volume.

### Docker

One multi-stage `Dockerfile`, two runtime targets. The `builder` stage (`node:24`) runs `npm ci` + `tsc -b` once, then `npm prune --omit=dev` (keeping better-sqlite3's already-compiled native addon) and strips `src`/tests/tsconfig from `packages/`. Both runtime targets use `node:24-slim` (glibc — matches the builder so the prebuilt better-sqlite3 addon loads) and copy the pruned production `node_modules` plus their own package closure:

- `--target server` → `packages/server/dist/cli.js`, whole `packages/` tree (ten tools).
- `--target line-mcp` → `packages/line-mcp/dist/cli.js`, only the four-package closure (five tools).

Both run as the non-root `node` user, expose `/data` as a volume, and healthcheck `GET ${BASE_PATH}/healthz` via Node's http client. `docker-compose.yml` defaults to the `server` target; the `line-mcp` standalone service is under the `standalone` profile with its **own** volume.

### Specs & artifact policy

- `packages/line-client/assets/ltsm/*` — LINE's proprietary WASM crypto + sandbox (binary, do not edit). Provenance/notice in `THIRD_PARTY_NOTICES.md` and `provenance.json`.
- `specs/LINE_Chrome_API_Specification.md` / `specs/LINE_Login_Protocol_Specification.md` — reverse-engineered API reference.
- **No package is published to any public registry.** CI and the artifact tests `npm pack`/install for verification only; a new public distribution form requires the issue #75 provenance review.

### Tests

- `packages/**/*.test.ts` — unit / contract / migration tests co-located with each package. Run by `npm run test:unit` alongside `tests/architecture`.
- `tests/architecture/import-boundaries.test.ts` — enforces the package dependency graph above.
- `tests/artifacts/line-client-pack.test.ts` — real `npm pack` + offline install of `@raidenyn/line-client` outside the checkout, real WASM HMAC, asserts no better-sqlite3. (CI `pack-line-client` job.)
- `tests/docker/docker-smoke.test.ts` — builds both Docker targets, runs each container against a throwaway data root, waits for `/healthz`, and asserts the tool surface over a real MCP `tools/list` (composed = ten, standalone = five). (CI `docker` job.)
- `tests/smoke/*` — strict local LINE mock + compiled composed and standalone CLIs, run as real child processes against a deterministic in-process mock gateway. `npm run test:smoke` builds the workspace once, then runs four scenarios: composed seeded credentials, standalone seeded credentials, composed full OAuth (PKCE → PIN → certificate reuse → MCP token issuance → MCP token refresh), and standalone full OAuth. Composed exercises all ten tools; standalone exercises the five messenger tools and asserts the bank surfaces are absent. Requires no `.line-auth.json`, no LINE credentials, and no Docker — the process-level compiled-CLI boundary is what distinguishes it from `test:unit` (in-process) and Docker smoke (runtime-image startup). (CI `smoke` job.)
- `tests/e2e.test.ts` — live LINE e2e; launches the composed server, seeds a `TEST_TOKEN` bypass, connects over the MCP HTTP transport. Requires `.line-auth.json`; **excluded from the PR-blocking CI gate**, run manually pre-release.
