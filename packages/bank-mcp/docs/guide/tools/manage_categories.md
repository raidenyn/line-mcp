# manage_categories

**When to use:** To save, update, delete, or list global spending categories used to automatically tag transactions with a `category`.

**Prerequisites:** None — unlike templates, categories are global and not tied to a specific chat.

**Next steps:** `get_transactions` and `summarize_transactions` — categorization applies automatically to every parsed transaction, and `summarize_transactions` can group totals by `category`.

**Key parameters:**
- `action`: `upsert` | `delete` | `list`
- `category.name`: unique category name, e.g. `"Groceries"`
- `category.pattern`: regex tested against the transaction's `merchant` field (falls back to the raw message text when no merchant was captured). Matched case-insensitively; no named capture groups needed.
- `name`: category name to remove (required for `delete`)

**Matching order:** Categories are tried in the order they were created (insertion order); the first pattern that matches wins. Reordering isn't supported directly — delete and re-upsert categories in the order you want if match priority matters.

**Avoid:** Don't rely on a category matching a transaction with no `merchant` and no distinguishing text in `rawText` — those fall back to `"uncategorized"`.

**Regex safety:** Category syntax is validated before save (issue #61), so an invalid pattern is rejected at upsert time rather than failing later during transaction parsing. At match time, category patterns run in a bounded worker pool with a per-match timeout (default 100 ms, clamped to 10-1000 ms via `BANK_REGEX_TIMEOUT_MS`); a timed-out pattern fails the whole tool call rather than silently returning uncategorized results.
