# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsc → dist/
npm start            # ts-node src/index.ts  (HTTP MCP server on localhost:3000)
npm test             # vitest run (e2e tests — requires valid .line-auth.json)
```

```bash
npm run test:unit    # unit tests only (no LINE session required)
npm run test:e2e     # e2e tests (requires .line-auth.json)
```

To run a single test file:
```bash
npx vitest run tests/e2e.test.ts
```

## Architecture

This is a **LINE MCP server** — an MCP (Model Context Protocol) server that exposes LINE messenger as tools to an AI assistant. It runs as an HTTP server (Streamable HTTP transport) and implements OAuth 2.0 so Claude Code handles authentication natively.

### Source files (`src/`)

**`index.ts`** — entry point. Creates an Express app, registers seven tools (`list_chats`, `get_messages`, `get_image`, `sample_messages`, `manage_templates`, `get_transactions`, `summarize_transactions`) on an `McpServer`, mounts OAuth routes from `oauth.ts`, and serves `POST /mcp` protected by bearer-token validation. Uses `AsyncLocalStorage` to pass the per-request `AuthData` into tool handlers without threading it through parameters. When `TEST_TOKEN` + `LINE_AUTH_DATA` env vars are both set, pre-seeds the token bypass so e2e tests skip the OAuth flow. Initialises `MessageCache` once at startup (`sharedCache`) and creates a `CachingLineClient` per request via `makeLineClient()`, which wires the `onTokenRefreshed` callback to update `latestAuthData` in `oauth.ts`.

- `sample_messages` — fetches raw text messages from a chat (filters `contentType === 0`, sorted oldest-first). Accepts optional `since`/`until` ISO date strings; when `since` is provided, calls `getMessagesInRange` to paginate the full history back to that date.
- `manage_templates` — CRUD for named regex templates; delegates to `template-store.ts`. Actions: `upsert`, `delete`, `list`.
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `data/templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. After parsing, calls `applyBalanceDiffs()` to populate the `amount` and `currency` fields from consecutive balance diffs for transactions that did not capture them explicitly. Returns a zero-match hint when saved templates exist but nothing matched.

### MCP Resources (`docs/guide/`)

Ten static markdown resources are registered in `index.ts` via `server.registerResource()` and served over the MCP protocol:

| URI | File |
|-----|------|
| `line://guide` | `docs/guide/overview.md` |
| `line://guide/tools/<name>` | `docs/guide/tools/<name>.md` |

Files are read from disk at request time via `fs.promises.readFile`. Missing files return an error string in the content rather than crashing. The `docs/guide/` tree is copied into the Docker image (`COPY docs/guide ./docs/guide` in `Dockerfile`).

**Maintenance rule:** When any `docs/guide/` file is added, removed, or substantively changed, update this CLAUDE.md section to match. When a new tool is added to `index.ts`, also create `docs/guide/tools/<tool_name>.md` and a corresponding `registerResource` call.

**`oauth.ts`** — OAuth 2.0 authorization server. Provides:
- `GET /.well-known/oauth-authorization-server` — CIMD-capable AS metadata
- `GET /.well-known/oauth-protected-resource` — resource server metadata (referenced from `WWW-Authenticate`)
- `GET /authorize` — starts a LINE QR login, renders an HTML page with QR code image and PIN display; polls `/authorize/poll` via JS to detect completion and auto-redirects with the auth code
- `GET /authorize/poll?sid=<id>` — JSON status endpoint polled by the authorize page
- `POST /token` — PKCE code exchange and refresh-token rotation; issues self-contained signed MCP tokens
- In-memory stores: `loginSessions`, `pendingCodes` (ephemeral login state only)
- `SERVER_SECRET` — loaded from `data/secret` on startup (created automatically if absent); used to HMAC-sign all tokens
- `validateBearerToken(token)` — verifies HMAC, checks expiry, returns embedded `AuthData`; also checks `latestAuthData` for a fresher LINE credential for the same `mid`
- `latestAuthData` — `Map<mid, AuthData>` updated via `onTokenRefreshed` callback when LINE tokens refresh mid-request; consulted on MCP token refresh so rotated LINE credentials propagate into new tokens
- `seedTestToken(token, authData)` — bypass map for e2e tests (not used in production)

**`line-client.ts`** — all LINE API logic. Targets `https://line-chrome-gw.line-apps.com`, impersonating the LINE Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Key concerns:
- **Login flow**: QR code → `checkQrCodeVerified` long-poll → `verifyCertificate` (uses saved certificate to skip PIN on repeat logins) → optional PIN confirmation (`checkPinCodeVerified`) → `qrCodeLoginV2` → `getEncryptedIdentityV3`. After completion, `getCompletedAuth()` returns the full `AuthData`.
- **PIN surfacing for OAuth**: `waitForPin()` and `waitForCompletion()` are public methods used by `oauth.ts` to monitor the background login without going through `ensureAuthenticated()`.
- **Token refresh**: LINE access tokens are refreshed when less than 24 hours from expiry. Uses a static `refreshLocks = Map<mid, Promise>` so concurrent requests for the same user share one in-flight refresh rather than racing. The `onTokenRefreshed` constructor callback is fired once per refresh so callers can persist the updated credentials.
- **HMAC signing**: every request is signed via `getHmac()` from `ltsm.ts`.
- **Contact name resolution**: `getMessages()` fetches display names for any senders not already in the per-instance `contactNameCache`.

**`template-store.ts`** — file-based persistence for named transaction templates. Stores one JSON file per chat MID under `data/templates/<chatMid>.json`. Exports:
- `loadTemplates(chatMid)` → `{ templates, warning? }` — reads file; automatically migrates old `(?<amount>...)` and `(?<currency>...)` capture group names to `(?<original_amount>...)` and `(?<original_currency>...)` and rewrites the file in place on first load; returns `[]` on absence or corruption (with warning).
- `upsertTemplate(chatMid, template)` — inserts or replaces by `name`.
- `deleteTemplate(chatMid, name)` → `boolean`.
- `listTemplates(chatMid)` → `NamedTemplate[]`.
- `filterByTime(templates, timestampMs)` — keeps entries where `timestampMs` falls within `[valid_from, valid_until]`; used per-message in `get_transactions` so time-bounded templates apply correctly across format changes.
- `NamedTemplateSchema` — extends `TransactionTemplateSchema` with `name` (required), `valid_from`, `valid_until` (ISO 8601 with timezone offset).
- Path traversal guard: chatMid validated against `/^[a-zA-Z0-9_-]+$/` before any I/O.
- All functions accept an optional `storeDir` parameter (default: `<cwd>/data/templates`) for test isolation without mocking.

**`transaction-parser.ts`** — template-driven transaction parser. Exports `parseTransaction(message, templates)` which applies an ordered list of caller-supplied regex patterns (named capture groups: `original_amount`, `original_currency` (required); `amount`, `currency`, `merchant`, `date`, `balance`, `account` (optional)) to a single message and returns a `Transaction` or `null`. The `amount` group captures the native-currency amount explicitly; if absent, `applyBalanceDiffs()` computes it from consecutive balance diffs after the full list is built. `currency` captures the account default currency (e.g. "THB"); `original_currency` captures the transaction currency (e.g. "USD" for foreign spends). Also exports `summarize(transactions, groupBy, since, until)` for pure-math aggregation — uses `amount`/`currency` when present, falls back to `original_amount`/`original_currency` per transaction. Exports `applyBalanceDiffs(transactions)` which mutates a sorted array in place: groups by `account`, then fills `amount = balance - prevBalance` for transactions missing an explicit `amount`, and stamps `currency` = the dominant `original_currency` in the group (most-common wins; tie → no stamp → `summarize` reports "mixed"). No LINE API calls; used directly by the `get_transactions` and `summarize_transactions` tool handlers in `index.ts`. The `'s'` (dotAll) flag is applied to all patterns so `.` matches newlines in bilingual messages (e.g. UOB Thai + English in one blob).

**`message-cache.ts`** — SQLite-backed message cache. Wraps `better-sqlite3` with a single `messages` table (`chat_mid`, `message_id`, `created_time INTEGER`, `raw_json`). `INSERT OR REPLACE` deduplicates on re-fetch. Index on `(chat_mid, created_time)` for fast range queries. Key methods: `upsertMessages`, `getMessages(sinceMs?, untilMs?)` (oldest-first), `latestTimestamp(chatMid)` (returns highest `created_time` or `null`). Database file lives at `data/cache/messages.db` (created automatically); `:memory:` accepted for tests.

**`caching-line-client.ts`** — `CachingLineClient` wraps a `LineClient` and a `MessageCache`. Overrides `getMessages` and `getMessagesInRange`: fetches only messages newer than `cache.latestTimestamp()` from LINE (topping up the cache), then reads the full requested range from SQLite. Always resolves sender names before writing to cache so cached messages always carry display names. All other `LineClient` methods (`listChats`, `getImageBuffer`, `waitForPin`, `waitForCompletion`, `getCompletedAuth`) are forwarded directly.

**`ltsm.ts`** — thin wrapper around the LINE WASM crypto sandbox. The real HMAC and storage-key logic lives in `src/ltsm/ltsm.wasm` (a WebAssembly binary extracted from the LINE Chrome extension). Running it requires a browser-like environment; `ltsm.ts` creates one with `happy-dom`, loads `src/ltsm/ltsmSandbox.js`, and communicates via `window.postMessage` using a serialized command queue (one command at a time — concurrent sends would collide on the fixed response-handler keys). The storage key is initialized per LINE account (`mid`) and cached module-wide; `ensureStorageKey` skips re-initialization when the same account is already active.

### Specs (`specs/`)

- `src/ltsm/ltsm.wasm` — LINE's WASM crypto module (binary, do not edit).
- `src/ltsm/ltsmSandbox.js` — sandbox JS that wraps the WASM; loaded via `require()` inside the happy-dom window.
- `specs/LINE_Chrome_API_Specification.md` / `specs/LINE_Login_Protocol_Specification.md` — reverse-engineered API specs used as reference.

### Tests (`tests/`)

`e2e.test.ts` launches the MCP server as a child process (`ts-node src/index.ts`) over HTTP on port 13117. It reads `.line-auth.json`, passes the contents as `LINE_AUTH_DATA` and a random hex string as `TEST_TOKEN` to the server process. The server calls `seedTestToken(TEST_TOKEN, authData)` which adds the token to an in-memory bypass map, so the test client connects over `StreamableHTTPClientTransport` with that token already valid — no OAuth flow needed. Tests run sequentially and share state across cases.

### Auth flow

**Transport**: Streamable HTTP on `http://localhost:PORT` (default port 3000). Claude Code adds the server as an HTTP MCP connector.

**First-time setup:**
1. Start the server: `npm start`
2. Add to Claude Code: `claude mcp add --transport http --scope user line http://localhost:3000/mcp`
3. Call any tool — Claude Code detects the `401` response, opens the LINE QR page in a browser
4. Scan the QR code with the LINE mobile app; enter PIN if prompted
5. Claude Code receives tokens automatically and retries the tool call

**Token lifecycle:**
- MCP tokens are self-contained HMAC-SHA256-signed blobs embedding the user's `AuthData` and expiry — the server is stateless and holds no token maps
- The signing key lives in `data/secret` (auto-created on first run, persisted across restarts); tokens issued before a restart remain valid as long as the file is not deleted
- MCP tokens expire after 24 hours; Claude Code refreshes them proactively via `POST /token` with `grant_type=refresh_token`; the server verifies the refresh token's signature, looks up any fresher LINE credentials in `latestAuthData`, and issues new signed tokens
- LINE access tokens are refreshed on-demand inside `LineClient.refreshIfExpired()` when < 24 h remain; the `onTokenRefreshed` callback updates `latestAuthData` so the next MCP token refresh embeds the latest LINE credentials
- Multiple independent LINE accounts are supported: each user's `AuthData` is embedded in their own MCP tokens and never shared with other users
