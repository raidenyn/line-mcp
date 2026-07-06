# Transaction Filters (categories, currencies, merchants, amount range)

**Date:** 2026-07-05
**Status:** Approved

## Overview

`get_transactions` and `summarize_transactions` currently only narrow results by date (`since`/`until`). This adds four more filter dimensions — spending category, original currency, merchant (regex), and amount range — so Claude can answer questions like "coffee spend over 100 THB in Q2" without fetching everything and filtering client-side. Different filter types combine with AND logic; multiple values within one filter type combine with OR logic.

## Scope decisions

- **Both tools, same filters.** `get_transactions` and `summarize_transactions` share `fetchParsedTransactions()`, so the filters are defined once and applied identically in both.
- **Applied after enrichment, not during parsing.** Filtering needs `tx.amount` (from `applyBalanceDiffs`) and `tx.category` (from `categorize`) already populated, so it runs as the last step before returning/summarizing — never inside `parseTransaction`.
- **Amount filter uses absolute value of the effective amount.** "Effective amount" is `tx.amount ?? tx.original_amount` (same fallback `summarize()` already uses). Using absolute value means a caller filtering "100 to 1000" gets matching debits and credits alike, without needing to know or guess the sign convention.
- **Single min/max pair, not multiple ranges.** Covers "over X", "under X", "between X and Y" — the only cases in scope. Multiple OR'd ranges are not needed.
- **Merchant filter mirrors `categorize()`'s matching rules exactly:** case-insensitive, dotAll regex, tested against `tx.merchant` falling back to `tx.rawText` when merchant is absent. Reuses the existing regex cache and `NESTED_QUANTIFIER_RE` ReDoS guard.
- **Categories filter is exact, case-sensitive string match** against `tx.category` (category names are exact identifiers from `manage_categories`, including the literal `"uncategorized"`).
- **Currency filter is case-insensitive exact match** against `tx.original_currency` (bank message currency codes are free-form captures, not a controlled vocabulary like category names).
- **Bad regex in `merchants` is a hard error**, validated eagerly before any LINE API call — consistent with how invalid `since`/`until` are handled today.
- **Fix in scope: inline-templates path of `get_transactions` gains a `categorize()` call.** Today, when a caller supplies `templates` directly (bypassing saved templates), `categorize()` is never called, so `tx.category` is always `undefined` there. Without this fix, the categories filter would silently match nothing on that path (except `"uncategorized"`, incorrectly matching everything). Adding the call makes category population — and therefore category filtering — consistent across both branches.

## Data model

New schema and pure functions in `src/transaction-parser.ts`, alongside `TransactionTemplateSchema`/`CategorySchema`:

```ts
export const TransactionFilterSchema = z.object({
  categories: z.array(z.string()).min(1).optional()
    .describe('Match if tx.category equals any of these (exact, case-sensitive; "uncategorized" is a valid value)'),
  original_currencies: z.array(z.string()).min(1).optional()
    .describe('Match if tx.original_currency equals any of these (case-insensitive)'),
  merchants: z.array(z.string()).min(1).optional()
    .describe('Regex patterns (case-insensitive, dotAll); match if any pattern tests true against merchant, falling back to rawText when merchant is absent'),
  amount_min: z.number().optional().describe('Inclusive lower bound on abs(amount ?? original_amount)'),
  amount_max: z.number().optional().describe('Inclusive upper bound on abs(amount ?? original_amount)'),
});
export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;
```

```ts
// Returns an error message naming the bad pattern, or null if all patterns compile.
export function validateFilters(filters: TransactionFilter): string | null

// Pure filter — AND across filter types present, OR across values within one type.
// Absent filter keys impose no constraint.
export function filterTransactions(transactions: Transaction[], filters: TransactionFilter): Transaction[]
```

`filterTransactions` reuses the existing `getRegex(pattern, 'is')`-style cache (dotAll + case-insensitive) for `merchants`, the same cache instance already used by `categorize()`.

## Integration with `get_transactions` / `summarize_transactions`

Both tools' `inputSchema` gain the five new optional params (spread from `TransactionFilterSchema`), alongside the existing `since`/`until`.

`fetchParsedTransactions()` in `src/index.ts` — the shared helper both tools call — gains:
1. A `validateFilters()` call up front, alongside the existing since/until date validation, returning `{ error }` before any LINE API call on failure.
2. A `filterTransactions()` call as the last step, after `categorize(transactions, categoryStore.list())`.

`get_transactions`' inline-templates branch (caller supplies `templates` directly) gets the same three additions inline: `validateFilters()` up front, a new `categorize(transactions, categoryStore.list())` call after `applyBalanceDiffs`, and `filterTransactions()` before returning — bringing it to parity with the saved-templates path except for template/alias sourcing.

`summarize_transactions` calls `filterTransactions()` on the result of `fetchParsedTransactions()` before passing to `summarize()`, so both grouped totals and the transaction-level output reflect the same filtered set.

## Error handling

- Invalid regex in `merchants` → error naming the specific bad pattern, returned before fetching messages (same style as invalid `since`/`until`).
- No transactions remain after filtering → same "0 transactions matched" hint style used today, extended to mention filters were applied (e.g. "0 transactions matched the given filters — check category names via `manage_categories` (action: list) or loosen the amount range.").
- Empty filter arrays are rejected by the schema (`.min(1)`) — to mean "no filter," the caller omits the key entirely, consistent with how `templates` already works (`z.array(...).min(1).optional()`).

## Documentation

Per `CLAUDE.md`'s maintenance rule and the existing pattern from the categorization feature:

- `docs/guide/tools/get_transactions.md` and `docs/guide/tools/summarize_transactions.md` — document all five filter params, their AND-across-types/OR-within-type semantics, the amount absolute-value rule, and the merchant regex fallback-to-rawText rule.
- `docs/guide/overview.md` — add a short filter example if the overview currently walks through example tool calls.
- `CLAUDE.md` — update the `get_transactions` and `summarize_transactions` bullets in the Architecture section (`fetchParsedTransactions` description, inline-path `categorize()` fix) to mention filtering.
- `README.md` — update the `get_transactions`/`summarize_transactions` rows in the Tools table to mention filters; add a short example under "Transaction tools" (e.g. filtering by category + amount range) alongside the existing template examples.

## Testing

- `src/transaction-parser.test.ts`: `filterTransactions()` — each filter type in isolation, AND-across-types combinations, OR-within-a-type behavior, amount sign/absolute-value handling (debit and credit both matching a positive range), merchant regex matching merchant vs. falling back to rawText, category exact-match including `"uncategorized"`, currency case-insensitivity. `validateFilters()` — valid patterns pass, invalid pattern returns a descriptive error naming it.
- `src/index.test.ts` (or wherever tool-level tests live, if any) / e2e: verify `get_transactions` and `summarize_transactions` accept and apply the new params end-to-end if existing coverage exercises these tools; otherwise rely on unit coverage of `filterTransactions` plus manual verification, consistent with how the categorization feature was tested.

## Files changed

| File | Change |
|------|--------|
| `src/transaction-parser.ts` | `TransactionFilterSchema`/`TransactionFilter` type, `validateFilters()`, `filterTransactions()` |
| `src/index.ts` | Five new params on both tools' `inputSchema`; `fetchParsedTransactions()` gains validation + filtering; inline-templates branch of `get_transactions` gains `categorize()` + validation + filtering |
| `src/transaction-parser.test.ts` | New tests for `filterTransactions()` and `validateFilters()` |
| `docs/guide/tools/get_transactions.md`, `summarize_transactions.md` | Document new filter params |
| `docs/guide/overview.md` | Filter example, if applicable |
| `CLAUDE.md` | Architecture section updated per maintenance rule |
| `README.md` | Tools table + example updated |
