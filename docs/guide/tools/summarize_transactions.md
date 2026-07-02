# summarize_transactions

**When to use:** To aggregate parsed transaction data into totals grouped by month, merchant, or category.

**Prerequisites:** `get_transactions` — this tool operates on the same parsed data pipeline. For category grouping, set up categories first via `manage_categories`.

**Next steps:** None — this is the final step in the transaction workflow.

**Key parameters:**
- `chatMid`: the chat MID
- `group_by`: `month` | `merchant` | `category`
- `since` / `until`: filter the aggregation window (ISO date strings)

**Avoid:** Don't call before `get_transactions` has run with a `since` range covering the period you want to summarize — the result will be incomplete. When grouping by `category`, transactions with no matching category are grouped under `"uncategorized"`.
