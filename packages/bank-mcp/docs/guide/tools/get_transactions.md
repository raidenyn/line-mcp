# get_transactions

**When to use:** To extract structured transaction records from bank notification messages in a LINE chat.

**Prerequisites:** `manage_templates` must have been called at least once to save templates for this chat. Templates load automatically — no need to pass them on each call.

**Next steps:** `summarize_transactions` to aggregate totals by month, merchant, or category.

**Key parameters:**
- `chatMid`: the chat MID from `list_chats`
- `since` (ISO date string, e.g. `"2026-05-01"`): **always pass this** for complete history over a date range. Without `since`, only the latest 200 messages are scanned and a note is appended recommending `since` for accuracy.
- `until` (ISO date string): optional end bound; defaults to now
- `categories` (array of strings, optional): keep only transactions whose `category` exactly matches one of these (case-sensitive; `"uncategorized"` is a valid value)
- `original_currencies` (array of strings, optional): keep only transactions whose `original_currency` matches one of these (case-insensitive)
- `merchants` (array of regex strings, optional): keep only transactions whose `merchant` (or `rawText`, if `merchant` is absent) matches any of these patterns (case-insensitive, dotAll)
- `amount_min` / `amount_max` (numbers, optional): keep only transactions whose absolute amount (`amount` if present, else `original_amount`) falls within this inclusive range

Filters combine with AND across the different filter types above; multiple values within one filter type combine with OR (e.g. `categories: ["Coffee", "Dining"]` matches either).

**Categorization:** Every returned transaction includes a `category` field — automatically assigned from saved categories (see `manage_categories`), or `"uncategorized"` when no category pattern matches. Categories are global, not per-chat. This applies on both the saved-templates and inline-templates code paths.

**Avoid:** Don't call without `since` if you need complete monthly data — you will get incomplete results. Don't pass inline `templates` unless testing a new pattern; saved templates are already loaded automatically and apply `valid_from`/`valid_until` filtering per message. An invalid regex in `merchants` returns an error before any messages are fetched — check the pattern named in the error message.
