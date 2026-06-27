# LINE MCP Server — Usage Guide

This MCP server connects to LINE messenger and exposes tools for reading chats, parsing bank transaction notifications, and importing chat history. It authenticates via OAuth (QR code scan) handled automatically by Claude Code.

## Workflow Map

| Workflow | Tool sequence |
|----------|--------------|
| Browse chats & messages | `list_chats` → `get_messages` → `get_image` (optional) |
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Import historical chat export | `initiate_import` → *(curl upload)* → `complete_import` |

## Key Facts

- **Message cache:** Every message fetched is stored in a local SQLite database (`data/cache/messages.db`). The cache persists history beyond LINE's ~2-week API window — `since` dates from months ago work without special configuration.
- **Templates persist:** Regex templates saved with `manage_templates` are stored per-chat in `data/templates/<chatMid>.json` and loaded automatically by `get_transactions` in all future sessions. No need to re-derive patterns each session.
- **Auth:** On first use, Claude Code opens a browser QR page. Scan with the LINE mobile app. Tokens refresh automatically; no manual intervention is needed after initial setup.

## Per-Tool Guides

Read these resources for workflow context on each tool:

- `line://guide/tools/list_chats`
- `line://guide/tools/get_messages`
- `line://guide/tools/get_image`
- `line://guide/tools/sample_messages`
- `line://guide/tools/manage_templates`
- `line://guide/tools/get_transactions`
- `line://guide/tools/summarize_transactions`
- `line://guide/tools/initiate_import`
- `line://guide/tools/complete_import`
