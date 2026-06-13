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

**`index.ts`** — entry point. Instantiates `LineClient` and `McpServer`, registers four tools (`login`, `list_chats`, `get_messages`, `get_image`), starts stdio transport. Auth state is persisted to `.line-auth.json` in the working directory.

**`line-client.ts`** — all LINE API logic. Targets `https://line-chrome-gw.line-apps.com`, impersonating the LINE Chrome extension (`ophjlpahpchlmihnnnihgmmeilfjmjjc`). Key concerns:
- **Login flow**: QR code → `checkQrCodeVerified` long-poll → `verifyCertificate` (uses saved certificate to skip PIN on repeat logins) → optional PIN confirmation (`checkPinCodeVerified`) → `qrCodeLoginV2` → `getEncryptedIdentityV3`.
- **PIN surfacing**: `list_chats` doubles as the login-completion trigger. When a PIN is needed, `ensureAuthenticated` throws with the PIN value so the caller can display it, then waits for PIN confirmation on the next `list_chats` call.
- **Token refresh**: access tokens are refreshed when less than 24 hours from expiry.
- **HMAC signing**: every request is signed via `getHmac()` from `ltsm.ts`.

**`ltsm.ts`** — thin wrapper around the LINE WASM crypto sandbox. The real HMAC and storage-key logic lives in `specs/raw/ltsm/ltsm.wasm` (a WebAssembly binary extracted from the LINE Chrome extension). Running it requires a browser-like environment; `ltsm.ts` creates one with `happy-dom`, loads `specs/raw/ltsm/ltsmSandbox.js`, and communicates via `window.postMessage` using a serialized command queue (one command at a time — concurrent sends would collide on the fixed response-handler keys).

### Specs (`specs/`)

- `specs/raw/ltsm/ltsm.wasm` — LINE's WASM crypto module (binary, do not edit).
- `specs/raw/ltsm/ltsmSandbox.js` — sandbox JS that wraps the WASM; loaded via `require()` inside the happy-dom window.
- `specs/LINE_Chrome_API_Specification.md` / `specs/LINE_Login_Protocol_Specification.md` — reverse-engineered API specs used as reference.

### Tests (`tests/`)

`e2e.test.ts` is an integration test that launches the MCP server as a child process (`ts-node src/index.ts`) via `StdioClientTransport` and calls the actual LINE API. It requires a pre-existing `.line-auth.json` (i.e., the user has already logged in). Tests run sequentially and share state across cases (the first chat MID found by `list_chats` is reused by `get_messages`).

### Auth persistence

`LineClient` stores auth data in `.line-auth.json` (path passed to the constructor). The file holds `accessToken`, `refreshToken`, `certificate`, `mid`, and three WASM key-derivation fields (`wrappedNonce`, `kdfParameter1`, `kdfParameter2`). On re-login with a matching certificate, the PIN step is skipped.
