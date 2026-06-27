# summarize_transactions

**When to use:** To aggregate parsed transaction data into totals grouped by month or merchant.

**Prerequisites:** `get_transactions` — this tool operates on the same parsed data pipeline.

**Next steps:** None — this is the final step in the transaction workflow.

**Key parameters:**
- `chatMid`: the chat MID
- `group_by`: `month` | `merchant`
- `since` / `until`: filter the aggregation window (ISO date strings)

**Avoid:** Don't call before `get_transactions` has run with a `since` range covering the period you want to summarize — the result will be incomplete.
