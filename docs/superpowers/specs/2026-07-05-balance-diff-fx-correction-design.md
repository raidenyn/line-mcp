# Balance-Diff FX Correction Design

**Date:** 2026-07-05
**Status:** Approved
**Extends:** `docs/superpowers/specs/2026-06-22-balance-derived-amount-design.md` (original `applyBalanceDiffs` design)
**Bug report:** `specs/balance_diff_amount_bug.md`

## Problem

`applyBalanceDiffs()` fills in a transaction's `amount` as `tx.balance - prevBalance` whenever a transaction's template didn't explicitly capture `amount`. If the account's balance moved for any reason that never produced a matching `Transaction` object — a fee, an interest posting, or any other silent adjustment — the entire untracked delta is absorbed into the `amount` of whichever next transaction also lacks an explicit amount, producing wildly wrong figures reported as real spend.

## Root cause (verified against live data)

Pulled the saved templates and raw messages for the UOB Thai chat (`URLrlVGjUBXM3-W7x0s5g6GhhK_RdxRRTyf6yBGjT0wg`):

- The chat has exactly **one** saved template (`uob-spend`), and it captures neither `amount` nor `currency` — every UOB transaction, domestic or foreign, depends on the balance diff.
- `sample_messages` (which returns *every* text message regardless of template match) shows no untracked bank message sitting in either gap window (2026-05-15→17, 2026-06-22→24). The "available credit" figure itself moves by more than the sum of visible spends, with no corresponding message at all — ruling out "a real message got dropped because it didn't match a template" as the mechanism, and confirming instead that the balance can change for reasons that never generate any capturable message (fee, hold, interest, etc.).
- This is broader than the two known examples: reconstructing the 2026-05-16 balance chain surfaced a **third, previously unnoticed casualty** — `TOPS-CPN SRIRACHA` (real spend 2,811.00 THB) currently computes to `amount = -3,162` (351 THB of untracked activity silently absorbed), unnoticed because it isn't an absurd figure like the subscription cases.

Since gaps can occur with no corresponding message to recover, gap-detection-by-message-rescanning is a dead end. The fix must be structural.

## Goals

- Eliminate the same-currency inflation bug with a structural fix, not a heuristic — same-currency transactions should never depend on the balance sequence at all.
- For genuine cross-currency (FX) transactions, source `amount` from an independent, trustworthy rate rather than trusting the balance diff.
- Prefer surfacing uncertainty over fabricating a number (per the bug report's acceptance criteria).
- No regression for existing correct balance-diff cases; update/extend tests accordingly.

---

## Design

### 1. Same-currency passthrough

In `applyBalanceDiffs`, when `tx.amount` is undefined and `tx.original_currency === balanceCurrency` (the group's already-computed dominant currency), set:

```
tx.amount = tx.original_amount
tx.currency = balanceCurrency
```

No diff, no `prevBalance` required. This is exact (not an inference), so it eliminates the bug class entirely for domestic-currency transactions — including the newly-found `TOPS-CPN` case — and also fixes the **first transaction in a group**, which today is permanently left with `amount = undefined` because there's no prior balance to diff against. `prevBalance` tracking is unchanged for downstream use.

### 2. FX-aware amount via frankfurter.dev

For a transaction with undefined `amount` where `original_currency !== balanceCurrency`:

1. Fetch the historical exchange rate for `(original_currency → balanceCurrency)` on the transaction's date from `https://api.frankfurter.dev/v1/{date}?from={original_currency}&to={balanceCurrency}`.
2. **If a rate is returned** (response body has a `rates` object): compute
   ```
   amount = round2(original_amount * rate)
   currency = balanceCurrency
   amount_estimated = true
   ```
   (`round2(x) = Math.round(x * 100) / 100`.) This is independent of the balance sequence entirely, so it cannot inherit an untracked gap.
   Separately, as a diagnostic (not gating) check: when both balances are known, compute `diff = tx.balance - prevBalance` and the deviation `Math.abs(Math.abs(diff) - Math.abs(amount)) / Math.abs(amount)`. If that deviation exceeds **0.15** (15%), set `amount_gap_suspected = true` — a signal that something else moved the balance around this transaction — but `amount` stays the API-derived value regardless, since it no longer depends on the diff.
3. **If no rate is available** (API error, unsupported currency pair, or the date is beyond published data — confirmed via manual check that this shape is `{"message":"not found"}`, no `rates` key): fall back to the pre-existing diff-based estimate (`amount = tx.balance - prevBalance`, `amount_estimated = true`), with no gap-check performed, so the tool keeps working offline. No `amount_gap_suspected` is set in this branch — we have no independent number to compare against.

**Confirmed API behavior** (manual verification, see below) — no closest-available-date logic is needed on our side:

| Query date | Resolved date in response | Notes |
|---|---|---|
| 2026-06-21 (Sun) | 2026-06-19 | Weekend snaps to preceding Friday |
| 2026-06-20 (Sat) | 2026-06-19 | Same |
| 2026-01-01 (holiday) | 2025-12-31 | Holiday snaps to preceding business day |
| 2026-06-23 (business day) | 2026-06-23 | Exact match |
| 2027-01-01 (beyond data) | — | `{"message":"not found"}`, no `rates` key |
| unsupported currency | — | `{"message":"not found"}`, no `rates` key |

### 3. New `src/fx-rates.ts` module

```ts
export async function getHistoricalRate(date: string, from: string, to: string): Promise<number | null>
```

- Calls the frankfurter.dev endpoint above; returns `data.rates[to]` on success, `null` if the response has no `rates` object or the request fails (network error, non-2xx).
- Module-level in-memory cache keyed by `` `${date}|${from}|${to}` `` — historical rates never change, so caching successful lookups is correctness-preserving, not just an optimization. Failed lookups (`null`) are not cached, so a transient outage doesn't permanently blind a long-running process.
- In-memory only, not persisted to SQLite — call volume for a personal-finance tool is low enough that this is unnecessary; can be revisited if it becomes a bottleneck.

### 4. `applyBalanceDiffs` becomes async

Signature changes to:

```ts
export async function applyBalanceDiffs(
  transactions: Transaction[],
  rateFetcher: (date: string, from: string, to: string) => Promise<number | null> = getHistoricalRate,
): Promise<void>
```

`rateFetcher` is injectable so unit tests supply a stub instead of hitting the network. Implementation is a three-step pass per account group (to batch network calls rather than awaiting sequentially):

1. **Sync walk** — same-currency passthrough (§1); for cross-currency transactions, compute the raw `diff` using the running `prevBalance` and collect an FX candidate `{ tx, diff, date, from: original_currency, to: balanceCurrency }` without mutating yet.
2. **Batch fetch** — dedupe candidates by `(date, from, to)`, fetch all unique rates in parallel via `Promise.all(rateFetcher(...))`, building a local `Map` of results.
3. **Sync assignment** — for each FX candidate, look up its rate in the fetched map and apply §2's accept/fallback/gap-check logic.

Both call sites in `src/index.ts` (`fetchParsedTransactions`, and the inline-templates branch in the `get_transactions` handler) add `await` — both are already inside `async` handlers, so no further signature changes ripple outward.

### 5. Surfacing warnings in `index.ts`

After `await applyBalanceDiffs(transactions)`, scan the array and push into the existing `warnings` array (already wired to the `warningBlock` appended to both `get_transactions` and `summarize_transactions` output):

- If any transaction has `amount_estimated`: `"N transaction(s) have amount estimated via FX conversion or balance diff — may not match the bank's own applied rate/fees. See amount_estimated field."`
- If any transaction has `amount_gap_suspected`: `"N transaction(s) show a balance change that doesn't reconcile with their FX-converted amount — there may be other untracked activity nearby. See amount_gap_suspected field."`

---

## Transaction Schema changes

New optional fields on `Transaction` (`src/transaction-parser.ts`):

| Field | Type | Meaning |
|---|---|---|
| `amount_estimated` | `boolean` (optional) | `amount` was derived via FX conversion (API rate or, on API failure, balance diff) rather than an explicit template capture. |
| `amount_gap_suspected` | `boolean` (optional) | The observed balance diff disagrees with the FX-converted `amount` by more than 15% — diagnostic only, `amount` is still populated. |

---

## Files Changed

| File | Change |
|---|---|
| `src/transaction-parser.ts` | `TransactionSchema` gains `amount_estimated`, `amount_gap_suspected`; `applyBalanceDiffs` rewritten as `async`, takes injectable `rateFetcher`, implements passthrough + FX-aware logic |
| `src/fx-rates.ts` | New module: `getHistoricalRate()` with in-memory cache |
| `src/index.ts` | `await applyBalanceDiffs(...)` at both call sites; warning-generation logic added to `fetchParsedTransactions` and the inline-templates branch |
| `src/transaction-parser.test.ts` | Rewrite `'leaves first transaction amount undefined when no prior balance'` (behavior intentionally changes for same-currency case); add tests for passthrough, FX accept, FX API-failure fallback, gap-suspected flagging, and a regression test reconstructing the UOB Google/TOPS-CPN/ANTHROPIC sequence |
| New `src/fx-rates.test.ts` | Unit tests for `getHistoricalRate` (cache hit/miss, not-found handling) — stub `fetch`, no real network calls |
| `CLAUDE.md` | Update `transaction-parser.ts` and `index.ts` sections to describe the new fields, the async `applyBalanceDiffs`, and `fx-rates.ts` |

---

## Edge Cases

- **First transaction in a group, same currency:** now gets an exact `amount` via passthrough (previously always `undefined`) — this is an intentional behavior change from the original design.
- **First transaction in a group, cross-currency:** still handled by the FX branch — no `prevBalance` needed for the API-rate path, so it can get an `amount_estimated` amount immediately; only the fallback (API-unavailable) path needs `prevBalance` and stays `undefined` if there is none.
- **Currency tie in a group** (no clear dominant `balanceCurrency`): passthrough can't apply safely (we don't know what the balance's currency actually is); every transaction in that group falls through to the FX branch, which itself only proceeds when a rate is fetchable for the transaction's own currency pair — if `balanceCurrency` is `undefined`, no rate lookup can even be attempted, so `amount` stays `undefined` as today.
- **API failure mid-batch:** `Promise.all` result map simply has no entry (or resolves to `null`) for the failed lookups; those specific candidates fall back to diff-based estimation while others in the same batch that succeeded still get the API-derived amount.
- **`original_amount === 0`:** no meaningful rate multiplication issue since `0 * rate === 0`; passthrough or FX branch both handle this without special-casing.

---

## Testing plan

- `src/fx-rates.test.ts` (new): stub global `fetch`; assert cache is consulted before re-fetching same `(date, from, to)`; assert `null` returned (not thrown) for a `{"message":"not found"}` body and for network rejection; assert failed lookups are not cached (next call re-fetches).
- `src/transaction-parser.test.ts`:
  - Rewrite the "first transaction, no prior balance" test to cover the case where passthrough genuinely cannot apply (cross-currency first transaction, API stub returns `null`) — asserts `amount` stays `undefined`.
  - New: same-currency passthrough sets exact `amount`/`currency`, including for the first transaction in a group.
  - New: cross-currency transaction with a stubbed rate gets `amount = original_amount * rate`, `amount_estimated: true`.
  - New: cross-currency transaction with a stubbed rate whose diff disagrees >15% still gets the API-derived `amount`, plus `amount_gap_suspected: true`.
  - New: cross-currency transaction with a stubbed rate whose diff agrees within 15% gets no `amount_gap_suspected`.
  - New: rate fetcher stub returns `null` → falls back to diff-based `amount`, `amount_estimated: true`, no `amount_gap_suspected`.
  - Regression: reconstruct the UOB Google YouTubePremium / TOPS-CPN / ANTHROPIC* CLAUDE SUB sequence (with a stubbed rate fetcher standing in for frankfurter.dev) and assert all three now report the correct/flagged outcome described in the bug report's acceptance criteria.
- `npm run test:unit` must pass with no regressions in `summarize`, `categorize`, or other `applyBalanceDiffs` callers.

## Known Limitations

- The 15%-disagreement threshold is a fixed constant, not per-currency-pair tuned; it may need adjustment if a legitimately volatile currency pair produces false positives.
- No persistent cache for FX rates — a server restart re-fetches previously-seen `(date, from, to)` combinations. Acceptable given expected call volume; revisit if this becomes a real cost.
- Card-network FX markup/fees mean even a correctly-fetched market rate won't exactly match the bank's own applied rate — `amount_estimated` communicates this is an approximation, not a defect to fix here.
