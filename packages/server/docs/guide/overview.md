# LINE MCP Server — Usage Guide

This MCP server connects to LINE messenger and exposes tools for reading chats, parsing bank transaction notifications, and importing chat history. It authenticates via OAuth (QR code scan) handled automatically by Claude Code.

## Workflow Map

| Workflow | Tool sequence |
|----------|--------------|
| Set up the expense ledger | `ledger_status` (expect `setup_required`) → `manage_accounts` (`add_source` with `base_currency` + `owner_timezone`) → `ledger_status` |
| Browse chats & messages | `list_chats` → `get_messages` → `get_image` (optional) |
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Categorize transactions | `manage_categories` (any time) → categorization is applied automatically inside `get_transactions` / `summarize_transactions` |
| Import historical chat export | `initiate_import` → *(curl upload)* → `complete_import` |

## Key Facts

- **The ledger is per account:** `ledger_status` and `manage_accounts` keep one owner's base currency, timezone and sources; another account on the same server never sees them. The base currency is set once with the first source.
- **Message cache:** Every message fetched is stored in a local SQLite database (`data/cache/messages.db`). The cache persists history beyond LINE's ~2-week API window — `since` dates from months ago work without special configuration.
- **Templates persist:** Regex templates saved with `manage_templates` are stored per-chat in `data/templates/<chatMid>.json` and loaded automatically by `get_transactions` in all future sessions. No need to re-derive patterns each session.
- **Categories persist:** Spending categories saved with `manage_categories` are stored globally in `data/cache/messages.db` (not per-chat) and applied automatically to every transaction returned by `get_transactions` and `summarize_transactions`.
- **Filtering:** `get_transactions` and `summarize_transactions` both accept `categories`, `original_currencies`, `merchants` (regex), `amount_min`, and `amount_max` to narrow results — different filter types AND together, multiple values within one type OR together.
- **Auth:** On first use, Claude Code opens a browser QR page. Scan with the LINE mobile app. Tokens refresh automatically; no manual intervention is needed after initial setup.

## Per-Tool Guides

Read these resources for workflow context on each tool:

- `line://guide/tools/list_chats`
- `line://guide/tools/get_messages`
- `line://guide/tools/get_image`
- `line://guide/tools/sample_messages`
- `line://guide/tools/manage_templates`
- `line://guide/tools/manage_categories`
- `line://guide/tools/get_transactions`
- `line://guide/tools/summarize_transactions`
- `line://guide/tools/initiate_import`
- `line://guide/tools/complete_import`
- `line://guide/tools/ledger_status`
- `line://guide/tools/manage_accounts`
