# LINE Messenger MCP — Usage Guide

This MCP server connects to LINE messenger and exposes tools for reading chats and importing chat history. It authenticates via OAuth (QR code scan) handled automatically by Claude Code.

This is the standalone messenger server. It exposes only the five messenger tools below. Bank transaction parsing and categorization tools (`sample_messages`, `manage_templates`, `manage_categories`, `get_transactions`, `summarize_transactions`) live in a separate package and are only present in the composed server.

## Workflow Map

| Workflow | Tool sequence |
|----------|--------------|
| Browse chats & messages | `list_chats` → `get_messages` → `get_image` (optional) |
| Import historical chat export | `initiate_import` → *(curl upload)* → `complete_import` |

## Key Facts

- **Message cache:** Every message fetched is stored in a local SQLite database. The cache persists history beyond LINE's ~2-week API window — `since` dates from months ago work without special configuration. Messages are owner-scoped: each authenticated account only ever sees its own cached history.
- **Auth:** On first use, Claude Code opens a browser QR page. Scan with the LINE mobile app. Tokens refresh automatically; no manual intervention is needed after initial setup.

## Per-Tool Guides

Read these resources for workflow context on each tool:

- `line://guide/tools/list_chats`
- `line://guide/tools/get_messages`
- `line://guide/tools/get_image`
- `line://guide/tools/initiate_import`
- `line://guide/tools/complete_import`
