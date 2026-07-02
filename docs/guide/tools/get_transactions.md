# get_transactions

**When to use:** To extract structured transaction records from bank notification messages in a LINE chat.

**Prerequisites:** `manage_templates` must have been called at least once to save templates for this chat. Templates load automatically — no need to pass them on each call.

**Next steps:** `summarize_transactions` to aggregate totals by month, merchant, or category.

**Key parameters:**
- `chatMid`: the chat MID from `list_chats`
- `since` (ISO date string, e.g. `"2026-05-01"`): **always pass this** for complete history over a date range. Without `since`, only the latest 200 messages are scanned and a note is appended recommending `since` for accuracy.
- `until` (ISO date string): optional end bound; defaults to now

**Categorization:** Every returned transaction includes a `category` field — automatically assigned from saved categories (see `manage_categories`), or `"uncategorized"` when no category pattern matches. Categories are global, not per-chat.

**Avoid:** Don't call without `since` if you need complete monthly data — you will get incomplete results. Don't pass inline `templates` unless testing a new pattern; saved templates are already loaded automatically and apply `valid_from`/`valid_until` filtering per message — note that inline `templates` calls also skip categorization, since only the saved-templates path assigns `category`.
