# LINE MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes your LINE messenger to AI assistants. Lets Claude read your chats, messages, and images directly from LINE.

## Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List recent LINE chats |
| `get_messages` | Fetch messages from a chat |
| `get_image` | Download and return an image from a message |

## How it works

The server runs as an HTTP server using the [Streamable HTTP MCP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http). It implements OAuth 2.0, so Claude Code handles authentication natively — no manual token setup required.

**Auth flow:**
1. On first use, Claude Code detects a `401` and opens an authorization page in your browser
2. A QR code is displayed — scan it with the LINE mobile app
3. Enter the PIN if prompted (skipped on repeat logins using a saved certificate)
4. Claude Code receives tokens automatically and retries the tool call

**Token lifecycle:** MCP tokens are self-contained HMAC-signed blobs embedding LINE credentials and expiry. The signing key is stored in `.line-mcp-secret`. LINE access tokens are refreshed transparently when they near expiry.

## Usage

### Docker (recommended)

```bash
docker compose up -d
claude mcp add --transport http --scope user line http://localhost:3000/mcp
```

Call any LINE tool in Claude — the OAuth flow will trigger automatically on first use.

### Local development

**Prerequisites:** Node.js 20+

```bash
npm install
npm start          # starts HTTP MCP server on http://localhost:3000
```

```bash
claude mcp add --transport http --scope user line http://localhost:3000/mcp
```

## Commands

```bash
npm run build      # compile TypeScript → dist/
npm start          # run with ts-node (development)
npm test           # run e2e tests (requires .line-auth.json)
```

To run a single test file:
```bash
npx vitest run tests/e2e.test.ts
```

## E2E tests

Tests require a valid LINE session. Export your auth data to `.line-auth.json` in the project root, then run `npm test`. The test suite launches the server as a child process, seeds a test token to bypass OAuth, and connects over the MCP HTTP transport.

## Security notes

- `.line-mcp-secret` — auto-created on first run; backs all token signatures. Back it up; deleting it invalidates all issued tokens.
- `.line-auth.json` — contains live LINE credentials. Keep it out of version control (it is in `.gitignore`).
- The server binds to `0.0.0.0` — use a firewall or reverse proxy if exposing beyond localhost.
