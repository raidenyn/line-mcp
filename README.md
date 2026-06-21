# LINE MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes your LINE messenger to AI assistants. Lets Claude read your chats, messages, and images directly from LINE.

## Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List recent LINE chats |
| `get_messages` | Fetch messages from a chat |
| `get_image` | Download and return an image from a message |
| `sample_messages` | Fetch raw text messages with timestamps; accepts optional `since`/`until` for historical ranges — use before writing regex templates |
| `manage_templates` | Save, update, delete, or list regex templates for a chat (persisted in `.line-templates/`) |
| `get_transactions` | Parse bank notifications into structured transactions; paginates the full history when `since` is given; auto-loads saved templates |
| `summarize_transactions` | Aggregate transactions into totals grouped by month or merchant |

### Transaction tools

Some LINE channels (e.g. UOB Thai, CardX Thailand, SCB Connect) deliver bank notifications as templated messages. The transaction tools let Claude extract structured data from them without any hardcoded parsers.

Templates are saved per-chat on the server and loaded automatically — no need to re-derive patterns each session.

**Workflow (first time for a new bank chat):**
1. Call `sample_messages` to inspect raw message text — pass `since` to reach older messages if the bank changed its format months ago
2. Call `manage_templates` (`action: upsert`) to save a named regex template with capture groups
3. Call `get_transactions` with no `templates` argument — saved templates are loaded automatically
4. Call `summarize_transactions` to get totals grouped by month or merchant

**Workflow (subsequent sessions):**
- Just call `get_transactions` — templates are already saved.

Templates support `valid_from` / `valid_until` (ISO 8601 with timezone) so that old messages are handled by old templates and new messages by new ones when a bank changes its format.

**Example — UOB Thai** (bilingual Thai+English messages, non-breaking spaces around "Available credit"):
```json
{
  "name": "uob-debit",
  "pattern": "You\\s+have\\s+spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,]+\\.?\\d*)\\s+using\\s+UOB\\s+card\\s+\\(ending\\s+(?<account>[^)]+)\\)\\s+at\\s+(?<merchant>.+?)\\s+on\\s+(?<date>\\d{2}/\\d{2})\\.\\s+Available\\s+credit:\\s+THB\\s+(?<balance>[\\d,]+\\.?\\d*)",
  "amount_sign": "debit",
  "date_format": "DD/MM"
}
```

**Example — CardX Thailand** (English-only, date format "9 Jun 26"):
```json
{
  "name": "cardx-debit",
  "pattern": "CardX\\s+would\\s+like\\s+to\\s+inform\\s+that\\s+you\\s+have\\s+made\\s+transaction\\s+via\\s+card\\s+ending\\s+with\\s+(?<account>\\d+)\\s+at\\s+(?<merchant>.+?)\\s+in\\s+the\\s+amount\\s+of\\s+(?<amount>[\\d,]+\\.?\\d*)\\s+(?<currency>[A-Z]+)\\s+on\\s+(?<date>.+?)\\.\\s+You\\s+have\\s+available\\s+credit\\s+limit\\s+(?<balance>[\\d,]+\\.?\\d*)",
  "amount_sign": "debit"
}
```

> **Tip:** Use `\\s+` instead of a literal space throughout patterns. LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches.

> **Tip:** Pass `since` to `get_transactions` (e.g. `since: "2026-05-01"`) to fetch the complete history for a month. Without `since`, only the latest 200 messages are checked.

When a bank changes its message format, save a new template with an appropriate `valid_from` date — no code changes needed.

## How it works

The server runs as an HTTP server using the [Streamable HTTP MCP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http). It implements OAuth 2.0, so Claude Code handles authentication natively — no manual token setup required.

**Auth flow:**
1. On first use, Claude Code detects a `401` and opens an authorization page in your browser
2. A QR code is displayed — scan it with the LINE mobile app
3. Enter the PIN if prompted (skipped on repeat logins using a saved certificate)
4. Claude Code receives tokens automatically and retries the tool call

**Token lifecycle:** MCP tokens are self-contained HMAC-signed blobs embedding LINE credentials and expiry. The signing key is stored in `.line-mcp-secret`. LINE access tokens are refreshed transparently when they near expiry.

**Message cache:** Every message fetched from LINE is automatically stored in a local SQLite database (`.line-cache/messages.db`). On subsequent calls, the server reads from the cache first and only fetches messages newer than the latest cached entry from LINE. This means history older than LINE's ~2-week API window remains accessible indefinitely — `since` dates from months ago work without any special configuration.

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
