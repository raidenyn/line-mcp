# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # tsc → dist/
npm start            # ts-node src/index.ts  (runs the MCP server over stdio)
npm test             # vitest run (e2e tests — requires valid .line-auth.json)
```

To run a single test file:
```bash
npx vitest run tests/e2e.test.ts
```

## Architecture

This is a **LINE MCP server** — an MCP (Model Context Protocol) server that exposes LINE messenger as tools to an AI assistant. It runs over stdio and is consumed by Claude Code or any MCP-compatible client.

### Source files (`src/`)

**`index.ts`** — entry point. Registers four tools (`login`, `list_chats`, `get_messages`, `get_image`), starts stdio transport. The server is stateless: no shared `LineClient` instance. A module-level `pendingLoginClient` holds the in-flight login session; all other calls create a `LineClient` on-demand from auth data loaded from `process.env.LINE_AUTH_DATA` at startup.

**`line-client.ts`** — all LINE API logic. Targets `https://line-chrome-gw.line-apps.com`, impersonating the LINE Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Key concerns:
- **Login flow**: QR code → `checkQrCodeVerified` long-poll → `verifyCertificate` (uses saved certificate to skip PIN on repeat logins) → optional PIN confirmation (`checkPinCodeVerified`) → `qrCodeLoginV2` → `getEncryptedIdentityV3`. After completion, `getCompletedAuth()` returns the full `AuthData` for the caller to store.
- **PIN surfacing**: `list_chats` (called when `LINE_AUTH_DATA` is unset) doubles as the login-completion trigger. When a PIN is needed, `ensureAuthenticated` throws with the PIN value so the caller can display it, then waits for PIN confirmation on the next `list_chats` call.
- **Token refresh**: access tokens are refreshed when less than 24 hours from expiry. The refresh is in-memory only; the caller's stored auth data is not updated.
- **HMAC signing**: every request is signed via `getHmac()` from `ltsm.ts`.
- **Contact name resolution**: `getMessages()` fetches display names for any senders not already in the per-instance `contactNameCache`.

**`ltsm.ts`** — thin wrapper around the LINE WASM crypto sandbox. The real HMAC and storage-key logic lives in `src/ltsm/ltsm.wasm` (a WebAssembly binary extracted from the LINE Chrome extension). Running it requires a browser-like environment; `ltsm.ts` creates one with `happy-dom`, loads `src/ltsm/ltsmSandbox.js`, and communicates via `window.postMessage` using a serialized command queue (one command at a time — concurrent sends would collide on the fixed response-handler keys). The storage key is initialized per LINE account (`mid`) and cached module-wide; `ensureStorageKey` skips re-initialization when the same account is already active.

### Specs (`specs/`)

- `src/ltsm/ltsm.wasm` — LINE's WASM crypto module (binary, do not edit).
- `src/ltsm/ltsmSandbox.js` — sandbox JS that wraps the WASM; loaded via `require()` inside the happy-dom window.
- `specs/LINE_Chrome_API_Specification.md` / `specs/LINE_Login_Protocol_Specification.md` — reverse-engineered API specs used as reference.

### Tests (`tests/`)

`e2e.test.ts` is an integration test that launches the MCP server as a child process (`ts-node src/index.ts`) via `StdioClientTransport` and calls the actual LINE API. It requires a pre-existing `.line-auth.json` (read at test startup and passed to the server process as the `LINE_AUTH_DATA` environment variable). Tests run sequentially and share state across cases (the first chat MID found by `list_chats` is reused by `get_messages`).

### Auth flow

Auth data lives in the **`LINE_AUTH_DATA` environment variable** passed to the MCP server process. The `AuthData` struct holds `accessToken`, `refreshToken`, `certificate`, `mid`, and three WASM key-derivation fields (`wrappedNonce`, `kdfParameter1`, `kdfParameter2`).

**First-time login (two steps):**
1. Call `login` → returns a QR code. Scan it with the LINE mobile app.
2. Call `list_chats` (no arguments) → completes the login (entering PIN if prompted). The response includes the auth JSON and instructions to set `LINE_AUTH_DATA` in your MCP server config.

**Setting up the env var:**

In `~/.claude.json` (or `.claude/settings.json`), add an `env` block to the `line` server entry:
```json
{
  "mcpServers": {
    "line": {
      "command": "npx",
      "args": ["-y", "line-mcp"],
      "env": {
        "LINE_AUTH_DATA": "{...auth json from login...}"
      }
    }
  }
}
```
Then restart the MCP server.

**Subsequent calls:**
- `list_chats`, `get_messages`, and `get_image` take no `auth` argument — they read from `process.env.LINE_AUTH_DATA` at server startup.
- The server creates a fresh `LineClient` per call from `envAuthData`; nothing is persisted server-side.
- On re-login with a matching certificate, the PIN step is skipped.
