# Balance-Derived Amount & Currency Design

**Date:** 2026-06-22
**Status:** Approved

## Problem

Transactions currently expose only `original_amount` and `original_currency`, which reflect the currency captured from the message text (e.g. USD for a foreign spend). These cannot be meaningfully aggregated when the account operates in a different default currency (e.g. THB). There is no field representing the native-currency equivalent amount.

## Goals

- Add `amount` (native-currency equivalent) and `currency` (account default currency) to `Transaction`.
- Rename existing capture groups so field names and group names are consistent.
- Compute `amount` from the balance difference between consecutive transactions when not explicitly captured.
- Update `summarize()` to use `amount`/`currency` where available.
- Migrate existing saved templates automatically.

---

## Named Capture Groups (new semantics)

| Group | Required | Transaction field | Notes |
|---|---|---|---|
| `(?<original_amount>...)` | **yes** | `original_amount` | Transaction amount in the original currency. Replaces old `(?<amount>...)`. |
| `(?<original_currency>...)` | **yes** | `original_currency` | Transaction currency (e.g. "USD"). Replaces old `(?<currency>...)`. |
| `(?<currency>...)` | no | `currency` | Account default currency (e.g. "THB"). Present only when the message text carries it. |
| `(?<amount>...)` | no | `amount` | Explicit native-currency amount. Falls back to balance diff when absent. |
| `(?<balance>...)` | no | `balance` | Running account balance after the transaction. Used as fallback source for `amount`. |
| `(?<merchant>...)` | no | `merchant` | Unchanged. |
| `(?<date>...)` | no | `date` | Unchanged. |
| `(?<account>...)` | no | `account` | Unchanged. |

---

## Transaction Schema

```ts
{
  id: string
  date: string
  original_amount: number    // required — amount in original/foreign currency
  original_currency: string  // required — original/foreign currency code
  currency?: string          // optional — account default currency
  amount?: number            // optional — native-currency amount (explicit or balance-derived)
  account?: string
  merchant?: string
  balance?: number
  rawText: string
}
```

---

## Compute Logic for `amount`

Implemented as a post-processing pass in `get_transactions` after all messages are parsed:

1. Sort transactions by `date` (already done today).
2. Group by `account` field value (transactions for different accounts must not share balance history). Transactions without an `account` value form their own group.
3. Walk each group in chronological order:
   - If `(?<amount>...)` was explicitly captured → use it directly.
   - Else if both current `balance` and previous transaction's `balance` are present → `amount = balance - prevBalance`.
   - Else → `amount` remains `undefined`.
4. The first transaction in each group with no explicit `amount` will always have `amount = undefined` (no prior balance to diff against).

`parseTransaction` itself remains a pure function — it captures `amount` from the group if present and leaves it undefined otherwise. The balance-diff pass happens in `index.ts` after the full list is built.

---

## `summarize()` Changes

Per-transaction logic when building totals:

- If `amount` is defined → use `amount` for the debit/credit total and `currency` for the currency label.
- If `amount` is undefined → fall back to `original_amount` and `original_currency`.

Currency label on the summary output:
- Single currency across all transactions → that currency code.
- Mix of currencies (or mix of `amount`-present and `amount`-absent transactions with different currencies) → `"mixed"`.
- No transactions → `"none"`.

---

## Template Migration

On first load of any `.line-templates/<chatMid>.json` file, the loader detects old-style patterns and rewrites them in-place:

- `(?<amount>...)` → `(?<original_amount>...)`
- `(?<currency>...)` → `(?<original_currency>...)`

The file is written back immediately after migration. A stderr log line records what was migrated. Migration is idempotent — running it twice produces no change.

Validation in `parseTransaction` is updated to require `original_amount` and `original_currency` groups (previously `amount` and `currency`).

---

## Documentation Updates

- **`manage_templates` tool description** — update pattern rules to reflect new required groups (`original_amount`, `original_currency`) and new optional groups (`currency`, `amount`).
- **`CLAUDE.md`** — update the transaction-parser and template-store sections to reflect new group names and `amount` compute logic.
- **`README.md`** (if present) — update any template authoring instructions.

---

## Files Changed

| File | Change |
|---|---|
| `src/transaction-parser.ts` | New `TransactionSchema` fields; update `parseTransaction` required groups; update `summarize()` |
| `src/template-store.ts` | Add migration logic on `loadTemplates` |
| `src/index.ts` | Add balance-diff post-processing pass in `get_transactions`; update `manage_templates` description |
| `CLAUDE.md` | Update transaction-parser and template-store sections |
| `README.md` | Update template authoring docs (if applicable) |

---

## Edge Cases

- **First transaction in a group:** `amount` is undefined (no prior balance).
- **Gap in balance captures:** if some transactions in a group have no `balance`, the diff is skipped for those; the next transaction with a balance uses the `balance` from the most recent preceding transaction that had one captured.
- **`amount_sign` template field:** currently applies to the captured `(?<amount>...)` group. After the rename it applies to `(?<original_amount>...)` — the sign logic is unchanged, only the group name it reads from changes.
- **Single account, all domestic:** `original_currency === currency`, `original_amount === amount` — redundant but correct.
- **No `(?<currency>...)` group:** `currency` field is absent from Transaction; `summarize` falls back to `original_currency`.
