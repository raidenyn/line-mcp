# Bank Transaction Tools — Usage Guide

These tools turn bank notification messages from a LINE chat into structured, categorized transactions. They read messages through the same LINE connection used by the messenger tools, then parse them locally with regex templates you save per chat.

## Workflow Map

| Workflow | Tool sequence |
|----------|--------------|
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Categorize transactions | `manage_categories` (any time) → categorization is applied automatically inside `get_transactions` / `summarize_transactions` |

## Key Facts

- **Templates persist per chat:** Regex templates saved with `manage_templates` are stored per-chat in `data/templates/<chatMid>.json` and loaded automatically by `get_transactions` in all future sessions. No need to re-derive patterns each session.
- **Categories are global:** Spending categories saved with `manage_categories` apply across every chat (not per-chat) and are applied automatically to every transaction returned by `get_transactions` and `summarize_transactions`.
- **Templates and categories are shared, not per-account:** on one data root every account sees the same saved templates and categories — the intentional trusted-tenant model.
- **Built-in presets:** `manage_templates` (action: list_presets / apply_preset) bootstraps templates for common banks; `sample_messages` hints when a preset would cover messages your saved templates miss.
- **Filtering:** `get_transactions` and `summarize_transactions` both accept `categories`, `original_currencies`, `merchants` (regex), `amount_min`, and `amount_max` to narrow results — different filter types AND together, multiple values within one type OR together.
- **`since` matters:** without `since`, only the latest 200 messages are checked. Pass `since` to page the full history for an accurate time range.

## Per-Tool Guides

Read these resources for workflow context on each tool:

- `line://guide/tools/sample_messages`
- `line://guide/tools/manage_templates`
- `line://guide/tools/manage_categories`
- `line://guide/tools/get_transactions`
- `line://guide/tools/summarize_transactions`
