# LINE MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes your LINE messenger — and, optionally, template-driven parsing of bank notifications delivered over LINE — as tools to an AI assistant such as Claude Code.

It ships as a **modular npm-workspace monorepo** that builds into two runnable servers:

- **Composed server** (`@raidenyn/server`, the default) — all **ten** tools: five messenger tools plus five bank/transaction tools.
- **Standalone messenger server** (`@raidenyn/line-mcp`) — the **five** messenger tools only, with no bank code, no bank data, and a smaller dependency and Docker footprint.

## Packages

Six workspace packages under `packages/*`, with a strict, one-directional dependency graph (enforced by `tests/architecture/import-boundaries.test.ts`):

| Package | Role | Depends on |
|---------|------|-----------|
| `@raidenyn/line-client` | LINE Chrome-extension API client: QR login, message fetch, image download, WASM HMAC signing (LTSM). No SQLite. | — (`happy-dom`, bundled) |
| `@raidenyn/line-client-sqlite` | SQLite-backed message cache + persistence-migration primitives, wrapping the client. | `line-client`, `better-sqlite3` |
| `@raidenyn/mcp-runtime` | Generic, product-agnostic MCP-over-HTTP scaffolding: Express host, per-request server/transport, token codec, one `AuthProvider`. Imports no product package. | `express`, MCP SDK (peer) |
| `@raidenyn/line-mcp` | Messenger product: the five messenger tools + guides, OAuth/LINE auth provider, import service, sync loop, and the **standalone** server. | `line-client`, `line-client-sqlite`, `mcp-runtime` |
| `@raidenyn/bank-mcp` | Bank product: the five transaction tools + guides, template/category/preset stores, parser, FX. Imports no `line-mcp`. | `line-client`, `mcp-runtime`, `better-sqlite3` |
| `@raidenyn/server` | Composition root — the **only** package importing both product packages; wires them onto `mcp-runtime` and owns the data root, secret, and legacy-persistence migration. | all of the above + MCP SDK |

## Tools

**Messenger (both servers):**

| Tool | Description |
|------|-------------|
| `list_chats` | List recent LINE chats |
| `get_messages` | Fetch messages from a chat |
| `get_image` | Download and return an image from a message |
| `initiate_import` | Begin a LINE chat-export upload (returns an upload link) |
| `complete_import` | Finalize an uploaded export into the message cache |

**Bank / transactions (composed server only):**

| Tool | Description |
|------|-------------|
| `sample_messages` | Fetch raw text messages with timestamps; accepts `since`/`until` for historical ranges — use before writing regex templates |
| `manage_templates` | Save, update, delete, list regex templates + currency aliases; discover/apply built-in bank presets |
| `manage_categories` | CRUD for global spending categories (not scoped per chat) |
| `get_transactions` | Parse bank notifications into structured transactions; paginates full history with `since`; auto-loads saved templates; filters by category, currency, merchant regex, amount range |
| `summarize_transactions` | Aggregate transactions into totals grouped by month, merchant, or category |

### Transaction workflow

Some LINE channels (e.g. UOB Thai, CardX Thailand, SCB Connect) deliver bank notifications as templated messages. The bank tools extract structured data from them without any hardcoded parsers; templates are saved per-chat on the server and auto-loaded.

1. `sample_messages` — inspect raw text; pass `since` to reach older messages if the bank changed format months ago.
2. `manage_templates` (`action: upsert`) — save a named regex; required capture groups are `(?<original_amount>...)` and `(?<original_currency>...)`; add `(?<balance>...)` to enable native-currency `amount` from balance diffs. Or `apply_preset` to bootstrap from a built-in bank preset.
3. `get_transactions` — call with no `templates`; saved templates load automatically.
4. `summarize_transactions` — totals grouped by month, merchant, or category.

Templates support `valid_from` / `valid_until` (ISO 8601 with timezone) so old messages use old templates and new ones use new templates when a bank changes format.

> **Tip:** Use `\s+` instead of literal spaces — LINE bank messages frequently contain non-breaking spaces (U+00A0) that break literal-space matches.
> **Tip:** Pass `since` (e.g. `since: "2026-05-01"`) to fetch complete history; without it only the latest 200 messages are checked.
> **Tip:** Narrow with filters (`categories`, `original_currencies`, `merchants`, `amount_min`, `amount_max`) — AND across types, OR within a type.

## How it works

The server runs over the [Streamable HTTP MCP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http) and implements OAuth 2.0, so Claude Code handles authentication natively. Every `POST /mcp` gets a freshly constructed MCP server and transport; the resolved principal is passed explicitly (no ambient `AsyncLocalStorage`).

**Auth flow (first use):** Claude Code detects a `401`, opens an authorization page, you pick a saved LINE account (if several exist) by profile name, scan the QR with that account, enter the PIN on first login or when LINE rejects an old certificate, and Claude Code receives tokens automatically and retries.

**⚠️ Breaking token cutover (one-time reauthorization):** MCP tokens are now finite-lived, **MID-only**, schema-checked claims (`version`/`kind`/`issuer`/`audience`/`scope`/`expiry`). They embed **no** LINE credential. The two historical embedded-credential token formats have no `version`/`kind` field and are rejected outright — never migrated. **Every previously issued token must be re-authorized once** after upgrading to this modular server. `data/secret` still signs tokens and, together with the `data/auth/<mid>.json` records, keeps refresh tokens valid across restarts.

**Message cache:** Every fetched message is stored in a local SQLite DB. Later calls read the cache first and fetch only messages newer than the latest cached entry, so history older than LINE's ~2-week API window stays accessible — `since` dates from months ago just work. The line-message cache is **owner-scoped**: the same chat/message IDs under two different MIDs stay isolated.

**Trusted-tenant bank data:** By explicit design (issue #75, Task 10), the bank **category and template stores are shared across every principal** on a data root — unlike the owner-scoped message cache. Only trust principals that may share bank/category state on the same data root.

**Legacy persistence migration:** On first start against a pre-modular data root, the composed server performs a one-time migration of the old combined `cache/messages.db` into separate per-generation line and bank databases. Rows whose owning MID cannot be unambiguously determined are **quarantined** (never dropped or arbitrarily assigned) and can be recovered later. The migration is generation-based and pointer-committed: an interrupted restart (before or after the pointer is published) converges on a single authoritative generation. Category IDs and order survive migration and remain shared across principals.

**Regex execution safety:** All bank template, category, merchant-filter, and preset regexes execute in a bounded worker pool rather than on the server event loop. Each match has a 100 ms budget by default. Set `BANK_REGEX_TIMEOUT_MS` to tune the budget; values are clamped to 10-1000 ms. Invalid or timed-out patterns fail the entire tool call so financial results are never silently partial.

### One process per data root

Never run two servers against the same data root on one host. The composed server owns bank/category data the standalone server knows nothing about, and the **standalone server refuses to start** if it finds a legacy pre-migration combined database with no committed pointer (run the composed server once first to migrate, then start the standalone server). Under Docker, give each server its own data volume.

## Usage

### Docker (recommended)

Two build targets share one multi-stage `Dockerfile`:

```bash
# Composed server (ten tools) — the docker-compose default
docker compose up -d line-mcp-full
claude mcp add --transport http --scope user line http://localhost:3000/mcp

# Standalone messenger server (five tools) — its OWN data volume
docker compose --profile min up -d line-mcp
# → listens on host port 3100
```

Or build the targets directly:

```bash
docker build --target server    -t line-mcp-full:latest      .
docker build --target line-mcp  -t line-mcp-standalone:latest .
```

Both images build once with Node 24, ship only their own compiled package closure plus production dependencies, run as a non-root `node` user with `/data` as a volume, and expose `GET ${BASE_PATH}/healthz`. To run behind a reverse proxy under a URL prefix, set `BASE_PATH` (e.g. `BASE_PATH=/line-mcp`) and include the same prefix in the `claude mcp add` URL. The composed (`server`) target also honors `BANK_REGEX_TIMEOUT_MS` (per-regex-operation timeout, clamped to 10-1000 ms, default 100); the standalone (`line-mcp`) target has no bank tools and ignores it.

### Local development

**Prerequisites:** Node.js 24

```bash
npm install
npm run build                # tsc -b — composite build of all six packages
npm start                    # composed server on http://localhost:3000
node packages/line-mcp/dist/cli.js   # standalone messenger server
```

The composed server reads `BANK_REGEX_TIMEOUT_MS` (milliseconds) to tune the per-regex-operation budget for the bank tools; unset or non-numeric values use the 100 ms default, and the value is clamped to 10-1000 ms. The standalone messenger server has no bank tools and ignores this variable.

## Commands

```bash
npm run build       # tsc -b — composite build across all six packages
npm run clean       # tsc -b --clean
npm start           # run the composed server (packages/server/dist/cli.js)
npm run lint        # eslint .
npm run test:unit   # in-process unit / contract / migration + import-boundary tests (no LINE session, no Docker)
npm run test:smoke  # strict local LINE mock + compiled composed and standalone CLIs, seeded and full OAuth paths (no credentials, no Docker)
npm run test:e2e    # live LINE e2e (requires .line-auth.json)
```

Extra deterministic gates (run explicitly; also wired into CI):

```bash
npx vitest run tests/artifacts/line-client-pack.test.ts   # packed line-client: offline install, WASM, no SQLite
npx vitest run tests/docker/docker-smoke.test.ts          # both Docker targets: healthz + real MCP tools/list
```

### Test suites

The repository ships four distinct test surfaces:

- **`test:unit`** — in-process unit, contract, and migration tests plus the package import-boundary guard. No LINE session, no Docker.
- **`test:smoke`** — strict local LINE mock plus the **compiled** composed (`packages/server/dist/cli.js`) and standalone (`packages/line-mcp/dist/cli.js`) CLIs, run as real child processes against a deterministic in-process mock gateway. Four scenarios: composed seeded credentials, standalone seeded credentials, composed full OAuth (PKCE → PIN → certificate reuse → MCP token issuance → MCP token refresh), and standalone full OAuth. The composed scenario exercises all ten MCP tools; the standalone scenario exercises all five messenger tools and asserts the bank surfaces are absent. Requires no `.line-auth.json`, no LINE credentials, and no Docker.
- **`test:e2e`** — manual live LINE account verification. Export a real session to `.line-auth.json`, then run; the suite launches the composed server, seeds a `TEST_TOKEN` bypass, and connects over the MCP HTTP transport. Excluded from the PR-blocking CI gate; run as a pre-release check.
- **Docker smoke** — runtime-image startup and the exact tool surface per container (composed = ten tools, standalone = five) over a real MCP `tools/list`. Run via `tests/docker/docker-smoke.test.ts`.

`LINE_API_BASE_URL` may be set in tests or local development to point the LINE client at a different gateway (the smoke suite sets it to the local mock). Production deployments leave it unset: the default gateway is LINE, and any configured override still receives real LINE authorization headers, so only point it at a trusted endpoint.

## CI

`.github/workflows/ci.yml` runs four parallel jobs on pull requests and pushes to `main`:

- **check** — `npm ci` → lint → `tsc -b` → unit/contract/migration tests → import-boundary test → `npm ls --all`.
- **smoke** — `npm ci` → `npm run test:smoke`: builds the workspace once, then runs both compiled CLI targets against the strict local LINE mock. No credentials, no Docker.
- **pack-line-client** — real `npm pack` → clean offline install outside the checkout → JS load + real WASM HMAC → TS compile → asserts no `better-sqlite3`.
- **docker** — build both targets → smoke each container over a real MCP `tools/list` roundtrip.

The **live LINE e2e suite is intentionally excluded** from this PR-blocking gate; it needs real credentials and is a manual pre-release check.

## Package artifact & provenance policy

- **No public publish.** No package is published to the public npm registry (or any public index). CI and the artifact tests `npm pack`/install for verification only — never `npm publish`. A new public distribution form requires the provenance review described in issue #75.
- **LTSM assets (`@raidenyn/line-client`).** `assets/ltsm/ltsm.wasm` and `ltsmSandbox.js` are proprietary artifacts copied as-is from the LINE Chrome extension (owned by LINE Corporation) — see `packages/line-client/THIRD_PARTY_NOTICES.md` and `assets/ltsm/provenance.json`. Approved distribution: this repo, Docker images built from it, and internal tarballs. Public publication is **not approved** pending legal review. `line-client` bundles `happy-dom` (via `bundledDependencies`) so a consumer needs no registry access, and it carries **no** `better-sqlite3`.

## Security notes

- `data/secret` — auto-created on first run; backs all token signatures. Back it up; deleting it invalidates every issued token.
- `data/auth/*.json` — live LINE credentials, written `0600` beneath a `0700` directory. Keep private and out of version control.
- `.line-auth.json` — live LINE credentials; keep out of version control (it is in `.gitignore`).
- The server binds `0.0.0.0` — use a firewall or reverse proxy if exposing beyond localhost.
