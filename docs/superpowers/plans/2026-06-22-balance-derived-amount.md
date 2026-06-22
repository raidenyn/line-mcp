# Balance-Derived Amount & Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `amount` (native-currency equivalent) and `currency` (account default) to `Transaction`, compute `amount` from balance diffs when not explicitly captured, rename capture groups for consistency, migrate saved templates automatically, and update `summarize()` to prefer the new fields.

**Architecture:** Rename required capture groups in `parseTransaction` from `amount`/`currency` to `original_amount`/`original_currency`; add optional `amount` and `currency` groups mapping to new `Transaction` fields. Add a pure `applyBalanceDiffs()` post-processor that fills in `amount` from consecutive balance diffs, called from `get_transactions` after sorting. Migrate old saved template files on first load.

**Tech Stack:** TypeScript, Zod, Vitest, better-sqlite3 (no new deps)

## Global Constraints

- All new fields on `TransactionSchema` are `optional` (no runtime breakage for callers that construct `Transaction` objects manually in tests)
- `parseTransaction` remains a pure function — no side effects, no state
- `applyBalanceDiffs` mutates the array in place (caller owns the objects)
- Migration in `loadTemplates` is idempotent — running it twice on the same file produces no change
- All tests run with `npm run test:unit`

---

### Task 1: Update TransactionSchema and parseTransaction

**Files:**
- Modify: `src/transaction-parser.ts`
- Test: `src/transaction-parser.test.ts`

**Interfaces:**
- Produces: `Transaction` type gains `currency?: string` and `amount?: number`; `parseTransaction` now requires `original_amount` and `original_currency` named groups; `TransactionSchema` updated accordingly

- [ ] **Step 1: Update test file — rename template group names and add new field assertions**

Replace the entire `src/transaction-parser.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { parseTransaction, summarize, expandUntilBound, TransactionTemplate } from './transaction-parser';

const UOB_DEBIT_MSG = {
  id: 'm1',
  createdTime: '1749999600000', // 2025-06-15T11:00:00.000Z
  contentType: 0,
  text: 'มีการใช้บัตร UOB-7268 @7-11CHAREONKUNG109YAEK1 241.5 THB วันที่ 15/06 วงเงินคงเหลือใช้ได้ 979,546.00 THB\n\nYou have spent THB 241.5 using UOB card (ending UOB-7268) at @7-11CHAREONKUNG109YAEK1 on 15/06. Available credit: THB 979,546.00',
};

const UOB_TEMPLATES: TransactionTemplate[] = [
  {
    pattern:
      'You have spent (?<original_currency>\\w+) (?<original_amount>[\\d,]+\\.?\\d*) using UOB card \\(ending (?<account>[^)]+)\\) at (?<merchant>.+?) on (?<date>\\d{2}/\\d{2})\\. Available credit: THB (?<balance>[\\d,]+\\.?\\d*)',
    amount_sign: 'debit',
    date_format: 'DD/MM',
  },
];

const PROMO_MSG = {
  id: 'm2',
  createdTime: '1749999600000',
  contentType: 0,
  text: 'UOB Special! Get 10% cashback on all dining this weekend. T&Cs apply.',
};

const IMAGE_MSG = {
  id: 'm3',
  createdTime: '1749999600000',
  contentType: 1,
  text: undefined,
};

describe('parseTransaction', () => {
  it('parses a UOB debit message', () => {
    const tx = parseTransaction(UOB_DEBIT_MSG, UOB_TEMPLATES);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-241.5);
    expect(tx!.original_currency).toBe('THB');
    expect(tx!.merchant).toBe('@7-11CHAREONKUNG109YAEK1');
    expect(tx!.account).toBe('UOB-7268');
    expect(tx!.balance).toBe(979546.0);
    expect(tx!.id).toBe('m1');
  });

  it('captures currency and amount from optional groups', () => {
    const msg = {
      id: 'fx1',
      createdTime: '1749999600000',
      contentType: 0,
      text: 'FX spend USD 50 (THB 1750) at Starbucks. Balance: THB 50000',
    };
    const templates: TransactionTemplate[] = [
      {
        pattern:
          'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>\\w+) (?<amount>[\\d.]+)\\) at (?<merchant>.+?)\\. Balance: \\w+ (?<balance>[\\d.]+)',
        amount_sign: 'debit',
      },
    ];
    const tx = parseTransaction(msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-50);
    expect(tx!.original_currency).toBe('USD');
    expect(tx!.currency).toBe('THB');
    expect(tx!.amount).toBe(1750);
    expect(tx!.balance).toBe(50000);
  });

  it('returns null for a promotional message', () => {
    expect(parseTransaction(PROMO_MSG, UOB_TEMPLATES)).toBeNull();
  });

  it('returns null for a non-text message', () => {
    expect(parseTransaction(IMAGE_MSG, UOB_TEMPLATES)).toBeNull();
  });

  it('returns null when pattern is missing required original_amount group', () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns null when pattern is missing required original_currency group', () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d.]+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns null for an invalid regex pattern', () => {
    const badTemplates: TransactionTemplate[] = [{ pattern: '([invalid' }];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns result (not throw) for DD/MM format with non-numeric date capture', () => {
    const msg = { ...UOB_DEBIT_MSG, text: 'spent 100 THB on ab/cd' };
    const templates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d]+) (?<original_currency>\\w+) on (?<date>.+)', date_format: 'DD/MM' },
    ];
    expect(() => parseTransaction(msg, templates)).not.toThrow();
    const tx = parseTransaction(msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.date).toBe(new Date(parseInt(UOB_DEBIT_MSG.createdTime, 10)).toISOString());
  });

  it('returns null for a pattern with nested quantifiers (ReDoS guard)', () => {
    const dangerous: TransactionTemplate[] = [
      { pattern: '(\\w+\\s*)+(end)?(?<original_amount>\\d+) (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, dangerous)).toBeNull();
  });

  it('tries subsequent templates when first does not match', () => {
    const templates: TransactionTemplate[] = [
      { pattern: 'NOMATCH (?<original_amount>[\\d]+) (?<original_currency>\\w+)', amount_sign: 'debit' },
      ...UOB_TEMPLATES,
    ];
    const tx = parseTransaction(UOB_DEBIT_MSG, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('THB');
  });
});

describe('summarize', () => {
  const txs = [
    {
      id: 'm1', date: '2026-06-01T00:00:00.000Z',
      original_amount: -100, original_currency: 'THB', merchant: '7-Eleven', rawText: '',
    },
    {
      id: 'm2', date: '2026-06-15T00:00:00.000Z',
      original_amount: -200, original_currency: 'THB', merchant: 'Grab', rawText: '',
    },
    {
      id: 'm3', date: '2026-06-20T00:00:00.000Z',
      original_amount: 50, original_currency: 'THB', merchant: '7-Eleven', rawText: '',
    },
    {
      id: 'm4', date: '2026-07-01T00:00:00.000Z',
      original_amount: -300, original_currency: 'THB', merchant: 'Grab', rawText: '',
    },
  ];

  it('groups by month', () => {
    const result = summarize(txs, 'month');
    expect(result.transactions_count).toBe(4);
    expect(result.by_group['2026-06'].debit).toBe(300);
    expect(result.by_group['2026-06'].credit).toBe(50);
    expect(result.by_group['2026-07'].debit).toBe(300);
    expect(result.currency).toBe('THB');
  });

  it('groups by merchant', () => {
    const result = summarize(txs, 'merchant');
    expect(result.by_group['7-Eleven'].debit).toBe(100);
    expect(result.by_group['7-Eleven'].credit).toBe(50);
    expect(result.by_group['Grab'].debit).toBe(500);
  });

  it('filters by since/until', () => {
    const result = summarize(txs, 'month', '2026-06-10T00:00:00.000Z', '2026-06-30T00:00:00.000Z');
    expect(result.transactions_count).toBe(2);
    expect(Object.keys(result.by_group)).toEqual(['2026-06']);
  });

  it('reports mixed currency when transactions span multiple currencies', () => {
    const mixed = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -10, original_currency: 'USD', rawText: '' },
    ];
    const result = summarize(mixed, 'month');
    expect(result.currency).toBe('mixed');
  });

  it('computes correct net', () => {
    const result = summarize(txs, 'month');
    expect(result.total_debit).toBe(600);
    expect(result.total_credit).toBe(50);
    expect(result.net).toBe(-550);
  });

  it('returns currency "none" when no transactions match the filter', () => {
    const result = summarize(txs, 'month', '2030-01-01T00:00:00.000Z', '2030-12-31T23:59:59.999Z');
    expect(result.transactions_count).toBe(0);
    expect(result.currency).toBe('none');
  });

  it('expandUntilBound handles YYYY-MM by expanding to end of month', () => {
    expect(expandUntilBound('2026-06')).toBe('2026-06-31T23:59:59.999Z');
    expect(expandUntilBound('2026-06-15')).toBe('2026-06-15T23:59:59.999Z');
    expect(expandUntilBound('2026-06-15T12:00:00.000Z')).toBe('2026-06-15T12:00:00.000Z');
  });

  it('filters correctly when until is a YYYY-MM string', () => {
    const result = summarize(txs, 'month', undefined, '2026-06');
    expect(result.transactions_count).toBe(3);
    expect(Object.keys(result.by_group)).toEqual(['2026-06']);
  });

  it('uses amount and currency fields when present', () => {
    const fxTxs = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', amount: -3500, currency: 'THB', rawText: '' },
    ];
    const result = summarize(fxTxs, 'month');
    expect(result.total_debit).toBe(5250);
    expect(result.currency).toBe('THB');
  });

  it('falls back to original_amount when amount is absent', () => {
    const domTxs = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', rawText: '' },
    ];
    const result = summarize(domTxs, 'month');
    expect(result.total_debit).toBe(100);
    expect(result.currency).toBe('THB');
  });

  it('reports mixed when amount-present and amount-absent transactions have different effective currencies', () => {
    const mixed = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', rawText: '' },
    ];
    const result = summarize(mixed, 'month');
    expect(result.currency).toBe('mixed');
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: `parseTransaction` tests that use `UOB_TEMPLATES` fail ("0 transactions parsed" or similar) because old `amount`/`currency` groups are now missing from the pattern. The `summarize` tests for `amount`/`currency` fields fail because `Transaction` type doesn't have those fields yet.

- [ ] **Step 3: Update TransactionSchema and parseTransaction in `src/transaction-parser.ts`**

Replace the schema and `parseTransaction` function body:

```typescript
export const TransactionTemplateSchema = z.object({
  pattern: z.string().describe('JS regex with named capture groups: original_amount, original_currency (required); amount, currency, merchant, date, balance, account (optional)'),
  amount_sign: z.enum(['debit', 'credit']).optional().describe('Sign to apply to original_amount when not already signed in the captured value'),
  date_format: z.string().optional().describe('Format hint for the captured date group, e.g. "DD/MM" or "DD/MM/YYYY HH:mm"'),
});
export type TransactionTemplate = z.infer<typeof TransactionTemplateSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  original_amount: z.number(),
  original_currency: z.string(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  account: z.string().optional(),
  merchant: z.string().optional(),
  balance: z.number().optional(),
  rawText: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;
```

Replace the loop body inside `parseTransaction`:

```typescript
export function parseTransaction(
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
): Transaction | null {
  if (message.contentType !== 0 || !message.text) return null;

  for (const tmpl of templates) {
    const regex = getRegex(tmpl.pattern);
    if (!regex) continue;

    const match = regex.exec(message.text);
    if (!match?.groups) continue;

    const g = match.groups;
    if (!g.original_amount || !g.original_currency) continue;

    let original_amount = parseNumeric(g.original_amount);
    if (tmpl.amount_sign && !/^[\s]*[+\-−]/.test(g.original_amount)) {
      if (tmpl.amount_sign === 'debit') original_amount = -Math.abs(original_amount);
      else if (tmpl.amount_sign === 'credit') original_amount = Math.abs(original_amount);
    }

    const tx: Transaction = {
      id: message.id,
      date: parseDate(g.date, tmpl.date_format, message.createdTime),
      original_amount,
      original_currency: g.original_currency.trim(),
      rawText: message.text,
    };

    if (g.currency) tx.currency = g.currency.trim();
    if (g.amount) tx.amount = parseNumeric(g.amount);
    if (g.merchant) tx.merchant = g.merchant.trim();
    if (g.account) tx.account = g.account.trim();
    if (g.balance) tx.balance = parseNumeric(g.balance);

    return tx;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: rename capture groups to original_amount/original_currency; add currency and amount fields to Transaction"
```

---

### Task 2: Update summarize() and add applyBalanceDiffs()

**Files:**
- Modify: `src/transaction-parser.ts`
- Test: `src/transaction-parser.test.ts` (tests already written in Task 1 Step 1)

**Interfaces:**
- Consumes: `Transaction` type from Task 1
- Produces: `applyBalanceDiffs(transactions: Transaction[]): void` — exported, mutates in place; `summarize()` updated to use `amount`/`currency` when present

- [ ] **Step 1: Run the summarize tests added in Task 1 to confirm they currently fail**

```bash
npx vitest run src/transaction-parser.test.ts -t "uses amount and currency fields"
npx vitest run src/transaction-parser.test.ts -t "falls back to original_amount"
npx vitest run src/transaction-parser.test.ts -t "reports mixed when amount-present"
```

Expected: these three new tests fail because `summarize()` still uses `original_amount`/`original_currency` only.

- [ ] **Step 2: Replace the summarize() function body in `src/transaction-parser.ts`**

```typescript
export function summarize(
  transactions: Transaction[],
  groupBy: 'month' | 'merchant',
  since?: string,
  until?: string,
): SummaryOutput {
  let filtered = transactions;
  if (since) filtered = filtered.filter((tx) => tx.date >= since);
  if (until) {
    filtered = filtered.filter((tx) => tx.date <= expandUntilBound(until));
  }

  const byGroup: Record<string, { debit: number; credit: number; count: number }> = {};
  let total_debit = 0;
  let total_credit = 0;

  for (const tx of filtered) {
    const key =
      groupBy === 'month'
        ? tx.date.slice(0, 7)
        : (tx.merchant ?? 'unknown');

    if (!byGroup[key]) byGroup[key] = { debit: 0, credit: 0, count: 0 };

    const amt = tx.amount ?? tx.original_amount;
    if (amt < 0) {
      const abs = Math.abs(amt);
      byGroup[key].debit += abs;
      total_debit += abs;
    } else {
      byGroup[key].credit += amt;
      total_credit += amt;
    }
    byGroup[key].count++;
  }

  const currencies = [
    ...new Set(
      filtered.map((tx) =>
        tx.amount !== undefined
          ? (tx.currency ?? tx.original_currency)
          : tx.original_currency,
      ),
    ),
  ];
  const currency =
    currencies.length === 0 ? 'none' : currencies.length === 1 ? currencies[0] : 'mixed';

  return {
    total_debit,
    total_credit,
    net: total_credit - total_debit,
    by_group: byGroup,
    currency,
    transactions_count: filtered.length,
  };
}
```

- [ ] **Step 3: Add applyBalanceDiffs tests to `src/transaction-parser.test.ts`**

Append to the end of `src/transaction-parser.test.ts`:

```typescript
import { applyBalanceDiffs, Transaction } from './transaction-parser';

describe('applyBalanceDiffs', () => {
  it('leaves first transaction amount undefined when no prior balance', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[1].amount).toBe(-200);
  });

  it('does not overwrite an explicit amount', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-1750);
    expect(txs[1].amount).toBe(-200);
  });

  it('skips diff when current tx has no balance; uses last known balance for later txs', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'THB', rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[1].amount).toBeUndefined();
    expect(txs[2].amount).toBe(-200);
  });

  it('groups by account to avoid cross-account balance diffs', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', account: 'acc-A', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', account: 'acc-B', balance: 5000, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -300, original_currency: 'THB', account: 'acc-A', balance: 9700, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[1].amount).toBeUndefined();
    expect(txs[2].amount).toBe(-300);
  });

  it('groups transactions with no account together (empty-string key)', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[1].amount).toBe(-200);
  });
});
```

- [ ] **Step 4: Run tests — they will fail because applyBalanceDiffs is not exported yet**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: import error for `applyBalanceDiffs`.

- [ ] **Step 5: Add applyBalanceDiffs export to `src/transaction-parser.ts`**

Add after the `summarize` function:

```typescript
export function applyBalanceDiffs(transactions: Transaction[]): void {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = tx.account ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }
  for (const group of groups.values()) {
    let prevBalance: number | undefined;
    for (const tx of group) {
      if (tx.amount === undefined && tx.balance !== undefined && prevBalance !== undefined) {
        tx.amount = tx.balance - prevBalance;
      }
      if (tx.balance !== undefined) prevBalance = tx.balance;
    }
  }
}
```

- [ ] **Step 6: Run all tests to confirm everything passes**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: update summarize() to prefer amount/currency; add applyBalanceDiffs()"
```

---

### Task 3: Add template migration in loadTemplates

**Files:**
- Modify: `src/template-store.ts`
- Test: `src/template-store.test.ts`

**Interfaces:**
- Consumes: nothing new — loadTemplates signature is unchanged
- Produces: `loadTemplates` automatically rewrites old `(?<amount>...)` and `(?<currency>...)` group names to `(?<original_amount>...)` and `(?<original_currency>...)` in the file on first load

- [ ] **Step 1: Update test fixtures in `src/template-store.test.ts` to use new group names**

Replace `TMPL_A`, `TMPL_B`, and the `noRange` template inside `filterByTime` tests:

```typescript
const TMPL_A: NamedTemplate = {
  name: 'uob-debit-v1',
  pattern: 'spent\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_until: '2025-02-28T23:59:59+07:00',
};
const TMPL_B: NamedTemplate = {
  name: 'uob-debit-v2',
  pattern: 'deducted\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_from: '2025-03-01T00:00:00+07:00',
};
```

Inside the `filterByTime` describe block, update `noRange`:

```typescript
const noRange: NamedTemplate = { name: 'open', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)' };
```

Update `bad` templates in `filterByTime` tests:

```typescript
// treats unparseable valid_from as always-valid
const bad: NamedTemplate = { name: 'bad', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)', valid_from: 'not-a-date' };

// treats unparseable valid_until as always-valid
const bad: NamedTemplate = { name: 'bad', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)', valid_until: 'not-a-date' };
```

- [ ] **Step 2: Run existing template-store tests to confirm they still pass (no migration needed for new-style patterns)**

```bash
npx vitest run src/template-store.test.ts
```

Expected: all existing tests pass.

- [ ] **Step 3: Add migration tests to `src/template-store.test.ts`**

Add these imports at the top (add `writeFileSync` and `join` if not already imported):

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
```

Add a new describe block:

```typescript
describe('loadTemplates migration', () => {
  it('migrates old (?<amount>) and (?<currency>) group names to new names on load', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'old-tmpl',
            pattern: 'spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
            amount_sign: 'debit',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
    );
    expect(result.warning).toBeUndefined();
  });

  it('rewrites the file so subsequent loads return the migrated pattern', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [{ name: 'old', pattern: 'pay (?<currency>\\w+) (?<amount>[\\d.]+)' }],
      }),
    );

    loadTemplates('mid123', dir); // triggers migration + rewrite
    const reloaded = loadTemplates('mid123', dir);
    expect(reloaded.templates[0].pattern).toBe('pay (?<original_currency>\\w+) (?<original_amount>[\\d.]+)');
  });

  it('preserves other named groups during migration', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'complex',
            pattern: 'spent (?<currency>\\w+) (?<amount>[\\d.]+) at (?<merchant>.+)',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+) at (?<merchant>.+)',
    );
  });

  it('does not migrate patterns that already use new group names', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'new-tmpl',
            pattern: 'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+)',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+)',
    );
  });
});
```

- [ ] **Step 4: Run migration tests to confirm they fail**

```bash
npx vitest run src/template-store.test.ts -t "migration"
```

Expected: all 4 migration tests fail (patterns are not migrated).

- [ ] **Step 5: Add migration logic to `loadTemplates` in `src/template-store.ts`**

Replace the `loadTemplates` function:

```typescript
export function loadTemplates(
  chatMid: string,
  storeDir = DEFAULT_STORE_DIR,
): { templates: NamedTemplate[]; warning?: string } {
  const path = safeFilePath(chatMid, storeDir);
  if (!existsSync(path)) return { templates: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const rawTemplates: NamedTemplate[] = raw.templates ?? [];
    const migrated = rawTemplates.map((t) => {
      const newPattern = t.pattern
        .replace(/\(\?<amount>/g, '(?<original_amount>')
        .replace(/\(\?<currency>/g, '(?<original_currency>');
      return newPattern === t.pattern ? t : { ...t, pattern: newPattern };
    });
    if (migrated.some((t, i) => t !== rawTemplates[i])) {
      writeFileSync(path, JSON.stringify({ templates: migrated }, null, 2));
      process.stderr.write(
        `[LINE] Migrated template patterns for chat ${chatMid}: renamed (?<amount>→(?<original_amount>), (?<currency>→(?<original_currency>)\n`,
      );
    }
    return { templates: migrated };
  } catch {
    return { templates: [], warning: `Template file for ${chatMid} is corrupt or unreadable — returning empty list.` };
  }
}
```

- [ ] **Step 6: Run all template-store tests**

```bash
npx vitest run src/template-store.test.ts
```

Expected: all tests pass, including the 4 new migration tests.

- [ ] **Step 7: Commit**

```bash
git add src/template-store.ts src/template-store.test.ts
git commit -m "feat: auto-migrate old (?<amount>/(?<currency>) group names in saved templates on load"
```

---

### Task 4: Wire applyBalanceDiffs into get_transactions and update manage_templates description

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `applyBalanceDiffs` from `src/transaction-parser.ts` (Task 2)

- [ ] **Step 1: Update the import line in `src/index.ts`**

Find:
```typescript
import { parseTransaction, summarize, expandUntilBound, TransactionTemplateSchema, TransactionSchema } from './transaction-parser';
```

Replace with:
```typescript
import { parseTransaction, summarize, expandUntilBound, applyBalanceDiffs, TransactionTemplateSchema, TransactionSchema } from './transaction-parser';
```

- [ ] **Step 2: Call applyBalanceDiffs after sorting in get_transactions**

Find the line (inside the `get_transactions` handler):
```typescript
      transactions.sort((a, b) => a.date.localeCompare(b.date));
```

Replace with:
```typescript
      transactions.sort((a, b) => a.date.localeCompare(b.date));
      applyBalanceDiffs(transactions);
```

- [ ] **Step 3: Update the manage_templates pattern rules description**

Find inside `server.registerTool('manage_templates', ...`:
```typescript
        'Use named capture groups — (?<currency>...) and (?<amount>...) are REQUIRED; ' +
        '(?<merchant>...), (?<date>...), (?<balance>...), (?<account>...) are optional. ' +
```

Replace with:
```typescript
        'Use named capture groups — (?<original_amount>...) and (?<original_currency>...) are REQUIRED; ' +
        '(?<amount>...), (?<currency>...), (?<merchant>...), (?<date>...), (?<balance>...), (?<account>...) are optional. ' +
        '(?<amount>) captures native-currency amount directly; if absent, it is computed from consecutive balance diffs. ' +
        '(?<currency>) captures the account default currency (e.g. "THB"); (?<original_currency>) captures the transaction currency (e.g. "USD" for foreign spends). ' +
```

- [ ] **Step 4: Run unit tests to confirm nothing is broken**

```bash
npm run test:unit
```

Expected: all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire applyBalanceDiffs into get_transactions; update manage_templates group name docs"
```

---

### Task 5: Update README.md and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README.md — UOB Thai example template**

Find:
```json
  "pattern": "You\\s+have\\s+spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,]+\\.?\\d*)\\s+using\\s+UOB\\s+card\\s+\\(ending\\s+(?<account>[^)]+)\\)\\s+at\\s+(?<merchant>.+?)\\s+on\\s+(?<date>\\d{2}/\\d{2})\\.\\s+Available\\s+credit:\\s+THB\\s+(?<balance>[\\d,]+\\.?\\d*)",
```

Replace with:
```json
  "pattern": "You\\s+have\\s+spent\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+using\\s+UOB\\s+card\\s+\\(ending\\s+(?<account>[^)]+)\\)\\s+at\\s+(?<merchant>.+?)\\s+on\\s+(?<date>\\d{2}/\\d{2})\\.\\s+Available\\s+credit:\\s+THB\\s+(?<balance>[\\d,]+\\.?\\d*)",
```

- [ ] **Step 2: Update README.md — CardX Thailand example template**

Find:
```json
  "pattern": "CardX\\s+would\\s+like\\s+to\\s+inform\\s+that\\s+you\\s+have\\s+made\\s+transaction\\s+via\\s+card\\s+ending\\s+with\\s+(?<account>\\d+)\\s+at\\s+(?<merchant>.+?)\\s+in\\s+the\\s+amount\\s+of\\s+(?<amount>[\\d,]+\\.?\\d*)\\s+(?<currency>[A-Z]+)\\s+on\\s+(?<date>.+?)\\.\\s+You\\s+have\\s+available\\s+credit\\s+limit\\s+(?<balance>[\\d,]+\\.?\\d*)",
```

Replace with:
```json
  "pattern": "CardX\\s+would\\s+like\\s+to\\s+inform\\s+that\\s+you\\s+have\\s+made\\s+transaction\\s+via\\s+card\\s+ending\\s+with\\s+(?<account>\\d+)\\s+at\\s+(?<merchant>.+?)\\s+in\\s+the\\s+amount\\s+of\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>[A-Z]+)\\s+on\\s+(?<date>.+?)\\.\\s+You\\s+have\\s+available\\s+credit\\s+limit\\s+(?<balance>[\\d,]+\\.?\\d*)",
```

- [ ] **Step 3: Update README.md — manage_templates workflow description**

Find:
```
2. Call `manage_templates` (`action: upsert`) to save a named regex template with capture groups
```

Replace with:
```
2. Call `manage_templates` (`action: upsert`) to save a named regex template — required capture groups are `(?<original_amount>...)` and `(?<original_currency>...)`; add `(?<balance>...)` to enable automatic native-currency `amount` calculation from balance diffs
```

- [ ] **Step 4: Update CLAUDE.md — transaction-parser.ts description**

Find:
```
**`transaction-parser.ts`** — template-driven transaction parser. Exports `parseTransaction(message, templates)` which applies an ordered list of caller-supplied regex patterns (named capture groups: `amount`, `currency` (required); `merchant`, `date`, `balance`, `account` (optional)) to a single message and returns a `Transaction` or `null`. Also exports `summarize(transactions, groupBy, since, until)` for pure-math aggregation. No LINE API calls; used directly by the `get_transactions` and `summarize_transactions` tool handlers in `index.ts`. Key design: `currency` must always be an explicit named capture group — no fallbacks. The `'s'` (dotAll) flag is applied to all patterns so `.` matches newlines in bilingual messages (e.g. UOB Thai + English in one blob).
```

Replace with:
```
**`transaction-parser.ts`** — template-driven transaction parser. Exports `parseTransaction(message, templates)` which applies an ordered list of caller-supplied regex patterns (named capture groups: `original_amount`, `original_currency` (required); `amount`, `currency`, `merchant`, `date`, `balance`, `account` (optional)) to a single message and returns a `Transaction` or `null`. The `amount` group captures the native-currency amount explicitly; if absent, `applyBalanceDiffs()` computes it from consecutive balance diffs after the full list is built. `currency` captures the account default currency (e.g. "THB"); `original_currency` captures the transaction currency (e.g. "USD" for foreign spends). Also exports `summarize(transactions, groupBy, since, until)` for pure-math aggregation — uses `amount`/`currency` when present, falls back to `original_amount`/`original_currency` per transaction. Exports `applyBalanceDiffs(transactions)` which mutates a sorted array in place: groups by `account`, then fills `amount = balance - prevBalance` for transactions missing an explicit `amount`. No LINE API calls; used directly by the `get_transactions` and `summarize_transactions` tool handlers in `index.ts`. The `'s'` (dotAll) flag is applied to all patterns so `.` matches newlines in bilingual messages (e.g. UOB Thai + English in one blob).
```

- [ ] **Step 5: Update CLAUDE.md — index.ts get_transactions description**

Find:
```
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `.line-templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. Returns a zero-match hint when saved templates exist but nothing matched.
```

Replace with:
```
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `.line-templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. After parsing, calls `applyBalanceDiffs()` to populate the `amount` field from consecutive balance diffs for transactions that did not capture it explicitly. Returns a zero-match hint when saved templates exist but nothing matched.
```

- [ ] **Step 6: Update CLAUDE.md — template-store.ts description**

Find the line:
```
- `loadTemplates(chatMid)` → `{ templates, warning? }` — reads file; returns `[]` on absence or corruption (with warning).
```

Replace with:
```
- `loadTemplates(chatMid)` → `{ templates, warning? }` — reads file; automatically migrates old `(?<amount>...)` and `(?<currency>...)` capture group names to `(?<original_amount>...)` and `(?<original_currency>...)` and rewrites the file in place on first load; returns `[]` on absence or corruption (with warning).
```

- [ ] **Step 7: Run full unit test suite to confirm nothing is broken**

```bash
npm run test:unit
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README and CLAUDE.md for new original_amount/original_currency capture group names"
```
