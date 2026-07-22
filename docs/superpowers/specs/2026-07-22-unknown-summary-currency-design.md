# Unknown Summary Currency Design

**Date:** 2026-07-22
**Status:** Approved
**Issue:** [#60](https://github.com/raidenyn/line-mcp/issues/60)

## Problem

`Transaction.amount` and `Transaction.currency` are independently optional. When
`amount` exists without `currency`, `summarize()` currently aggregates that
amount but labels it with `original_currency`. For a transaction such as
`{ original_amount: -50, original_currency: "USD", amount: -1750 }`, the result
is reported as a USD 1,750 debit even though the unlabelled amount may be THB.

The server can create this invalid pair internally. When an FX rate lookup fails,
`applyBalanceDiffs()` falls back to a balance difference and assigns `tx.amount`
without assigning the known balance currency. Malformed explicit template
captures can produce the same state.

This is separate from issue #54, which concerns how the account balance currency
is inferred. This design does not change that inference.

## Goals

- Never label an unlabelled `amount` with `original_currency`.
- Keep unlabelled amounts visible, but separate from currency-safe totals.
- Preserve amount/currency pairing in the known internal fallback path.
- Warn MCP clients whenever malformed amount/currency pairs remain.
- Cover domestic-looking and cross-currency cases without assuming equivalence.

## Non-Goals

- Redesigning balance-currency inference or resolving issue #54.
- Rejecting or mutating malformed transactions solely because currency is absent.
- Replacing the existing summary with a full per-currency aggregation model.
- Inferring currency because `amount` happens to equal `original_amount`.

## Design

### Internal Amount/Currency Invariant

In `applyBalanceDiffs()`, the failed-rate fallback already knows that `c.diff` is
denominated in `c.to`, the inferred balance currency. When assigning the fallback
amount, it will assign both fields:

```ts
c.tx.amount = c.diff;
c.tx.currency = c.to;
```

`amount_estimated` remains `true`. This prevents the internal fallback from
creating an unlabelled amount. The change does not alter how `c.to` is inferred.

### Summary Classification

For each filtered transaction, `summarize()` will select one of two paths:

1. **Known currency:** If `amount` and `currency` both exist, use that pair. If
   `amount` is absent, use `original_amount` and `original_currency`; an orphaned
   `currency` does not replace the original pair.
2. **Unknown currency:** If `amount` exists but `currency` is absent, use the
   unlabelled `amount` only in the new unknown-currency accumulators.

No equality check between `amount` and `original_amount` is used. Even a
domestic-looking unlabelled amount remains unknown because numerical equality
does not establish the unit.

Existing `total_debit`, `total_credit`, `net`, and `by_group` fields aggregate
only known-currency pairs. The existing `currency` field describes only those
known totals and keeps its current values: the single known currency, `mixed`
for multiple known currencies, or `none` when there are no known-currency
transactions.

The existing top-level `transactions_count` continues to count every filtered
transaction, including unknown-currency transactions.

### Summary Output

`SummaryOutput` gains two always-present fields:

```ts
unknown_currency: {
  total_debit: number;
  total_credit: number;
  net: number;
  transactions_count: number;
};
unknown_by_group: Record<
  string,
  { debit: number; credit: number; count: number }
>;
```

`unknown_currency` aggregates all `amount` values whose currency is absent.
`unknown_by_group` applies the requested month, merchant, or category grouping
to those same transactions. Debit values are exposed as positive magnitudes,
matching existing summary behavior. `net` remains credits minus debits.

When no unknown-currency transactions exist, `unknown_currency` contains zeroes
and `unknown_by_group` is empty. When every transaction has unknown currency,
the known totals are zero, `by_group` is empty, and `currency` is `none`.

### MCP Warning

After parsing and `applyBalanceDiffs()`, the shared fetch pipeline scans for
transactions where `amount !== undefined && currency === undefined`. If it finds
any, it adds this warning using the existing warning channel:

```text
N transaction(s) have an amount with unknown currency; summaries report these amounts separately under unknown_currency and unknown_by_group.
```

Both `get_transactions` and `summarize_transactions` use the shared pipeline, so
both MCP responses surface the warning. `summarize()` performs its own
classification and does not depend on the warning scan for correctness.

Unknown currency is data uncertainty, not a tool error. Existing exception and
MCP error handling remain unchanged.

## Data Flow

1. Templates parse messages into transactions.
2. `applyBalanceDiffs()` enriches missing amounts. Its failed-rate fallback now
   assigns both the balance-diff amount and its known balance currency.
3. The shared fetch pipeline detects any remaining amount-without-currency pairs
   and records one count-based warning.
4. `summarize()` filters transactions, routes known and unknown pairs to separate
   accumulators, and returns both sets of totals.
5. `summarize_transactions` serializes the result and appends the shared warning
   block and range note as it does today.

## Testing

Unit tests in `transaction-parser.test.ts` will verify:

- An unlabelled domestic-looking amount is separated even when it equals
  `original_amount`.
- The cross-currency reproduction (`USD -50`, unlabelled `amount: -1750`) places
  1,750 only in `unknown_currency` and `unknown_by_group`.
- Mixed known and unknown transactions produce independent top-level and grouped
  debit, credit, net, and count values.
- Date filtering and month, merchant, and category grouping route unknown values
  consistently.
- A summary containing only unknown values has zero known totals, an empty
  `by_group`, and `currency: "none"`.
- Summaries without unknown values return zeroed `unknown_currency` totals and an
  empty `unknown_by_group`.
- The failed-rate fallback assigns `amount = c.diff`, `currency = c.to`, and
  `amount_estimated = true`.

Tool-level tests will verify that malformed pairs produce the warning in MCP
responses and corrected fallback pairs do not.

## Compatibility

The summary response change is additive: existing fields keep their names and
known-currency semantics. Their values intentionally stop including unlabelled
amounts, eliminating the unsafe behavior. Clients that understand the new fields
can display the uncertain values separately; all clients receive the text
warning through the existing MCP response format.

## Files Expected To Change

- `packages/bank-mcp/src/transaction-parser.ts`: pair the fallback amount with
  its currency; add unknown-currency summary accumulators and output fields.
- `packages/bank-mcp/src/transaction-parser.test.ts`: add invariant and summary
  regression coverage.
- `packages/bank-mcp/src/tools/fetch-transactions.ts`: add the shared malformed
  pair warning.
- Relevant bank tool tests: verify warning propagation through MCP responses.
