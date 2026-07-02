# Extend Currency Aliases to `currency` Capture Group

**Date:** 2026-06-30  
**Status:** Approved

## Overview

`parseTransaction` currently applies the `aliases` map only to `original_currency`. The `currency` capture group (account default currency, e.g. the denomination of the balance field) is left unnormalised. This spec extends the same alias lookup to `currency`.

## Change

**`src/transaction-parser.ts` — line 126:**

```typescript
// Before
if (g.currency) tx.currency = g.currency.trim();

// After
if (g.currency) tx.currency = aliases[g.currency.trim()] ?? g.currency.trim();
```

No new parameters, no schema changes, no storage changes. The existing `aliases: Record<string, string>` third parameter is reused.

## Semantics

- `original_currency` — the transaction currency (what was charged, e.g. `USD` for a foreign spend). Already normalised via aliases.
- `currency` — the account default currency (what the balance is denominated in, e.g. `THB`). Now also normalised via aliases.

`summarize` already reads `tx.currency` when present, so it benefits automatically once the value is normalised.

## Tests

Add to `src/transaction-parser.test.ts`:

- Template with `(?<currency>บาท)` capture group + aliases `{"บาท":"THB"}` → `tx.currency === "THB"`
- Same template with aliases `{"บ":"THB"}` (no match for `"บาท"`) → `tx.currency === "บาท"` (pass-through)

## Files Changed

| File | Change |
|------|--------|
| `src/transaction-parser.ts` | One-line alias lookup for `currency` group |
| `src/transaction-parser.test.ts` | Two new tests |
