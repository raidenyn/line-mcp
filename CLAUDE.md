# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsc → dist/
npm start            # ts-node src/index.ts  (HTTP MCP server on localhost:3000)
npm test             # vitest run (e2e tests — requires valid .line-auth.json)
```

To run a single test file:
```bash
npx vitest run tests/e2e.test.ts
```

## Architecture

This is a **LINE MCP server** — an MCP (Model Context Protocol) server that exposes LINE messenger as tools to an AI assistant. It runs as an HTTP server (Streamable HTTP transport) and implements OAuth 2.0 so Claude Code handles authentication natively.

### Source files (`src/`)

**`index.ts`** — entry point. Creates an Express app, registers three tools (`list_chats`, `get_messages`, `get_image`) on an `McpServer`, mounts OAuth routes from `oauth.ts`, and serves `POST /mcp` protected by bearer-token validation. Uses `AsyncLocalStorage` to pass the per-request `AuthData` into tool handlers without threading it through parameters. When `TEST_TOKEN` + `LINE_AUTH_DATA` env vars are both set, pre-seeds the token bypass so e2e tests skip the OAuth flow. Creates `LineClient` via `makeLineClient()`, which wires the `onTokenRefreshed` callback to update `latestAuthData` in `oauth.ts`.

**`oauth.ts`** — OAuth 2.0 authorization server. Provides:
- `GET /.well-known/oauth-authorization-server` — CIMD-capable AS metadata
- `GET /.well-known/oauth-protected-resource` — resource server metadata (referenced from `WWW-Authenticate`)
- `GET /authorize` — starts a LINE QR login, renders an HTML page with QR code image and PIN display; polls `/authorize/poll` via JS to detect completion and auto-redirects with the auth code
- `GET /authorize/poll?sid=<id>` — JSON status endpoint polled by the authorize page
- `POST /token` — PKCE code exchange and refresh-token rotation; issues self-contained signed MCP tokens
- In-memory stores: `loginSessions`, `pendingCodes` (ephemeral login state only)
- `SERVER_SECRET` — loaded from `.line-mcp-secret` on startup (created automatically if absent); used to HMAC-sign all tokens
- `validateBearerToken(token)` — verifies HMAC, checks expiry, returns embedded `AuthData`; also checks `latestAuthData` for a fresher LINE credential for the same `mid`
- `latestAuthData` — `Map<mid, AuthData>` updated via `onTokenRefreshed` callback when LINE tokens refresh mid-request; consulted on MCP token refresh so rotated LINE credentials propagate into new tokens
- `seedTestToken(token, authData)` — bypass map for e2e tests (not used in production)

**`line-client.ts`** — all LINE API logic. Targets `https://line-chrome-gw.line-apps.com`, impersonating the LINE Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Key concerns:
- **Login flow**: QR code → `checkQrCodeVerified` long-poll → `verifyCertificate` (uses saved certificate to skip PIN on repeat logins) → optional PIN confirmation (`checkPinCodeVerified`) → `qrCodeLoginV2` → `getEncryptedIdentityV3`. After completion, `getCompletedAuth()` returns the full `AuthData`.
- **PIN surfacing for OAuth**: `waitForPin()` and `waitForCompletion()` are public methods used by `oauth.ts` to monitor the background login without going through `ensureAuthenticated()`.
- **Token refresh**: LINE access tokens are refreshed when less than 24 hours from expiry. Uses a static `refreshLocks = Map<mid, Promise>` so concurrent requests for the same user share one in-flight refresh rather than racing. The `onTokenRefreshed` constructor callback is fired once per refresh so callers can persist the updated credentials.
- **HMAC signing**: every request is signed via `getHmac()` from `ltsm.ts`.
- **Contact name resolution**: `getMessages()` fetches display names for any senders not already in the per-instance `contactNameCache`.

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
- The signing key lives in `.line-mcp-secret` (auto-created on first run, persisted across restarts); tokens issued before a restart remain valid as long as the file is not deleted
- MCP tokens expire after 24 hours; Claude Code refreshes them proactively via `POST /token` with `grant_type=refresh_token`; the server verifies the refresh token's signature, looks up any fresher LINE credentials in `latestAuthData`, and issues new signed tokens
- LINE access tokens are refreshed on-demand inside `LineClient.refreshIfExpired()` when < 24 h remain; the `onTokenRefreshed` callback updates `latestAuthData` so the next MCP token refresh embeds the latest LINE credentials
- Multiple independent LINE accounts are supported: each user's `AuthData` is embedded in their own MCP tokens and never shared with other users
