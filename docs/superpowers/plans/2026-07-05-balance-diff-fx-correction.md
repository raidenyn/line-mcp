# Balance-Diff FX Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `applyBalanceDiffs()` in `src/transaction-parser.ts` so it never fabricates a transaction's `amount` from a balance gap that includes untracked activity — same-currency transactions get an exact passthrough, cross-currency transactions get an FX-converted amount from a real historical rate (frankfurter.dev) instead of a raw balance diff.

**Architecture:** `applyBalanceDiffs` becomes `async` and takes an injectable rate-fetcher (defaulting to a new `src/fx-rates.ts` module). Two new optional `Transaction` fields (`amount_estimated`, `amount_gap_suspected`) communicate provenance/uncertainty instead of silently reporting a fabricated number. `src/index.ts` awaits the call at both existing call sites and surfaces a warning when either flag is present on any transaction.

**Tech Stack:** TypeScript, Vitest, native `fetch` (Node 20, already used in `oauth.ts`), zod, frankfurter.dev public API (no auth, no new dependency).

## Global Constraints

- No new npm dependencies — use native `fetch`, matching the existing pattern in `src/oauth.ts:235`.
- Gap-disagreement threshold is a fixed **0.15** (15%) constant, per the design doc — not per-currency-pair configuration.
- FX rate cache is **in-memory only** (module-level `Map`), not persisted to SQLite.
- `applyBalanceDiffs`'s new second parameter (`rateFetcher`) must default to the real `getHistoricalRate` so existing callers with a single argument keep compiling and working unchanged in production.
- Full spec: `docs/superpowers/specs/2026-07-05-balance-diff-fx-correction-design.md`. Bug report: `specs/balance_diff_amount_bug.md`.

---

## Task 1: `fx-rates.ts` — historical FX rate lookup

**Files:**
- Create: `src/fx-rates.ts`
- Test: `src/fx-rates.test.ts`

**Interfaces:**
- Produces: `export async function getHistoricalRate(date: string, from: string, to: string): Promise<number | null>` — `date` is `YYYY-MM-DD`, `from`/`to` are currency codes (e.g. `"USD"`, `"THB"`). Returns `null` on any failure (network error, non-2xx response, or a body with no `rates` object) instead of throwing. Successful lookups are cached in-memory keyed by `` `${date}|${from}|${to}` ``; failed lookups are not cached.

- [ ] **Step 1: Write the failing test file**

Create `src/fx-rates.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getHistoricalRate } from './fx-rates';

describe('getHistoricalRate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the rate from a successful frankfurter.dev response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'USD', date: '2026-06-23', rates: { THB: 33.2 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-23', 'USD', 'THB');
    expect(rate).toBe(33.2);
    expect(mockFetch).toHaveBeenCalledWith('https://api.frankfurter.dev/v1/2026-06-23?from=USD&to=THB');
  });

  it('returns null when the response has no rates object (not found)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'not found' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2027-01-01', 'USD', 'ZZZ');
    expect(rate).toBeNull();
  });

  it('returns null when fetch rejects (network error)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-25', 'USD', 'THB');
    expect(rate).toBeNull();
  });

  it('returns null when the response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-26', 'USD', 'THB');
    expect(rate).toBeNull();
  });

  it('caches a successful lookup and does not re-fetch for the same date/pair', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'EUR', date: '2026-05-01', rates: { GBP: 0.85 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const first = await getHistoricalRate('2026-05-01', 'EUR', 'GBP');
    const second = await getHistoricalRate('2026-05-01', 'EUR', 'GBP');
    expect(first).toBe(0.85);
    expect(second).toBe(0.85);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed lookup (retries on next call)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    await getHistoricalRate('2026-05-02', 'EUR', 'JPY');
    await getHistoricalRate('2026-05-02', 'EUR', 'JPY');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

Note: each test uses a distinct `(date, from, to)` combination — the cache is module-level and persists across test cases within this file, so reusing a key would let an earlier test's cached success mask a later test's mocked failure.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/fx-rates.test.ts`
Expected: FAIL — `Cannot find module './fx-rates'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/fx-rates.ts`:

```ts
interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

const rateCache = new Map<string, number>();

export async function getHistoricalRate(date: string, from: string, to: string): Promise<number | null> {
  const cacheKey = `${date}|${from}|${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.frankfurter.dev/v1/${date}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as FrankfurterResponse;
    const rate = data.rates?.[to];
    if (typeof rate !== 'number') return null;
    rateCache.set(cacheKey, rate);
    return rate;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/fx-rates.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fx-rates.ts src/fx-rates.test.ts
git commit -m "$(cat <<'EOF'
feat: add frankfurter.dev historical FX rate lookup with in-memory cache

EOF
)"
```

---

## Task 2: FX-aware `applyBalanceDiffs`

**Files:**
- Modify: `src/transaction-parser.ts:18-31` (`TransactionSchema`), `src/transaction-parser.ts:232-263` (`applyBalanceDiffs`)
- Test: `src/transaction-parser.test.ts:242-335` (`describe('applyBalanceDiffs', ...)` block)

**Interfaces:**
- Consumes: `getHistoricalRate(date: string, from: string, to: string): Promise<number | null>` from Task 1 (`./fx-rates`).
- Produces: `Transaction.amount_estimated?: boolean`, `Transaction.amount_gap_suspected?: boolean`; `export async function applyBalanceDiffs(transactions: Transaction[], rateFetcher?: (date: string, from: string, to: string) => Promise<number | null>): Promise<void>` — consumed by `src/index.ts` in Task 3.

- [ ] **Step 1: Replace the `applyBalanceDiffs` test block with the new behavior (failing against current implementation)**

In `src/transaction-parser.test.ts`, replace the entire block from `describe('applyBalanceDiffs', () => {` (line 242) through its closing `});` (line 335) with:

```ts
describe('applyBalanceDiffs', () => {
  it('uses original_amount directly for same-currency transactions (no diff needed, including the first transaction in a group)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-100);
    expect(txs[0].currency).toBe('THB');
    expect(txs[0].amount_estimated).toBeUndefined();
    expect(txs[1].amount).toBe(-200);
    expect(txs[1].currency).toBe('THB');
  });

  it('does not overwrite an explicit amount', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 9800, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-1750);
    expect(txs[1].amount).toBe(-100); // same-currency passthrough (both USD), not a diff
    expect(txs[1].currency).toBe('USD');
  });

  it('leaves amount undefined when cross-currency, no prior balance, and rate lookup fails', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 9700, rawText: '' },
    ];
    const failingFetcher = async () => null;
    await applyBalanceDiffs(txs, failingFetcher);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[0].amount_estimated).toBeUndefined();
  });

  it('uses last known balance across a gap when computing the FX diagnostic diff', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', rawText: '' }, // no balance captured
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8250, rawText: '' },
    ];
    const stubFetcher = async () => 33; // 1 USD = 33 THB
    await applyBalanceDiffs(txs, stubFetcher);
    // API-derived amount: -50 * 33 = -1650. Diff uses last known balance (10000, from tx1,
    // since tx2 has none): 8250 - 10000 = -1750. |1750-1650|/1650 ≈ 6% — within tolerance.
    expect(txs[2].amount).toBe(-1650);
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined();
  });

  it('groups by account to avoid cross-account balance diffs', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', account: 'acc-A', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'USD', account: 'acc-B', balance: 5000, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -20, original_currency: 'THB', account: 'acc-A', balance: 9700, rawText: '' },
      { id: 'm4', date: '2026-06-04T00:00:00.000Z', original_amount: -50, original_currency: 'USD', account: 'acc-A', balance: 8050, rawText: '' },
    ];
    const stubFetcher = async () => 33;
    await applyBalanceDiffs(txs, stubFetcher);
    // acc-A's diff for m4 must use acc-A's own prevBalance (9700), not acc-B's (5000):
    // 8050 - 9700 = -1650, matching the API amount (-50 * 33 = -1650) exactly — no gap flag.
    expect(txs[3].amount).toBe(-1650);
    expect(txs[3].amount_estimated).toBe(true);
    expect(txs[3].amount_gap_suspected).toBeUndefined();
  });

  it('computes FX amount via the rate fetcher for a foreign spend on a domestic-currency account', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8150, rawText: '' },
    ];
    const stubFetcher = async (date: string, from: string, to: string) => {
      expect(date).toBe('2026-06-03');
      expect(from).toBe('USD');
      expect(to).toBe('THB');
      return 33;
    };
    await applyBalanceDiffs(txs, stubFetcher);
    expect(txs[1].currency).toBe('THB');
    expect(txs[2].currency).toBe('THB');
    expect(txs[2].amount).toBe(-1650); // -50 * 33
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined(); // diff (9800-8150=1650) matches exactly
  });

  it('does not stamp currency when currencies tie (truly mixed account)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'EUR', balance: 9900, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[1].currency).toBeUndefined();
    expect(txs[1].amount).toBeUndefined();
  });

  it('does not stamp currency on transactions with an explicit amount', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 8250, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 8050, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[1].currency).toBeUndefined(); // explicit amount — not touched
    expect(txs[2].currency).toBe('THB'); // same-currency passthrough
  });

  it('flags amount_gap_suspected when the balance diff disagrees with the FX-converted amount by more than 15% (mirrors the real UOB bug)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 960114, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 960014, rawText: '' },
      { id: 'm3', date: '2026-06-23T00:00:00.000Z', original_amount: -21.4, original_currency: 'USD', balance: 958014, rawText: '' },
    ];
    const stubFetcher = async () => 33; // published rate for the date
    await applyBalanceDiffs(txs, stubFetcher);
    // API-derived amount: -21.4 * 33 = -706.20 — trustworthy, independent of the balance sequence.
    expect(txs[2].amount).toBeCloseTo(-706.2, 2);
    expect(txs[2].amount_estimated).toBe(true);
    // Observed diff (960014 - 958014 = 2000) is wildly off from 706.20 — an untracked balance
    // change happened between these readings, exactly like the real bug report's evidence.
    expect(txs[2].amount_gap_suspected).toBe(true);
  });

  it('falls back to diff-based amount when the rate fetcher returns null (API unavailable)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'THB', balance: 9950, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8450, rawText: '' },
    ];
    const failingFetcher = async () => null;
    await applyBalanceDiffs(txs, failingFetcher);
    expect(txs[2].amount).toBe(-1500); // 8450 - 9950, diff fallback
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined(); // no rate to compare against, no gap-check performed
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: FAIL — `applyBalanceDiffs` doesn't return a `Promise` yet (missing `await` has no effect on the old sync function, so assertions on `amount_estimated`/`amount_gap_suspected` fail, and behavior-changed assertions like `txs[1].amount === -100` fail against the old diff-based `-200`/`-1650` results).

- [ ] **Step 3: Implement the schema and algorithm changes**

In `src/transaction-parser.ts`, add the import near the top (after `import { z } from 'zod';`):

```ts
import { getHistoricalRate } from './fx-rates';
```

Replace the `TransactionSchema` block (lines 18-31):

```ts
export const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  original_amount: z.number(),
  original_currency: z.string(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  amount_estimated: z.boolean().optional(),
  amount_gap_suspected: z.boolean().optional(),
  account: z.string().optional(),
  merchant: z.string().optional(),
  balance: z.number().optional(),
  category: z.string().optional(),
  rawText: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;
```

Replace the entire `applyBalanceDiffs` function (lines 232-263 in the original file) with:

```ts
type RateFetcher = (date: string, from: string, to: string) => Promise<number | null>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface FxCandidate {
  tx: Transaction;
  diff: number | undefined;
  date: string;
  from: string;
  to: string;
}

export async function applyBalanceDiffs(
  transactions: Transaction[],
  rateFetcher: RateFetcher = getHistoricalRate,
): Promise<void> {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = tx.account ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  const candidates: FxCandidate[] = [];

  for (const group of groups.values()) {
    // Infer balance currency: the dominant original_currency in the group.
    // If two currencies tie, we cannot determine balance currency → leave undefined → 'mixed' in summarize.
    const counts = new Map<string, number>();
    for (const tx of group) counts.set(tx.original_currency, (counts.get(tx.original_currency) ?? 0) + 1);
    let balanceCurrency: string | undefined;
    if (counts.size === 1) {
      balanceCurrency = counts.keys().next().value as string;
    } else {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > sorted[1][1]) balanceCurrency = sorted[0][0];
    }

    let prevBalance: number | undefined;
    for (const tx of group) {
      if (tx.amount === undefined && balanceCurrency !== undefined) {
        if (tx.original_currency === balanceCurrency) {
          // Exact — no inference needed, so no untracked gap can be absorbed into it.
          tx.amount = tx.original_amount;
          tx.currency = balanceCurrency;
        } else {
          const diff =
            tx.balance !== undefined && prevBalance !== undefined ? tx.balance - prevBalance : undefined;
          candidates.push({ tx, diff, date: tx.date.slice(0, 10), from: tx.original_currency, to: balanceCurrency });
        }
      }
      if (tx.balance !== undefined) prevBalance = tx.balance;
    }
  }

  if (candidates.length === 0) return;

  const uniqueLookups = new Map<string, { date: string; from: string; to: string }>();
  for (const c of candidates) {
    const key = `${c.date}|${c.from}|${c.to}`;
    if (!uniqueLookups.has(key)) uniqueLookups.set(key, { date: c.date, from: c.from, to: c.to });
  }
  const keys = [...uniqueLookups.keys()];
  const fetched = await Promise.all(
    keys.map((k) => {
      const { date, from, to } = uniqueLookups.get(k)!;
      return rateFetcher(date, from, to);
    }),
  );
  const rates = new Map<string, number | null>();
  keys.forEach((k, i) => rates.set(k, fetched[i]));

  for (const c of candidates) {
    const rate = rates.get(`${c.date}|${c.from}|${c.to}`) ?? null;
    if (rate !== null) {
      const amount = round2(c.tx.original_amount * rate);
      c.tx.amount = amount;
      c.tx.currency = c.to;
      c.tx.amount_estimated = true;
      if (c.diff !== undefined && Math.abs(amount) > 0) {
        const deviation = Math.abs(Math.abs(c.diff) - Math.abs(amount)) / Math.abs(amount);
        if (deviation > 0.15) c.tx.amount_gap_suspected = true;
      }
    } else if (c.diff !== undefined) {
      c.tx.amount = c.diff;
      c.tx.amount_estimated = true;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: PASS (all tests in the file, including `parseTransaction`, `summarize`, `categorize`, and the rewritten `applyBalanceDiffs` block).

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "$(cat <<'EOF'
fix: use exact same-currency passthrough and FX-rate lookup in applyBalanceDiffs

Same-currency transactions no longer depend on the balance sequence at
all, eliminating the class of bug where untracked balance changes get
absorbed into the next transaction's amount. Cross-currency transactions
are now converted via a real historical FX rate instead of a raw balance
diff, with amount_estimated/amount_gap_suspected flags communicating
provenance and reconciliation risk instead of silently reporting a
fabricated number.

EOF
)"
```

---

## Task 3: Wire `index.ts` to the async `applyBalanceDiffs` and surface warnings

**Files:**
- Modify: `src/index.ts:528-590` (`fetchParsedTransactions`), `src/index.ts:611-665` (`get_transactions` handler's inline-templates branch)

**Interfaces:**
- Consumes: `async applyBalanceDiffs(transactions, rateFetcher?)`, `Transaction.amount_estimated`, `Transaction.amount_gap_suspected` from Task 2.
- Produces: `function buildAmountWarnings(transactions: Transaction[]): string[]` — used by both call sites in this file; no other file depends on it.

There is no dedicated unit test file for `index.ts` in this codebase (its only test coverage is `tests/e2e.test.ts`, which requires a live `.line-auth.json` and is out of scope for this task). Verification here is a successful `tsc` build plus the full unit suite staying green.

- [ ] **Step 1: Add the `buildAmountWarnings` helper**

In `src/index.ts`, insert immediately before `async function fetchParsedTransactions(` (the function currently starting at line 528):

```ts
function buildAmountWarnings(transactions: Transaction[]): string[] {
  const warnings: string[] = [];
  const estimatedCount = transactions.filter((t) => t.amount_estimated).length;
  if (estimatedCount > 0) {
    warnings.push(
      `${estimatedCount} transaction(s) have amount estimated via FX conversion or balance diff — may not match the bank's own applied rate/fees. See amount_estimated field.`,
    );
  }
  const gapSuspectedCount = transactions.filter((t) => t.amount_gap_suspected).length;
  if (gapSuspectedCount > 0) {
    warnings.push(
      `${gapSuspectedCount} transaction(s) show a balance change that doesn't reconcile with their FX-converted amount — there may be other untracked activity nearby. See amount_gap_suspected field.`,
    );
  }
  return warnings;
}

```

- [ ] **Step 2: Update `fetchParsedTransactions` to await and surface warnings**

Find this block (currently lines 581-584):

```ts
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  applyBalanceDiffs(transactions);
  categorize(transactions, categoryStore.list());
```

Replace with:

```ts
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  await applyBalanceDiffs(transactions);
  warnings.push(...buildAmountWarnings(transactions));
  categorize(transactions, categoryStore.list());
```

- [ ] **Step 3: Update the inline-templates branch of the `get_transactions` handler**

Find this block (currently lines 633-637):

```ts
        transactions.sort((a, b) => a.date.localeCompare(b.date));
        applyBalanceDiffs(transactions);
        const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
        return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + rangeNote }] };
```

Replace with:

```ts
        transactions.sort((a, b) => a.date.localeCompare(b.date));
        await applyBalanceDiffs(transactions);
        const inlineWarnings = buildAmountWarnings(transactions);
        const warningBlock = inlineWarnings.length > 0 ? '\n\nWarnings:\n' + inlineWarnings.join('\n') : '';
        const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
        return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock + rangeNote }] };
```

- [ ] **Step 4: Verify the build and full unit suite**

Run: `npm run build`
Expected: compiles with no TypeScript errors (this is the only feasible automated check for this task — confirms `await` usage type-checks and `buildAmountWarnings` matches the `Transaction` type from Task 2).

Run: `npm run test:unit`
Expected: PASS — no regressions in `transaction-parser.test.ts`, `template-store.test.ts`, `category-store.test.ts`, `preset-store.test.ts`, or any other unit test.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
fix: await async applyBalanceDiffs and surface FX-estimate warnings

EOF
)"
```

---

## Task 4: Update `CLAUDE.md` documentation

**Files:**
- Modify: `CLAUDE.md` (the `transaction-parser.ts` bullet in the "Source files" section)

**Interfaces:**
- Consumes: final async `applyBalanceDiffs` signature and `fx-rates.ts` module from Tasks 1-2. No code interfaces produced — documentation only.

- [ ] **Step 1: Replace the `applyBalanceDiffs` sentence in the `transaction-parser.ts` bullet**

Find this sentence within the existing `**`transaction-parser.ts`**` bullet:

```
Exports `applyBalanceDiffs(transactions)` which mutates a sorted array in place: groups by `account`, then fills `amount = balance - prevBalance` for transactions missing an explicit `amount`, and stamps `currency` = the dominant `original_currency` in the group (most-common wins; tie → no stamp → `summarize` reports "mixed").
```

Replace with:

```
Exports `async applyBalanceDiffs(transactions, rateFetcher?)` which mutates a sorted array in place: groups by `account`; for a transaction missing an explicit `amount`, if its `original_currency` matches the group's dominant currency (most-common wins; tie → no stamp → `summarize` reports "mixed"), `amount` is set directly from `original_amount` — exact, no inference, so no untracked balance gap can be absorbed into it. Otherwise (a genuine cross-currency spend), `amount` is computed via a historical FX rate from `fx-rates.ts` (`original_amount * rate`, stamping `amount_estimated: true`), falling back to the old `balance - prevBalance` estimate only if the rate lookup fails. When the observed balance diff disagrees with the FX-converted amount by more than 15%, `amount_gap_suspected: true` is also set — signalling nearby untracked balance activity (a fee, hold, or interest posting) without discarding the still-trustworthy FX-derived amount.
```

- [ ] **Step 2: Add a new bullet for `fx-rates.ts`**

Immediately after the `transaction-parser.ts` bullet (before the `message-cache.ts` bullet), insert:

```
**`fx-rates.ts`** — `getHistoricalRate(date, from, to)` fetches a historical exchange rate from `https://api.frankfurter.dev/v1/{date}?from={from}&to={to}` (the API auto-resolves weekends/holidays to the preceding published business day). Returns `null` on any failure (network error, unsupported currency, no data for the date) rather than throwing. Successful lookups are cached in-memory keyed by `date|from|to` — historical rates never change, so this is exact, not just an optimization; failed lookups are not cached, so a transient outage doesn't permanently block a currency pair.
```

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -n "balance - prevBalance" CLAUDE.md`
Expected: no output (the old phrasing was fully replaced).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document FX-aware applyBalanceDiffs and fx-rates.ts in CLAUDE.md

EOF
)"
```
