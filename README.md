# LINE MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes your LINE messenger to AI assistants. Lets Claude read your chats, messages, and images directly from LINE.

## Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List recent LINE chats |
| `get_messages` | Fetch messages from a chat |
| `get_image` | Download and return an image from a message |
| `get_transactions` | Parse bank notification messages into structured transactions using caller-supplied regex templates |
| `summarize_transactions` | Aggregate transactions into totals grouped by month or merchant |

### Transaction tools

Some LINE channels (e.g. UOB Thai, CardX Thailand, SCB Connect) deliver bank notifications as templated messages. The transaction tools let Claude extract structured data from them without any hardcoded parsers.

**How it works:**
1. Claude calls `get_messages` on a bank chat to inspect a few example messages
2. Claude derives a regex template with named capture groups (`amount`, `currency`, `merchant`, `date`, `balance`, `account`)
3. Claude calls `get_transactions` with that template — the server applies it to all messages and returns structured JSON; promotional/non-matching messages are silently dropped
4. Claude calls `summarize_transactions` to get totals grouped by month or merchant

**Example template for UOB Thailand:**
```json
[
  {
    "pattern": "You have spent (?<currency>\\w+) (?<amount>[\\d,]+\\.?\\d*) using UOB card \\(ending (?<account>[^)]+)\\) at (?<merchant>.+?) on (?<date>\\d{2}/\\d{2})\\. Available credit: THB (?<balance>[\\d,]+\\.?\\d*)",
    "amount_sign": "debit",
    "date_format": "DD/MM"
  }
]
```

When a bank changes its message format, Claude can derive a new template from a single example — no code changes needed.

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
npm run build        # compile TypeScript → dist/
npm start            # run with ts-node (development)
npm test             # run all tests
npm run test:unit    # run unit tests only (no LINE session required)
npm run test:e2e     # run e2e tests (requires .line-auth.json)
```

## E2E tests

Tests require a valid LINE session. Export your auth data to `.line-auth.json` in the project root, then run `npm run test:e2e`. The test suite launches the server as a child process, seeds a test token to bypass OAuth, and connects over the MCP HTTP transport.

## Security notes

- `.line-mcp-secret` — auto-created on first run; backs all token signatures. Back it up; deleting it invalidates all issued tokens.
- `.line-auth.json` — contains live LINE credentials. Keep it out of version control (it is in `.gitignore`).
- The server binds to `0.0.0.0` — use a firewall or reverse proxy if exposing beyond localhost.
