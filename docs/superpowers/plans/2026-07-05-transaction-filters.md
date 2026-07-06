# Transaction Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `categories`, `original_currencies`, `merchants` (regex), `amount_min`, and `amount_max` filter parameters to `get_transactions` and `summarize_transactions`, combined with AND across filter types and OR within a type.

**Architecture:** A new pure `filterTransactions()` function (plus a `validateFilters()` eager-validation helper) lives in `src/transaction-parser.ts`, applied as the last step in the shared `fetchParsedTransactions()` helper in `src/index.ts` — after `applyBalanceDiffs()` and `categorize()` have populated the fields the filters read. The inline-templates branch of `get_transactions` (caller supplies `templates` directly) gets the same treatment, plus a fix: it gains a `categorize()` call it was previously missing, so category filtering works there too.

**Tech Stack:** TypeScript, Zod (schema/validation), Vitest (tests).

## Global Constraints

- Filter matching: AND across filter types (`categories`, `original_currencies`, `merchants`, amount range), OR across multiple values within one type.
- `categories`: exact, case-sensitive match against `tx.category` (including `"uncategorized"`).
- `original_currencies`: case-insensitive exact match against `tx.original_currency`.
- `merchants`: regex patterns, case-insensitive + dotAll (flags `'is'`), tested against `tx.merchant` falling back to `tx.rawText` when merchant is absent (mirrors `categorize()`). Match if *any* pattern matches.
- Amount range (`amount_min`/`amount_max`): inclusive bounds on `Math.abs(tx.amount ?? tx.original_amount)`.
- Invalid regex in `merchants` is a hard error, validated eagerly before any LINE API call — same style as existing `since`/`until` validation in `fetchParsedTransactions`.
- Empty filter arrays are rejected by the schema (`.min(1)`) — omit the key entirely for "no filter."
- Filtering runs strictly after `applyBalanceDiffs()` and `categorize()`, never during parsing.

---

### Task 1: `TransactionFilterSchema`, `validateFilters`, `filterTransactions` in `transaction-parser.ts`

**Files:**
- Modify: `src/transaction-parser.ts` (add after `CategorySchema`/`Category`, i.e. after line 17)
- Test: `src/transaction-parser.test.ts` (new `describe('filterTransactions')` and `describe('validateFilters')` blocks, appended after the existing `describe('categorize', ...)` block, i.e. after line 437)

**Interfaces:**
- Consumes: `Transaction` type, `getRegex` (existing internal helper in the same file — no export needed, called directly), `NESTED_QUANTIFIER_RE` (existing internal, used indirectly via `getRegex`).
- Produces:
  - `export const TransactionFilterSchema = z.object({ categories, original_currencies, merchants, amount_min, amount_max })`
  - `export type TransactionFilter = z.infer<typeof TransactionFilterSchema>`
  - `export function validateFilters(filters: TransactionFilter): string | null`
  - `export function filterTransactions(transactions: Transaction[], filters: TransactionFilter): Transaction[]`

These are consumed by Task 2 (`src/index.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `src/transaction-parser.test.ts` (uses the existing `import { ... } from './transaction-parser'` at the top of the file — add `filterTransactions`, `validateFilters`, `TransactionFilter` to that import list):

```ts
describe('validateFilters', () => {
  it('returns null when merchants is absent', () => {
    expect(validateFilters({})).toBeNull();
  });

  it('returns null when all merchant patterns compile', () => {
    expect(validateFilters({ merchants: ['starbucks', 'grab.*'] })).toBeNull();
  });

  it('returns an error naming the bad pattern', () => {
    const err = validateFilters({ merchants: ['starbucks', '(unclosed'] });
    expect(err).not.toBeNull();
    expect(err).toContain('(unclosed');
  });

  it('rejects a pattern with catastrophic-backtracking risk', () => {
    const err = validateFilters({ merchants: ['(\\w+\\s*)+'] });
    expect(err).not.toBeNull();
  });
});

describe('filterTransactions', () => {
  function tx(overrides: Partial<Transaction>): Transaction {
    return {
      id: 'm1',
      date: '2026-06-01T00:00:00.000Z',
      original_amount: -100,
      original_currency: 'THB',
      rawText: 'Spent at Starbucks',
      ...overrides,
    };
  }

  it('returns all transactions when no filters are given', () => {
    const txs = [tx({}), tx({ id: 'm2' })];
    expect(filterTransactions(txs, {})).toHaveLength(2);
  });

  it('filters by a single category', () => {
    const txs = [tx({ category: 'Coffee' }), tx({ id: 'm2', category: 'Transport' })];
    const result = filterTransactions(txs, { categories: ['Coffee'] });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Coffee');
  });

  it('ORs multiple categories', () => {
    const txs = [
      tx({ id: 'm1', category: 'Coffee' }),
      tx({ id: 'm2', category: 'Transport' }),
      tx({ id: 'm3', category: 'Dining' }),
    ];
    const result = filterTransactions(txs, { categories: ['Coffee', 'Dining'] });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm3']);
  });

  it('matches the literal "uncategorized" category', () => {
    const txs = [tx({ category: 'uncategorized' }), tx({ id: 'm2', category: 'Coffee' })];
    const result = filterTransactions(txs, { categories: ['uncategorized'] });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('uncategorized');
  });

  it('category match is case-sensitive', () => {
    const txs = [tx({ category: 'Coffee' })];
    expect(filterTransactions(txs, { categories: ['coffee'] })).toHaveLength(0);
  });

  it('filters by original_currencies case-insensitively', () => {
    const txs = [
      tx({ id: 'm1', original_currency: 'USD' }),
      tx({ id: 'm2', original_currency: 'THB' }),
    ];
    const result = filterTransactions(txs, { original_currencies: ['usd'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('filters by merchant regex against the merchant field', () => {
    const txs = [
      tx({ id: 'm1', merchant: 'Starbucks Siam' }),
      tx({ id: 'm2', merchant: 'Grab' }),
    ];
    const result = filterTransactions(txs, { merchants: ['starbucks'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('merchant filter falls back to rawText when merchant is absent', () => {
    const txs = [tx({ rawText: 'You spent THB 120 at Starbucks Siam' })];
    expect(txs[0].merchant).toBeUndefined();
    const result = filterTransactions(txs, { merchants: ['starbucks'] });
    expect(result).toHaveLength(1);
  });

  it('ORs multiple merchant patterns', () => {
    const txs = [
      tx({ id: 'm1', merchant: 'Starbucks Siam' }),
      tx({ id: 'm2', merchant: 'Grab' }),
      tx({ id: 'm3', merchant: 'Netflix' }),
    ];
    const result = filterTransactions(txs, { merchants: ['starbucks', 'grab'] });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm2']);
  });

  it('filters by amount range using absolute value, matching debits and credits alike', () => {
    const txs = [
      tx({ id: 'm1', amount: -500 }),
      tx({ id: 'm2', amount: 500 }),
      tx({ id: 'm3', amount: -50 }),
      tx({ id: 'm4', amount: 5000 }),
    ];
    const result = filterTransactions(txs, { amount_min: 100, amount_max: 1000 });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm2']);
  });

  it('falls back to original_amount when amount is absent', () => {
    const txs = [tx({ original_amount: -300, amount: undefined })];
    const result = filterTransactions(txs, { amount_min: 200, amount_max: 400 });
    expect(result).toHaveLength(1);
  });

  it('amount_min alone means "at least"', () => {
    const txs = [tx({ id: 'm1', amount: -50 }), tx({ id: 'm2', amount: -500 })];
    const result = filterTransactions(txs, { amount_min: 100 });
    expect(result.map((t) => t.id)).toEqual(['m2']);
  });

  it('amount_max alone means "at most"', () => {
    const txs = [tx({ id: 'm1', amount: -50 }), tx({ id: 'm2', amount: -500 })];
    const result = filterTransactions(txs, { amount_max: 100 });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('ANDs across filter types', () => {
    const txs = [
      tx({ id: 'm1', category: 'Coffee', original_currency: 'THB', amount: -100 }),
      tx({ id: 'm2', category: 'Coffee', original_currency: 'USD', amount: -100 }),
      tx({ id: 'm3', category: 'Transport', original_currency: 'THB', amount: -100 }),
    ];
    const result = filterTransactions(txs, { categories: ['Coffee'], original_currencies: ['THB'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: FAIL — `validateFilters`/`filterTransactions`/`TransactionFilter` are not exported yet (TypeScript import error or `undefined is not a function`).

- [ ] **Step 3: Implement `TransactionFilterSchema`, `validateFilters`, `filterTransactions`**

In `src/transaction-parser.ts`, insert after the `Category` type export (after line 17, before `export const TransactionSchema`):

```ts
export const TransactionFilterSchema = z.object({
  categories: z.array(z.string()).min(1).optional().describe(
    'Match if tx.category equals any of these (exact, case-sensitive; "uncategorized" is a valid value)'
  ),
  original_currencies: z.array(z.string()).min(1).optional().describe(
    'Match if tx.original_currency equals any of these (case-insensitive)'
  ),
  merchants: z.array(z.string()).min(1).optional().describe(
    'JS regex patterns (case-insensitive); match if any pattern tests true against merchant, falling back to rawText when merchant is absent'
  ),
  amount_min: z.number().optional().describe('Inclusive lower bound on abs(amount ?? original_amount)'),
  amount_max: z.number().optional().describe('Inclusive upper bound on abs(amount ?? original_amount)'),
});
export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;
```

At the end of the file (after the existing `categorize` function), add:

```ts
export function validateFilters(filters: TransactionFilter): string | null {
  if (!filters.merchants) return null;
  for (const pattern of filters.merchants) {
    if (!getRegex(pattern, 'is')) {
      return `Invalid merchant regex: "${pattern}"`;
    }
  }
  return null;
}

export function filterTransactions(transactions: Transaction[], filters: TransactionFilter): Transaction[] {
  return transactions.filter((tx) => {
    if (filters.categories && !filters.categories.includes(tx.category ?? '')) {
      return false;
    }
    if (filters.original_currencies) {
      const match = filters.original_currencies.some(
        (c) => c.toLowerCase() === tx.original_currency.toLowerCase(),
      );
      if (!match) return false;
    }
    if (filters.merchants) {
      const text = tx.merchant ?? tx.rawText;
      const match = filters.merchants.some((pattern) => {
        const regex = getRegex(pattern, 'is');
        return regex ? regex.test(text) : false;
      });
      if (!match) return false;
    }
    if (filters.amount_min !== undefined || filters.amount_max !== undefined) {
      const effectiveAmount = Math.abs(tx.amount !== undefined ? tx.amount : tx.original_amount);
      if (filters.amount_min !== undefined && effectiveAmount < filters.amount_min) return false;
      if (filters.amount_max !== undefined && effectiveAmount > filters.amount_max) return false;
    }
    return true;
  });
}
```

Note: `getRegex` is the existing module-private function at line 45 of `transaction-parser.ts` — no new import needed since `filterTransactions`/`validateFilters` live in the same file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: PASS (all existing tests plus the new `validateFilters`/`filterTransactions` blocks)

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: add filterTransactions/validateFilters for category, currency, merchant, amount filters"
```

---

### Task 2: Wire filters into `get_transactions` and `summarize_transactions` in `index.ts`

**Files:**
- Modify: `src/index.ts` — `fetchParsedTransactions` (lines 545-608), the inline-templates branch of the `get_transactions` tool handler (lines 629-658), the `get_transactions` tool's `inputSchema` (lines 619-627), and the `summarize_transactions` tool's `inputSchema` + handler (lines 694-722)

**Interfaces:**
- Consumes from Task 1: `TransactionFilterSchema`, `TransactionFilter`, `validateFilters`, `filterTransactions`, `categorize` (already imported in `index.ts` — confirm it's in the existing import from `./transaction-parser`).
- Produces: no new exports; both tool handlers now accept `categories`, `original_currencies`, `merchants`, `amount_min`, `amount_max` params.

- [ ] **Step 1: Check current imports from `transaction-parser` in `index.ts`**

Run: `grep -n "from './transaction-parser'" src/index.ts`

Confirm the import line includes `categorize` already (per `CLAUDE.md`, it does). Add `TransactionFilterSchema`, `TransactionFilter`, `validateFilters`, `filterTransactions` to that same import statement.

- [ ] **Step 2: Update `fetchParsedTransactions` to validate and apply filters**

In `src/index.ts`, change the function signature (currently at line 545-550):

```ts
async function fetchParsedTransactions(
  authData: AuthData,
  chatMid: string,
  since?: string,
  until?: string,
  filters: TransactionFilter = {},
): Promise<
  | { transactions: Transaction[]; warnings: string[]; rangeNote: string }
  | { error: string }
> {
```

Add filter validation right after the existing since/until validation (after line 559, before `const warnings: string[] = [];`):

```ts
  const filterError = validateFilters(filters);
  if (filterError) {
    return { error: filterError };
  }
```

Add the `filterTransactions` call as the last step before `return { transactions, warnings, rangeNote };` (replace line 601-607):

```ts
  categorize(transactions, categoryStore.list());
  transactions = filterTransactions(transactions, filters);

  const rangeNote = since
    ? ''
    : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';

  return { transactions, warnings, rangeNote };
```

(Note: `transactions` is declared with `let` earlier in the function at line 589, so reassigning via `filterTransactions` is valid.)

- [ ] **Step 3: Add filter params to `get_transactions`'s `inputSchema` and thread them through both branches**

Replace the `inputSchema` block (lines 619-627):

```ts
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      templates: z.array(TransactionTemplateSchema).min(1).optional().describe(
        'Ordered list of patterns to try per message; first match wins. ' +
        'Omit to auto-load saved templates for this chat.'
      ),
      since: z.string().optional().describe('ISO date — exclude transactions before this date'),
      until: z.string().optional().describe('ISO date — exclude transactions after this date'),
      ...TransactionFilterSchema.shape,
    },
```

Replace the handler signature and inline-templates branch (lines 629-658):

```ts
  async ({ chatMid, templates: suppliedTemplates, since, until, categories, original_currencies, merchants, amount_min, amount_max }) => {
    const filters: TransactionFilter = { categories, original_currencies, merchants, amount_min, amount_max };
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      if (suppliedTemplates) {
        // Inline-template path — unchanged from before
        if (since && !Number.isFinite(new Date(since).getTime())) {
          return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
        }
        if (until && !Number.isFinite(new Date(until).getTime())) {
          return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
        }
        const filterError = validateFilters(filters);
        if (filterError) {
          return { content: [{ type: 'text' as const, text: filterError }], isError: true };
        }
        const client = makeLineClient(authData);
        const messages = since
          ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
          : await client.getMessages(chatMid, 200);
        let transactions = messages
          .map((msg) => parseTransaction(msg, suppliedTemplates))
          .filter((tx) => tx !== null);
        if (since) transactions = transactions.filter((tx) => tx.date >= since);
        if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
        transactions.sort((a, b) => a.date.localeCompare(b.date));
        await applyBalanceDiffs(transactions);
        categorize(transactions, categoryStore.list());
        transactions = filterTransactions(transactions, filters);
        const inlineWarnings = buildAmountWarnings(transactions);
        const warningBlock = inlineWarnings.length > 0 ? '\n\nWarnings:\n' + inlineWarnings.join('\n') : '';
        const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
        return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock + rangeNote }] };
      }

      // Saved-templates path — delegate to helper
      const fetched = await fetchParsedTransactions(authData, chatMid, since, until, filters);
```

(The remainder of the handler after `const fetched = await fetchParsedTransactions(...)`, i.e. current lines 662-684, stays unchanged — just note the "0 transactions matched" message at lines 668-676 should be updated to mention filters, see Step 5.)

- [ ] **Step 4: Add filter params to `summarize_transactions`**

Replace the `inputSchema` block (lines 694-699):

```ts
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      group_by: z.enum(['month', 'merchant', 'category']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name; "category" groups by assigned spending category'),
      since: z.string().optional().describe('ISO date — exclude transactions before this date'),
      until: z.string().optional().describe('ISO date — exclude transactions after this date'),
      ...TransactionFilterSchema.shape,
    },
```

Replace the handler (lines 701-706 signature, keep body from line 707 on but pass `filters` through):

```ts
  async ({ chatMid, group_by, since, until, categories, original_currencies, merchants, amount_min, amount_max }) => {
    const filters: TransactionFilter = { categories, original_currencies, merchants, amount_min, amount_max };
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const fetched = await fetchParsedTransactions(authData, chatMid, since, until, filters);
```

(Everything after this line in the existing handler body, i.e. current lines 708-720, stays unchanged — `fetchParsedTransactions` already returns the filtered set, so `summarize(transactions, group_by, since, until)` operates on filtered data with no further change needed.)

- [ ] **Step 5: Update the zero-match hint in `get_transactions` to mention filters**

In the saved-templates branch, update the message at (current) lines 668-676:

```ts
      if (transactions.length === 0) {
        const filterNote = Object.values(filters).some((v) => v !== undefined)
          ? ' Filters were applied — check category names via manage_categories (action: list), currency codes, merchant patterns, or the amount range.'
          : '';
        return {
          content: [{
            type: 'text' as const,
            text: '0 transactions matched. Check that saved templates cover the message timestamps — ' +
              'use manage_templates (action: list) to review validity ranges.' + filterNote + warningBlock + rangeNote,
          }],
        };
      }
```

- [ ] **Step 6: Build to catch type errors**

Run: `npm run build`
Expected: compiles with no TypeScript errors. If `TransactionFilterSchema.shape` spread causes a param-name collision or type mismatch, fix by confirming `categories`/`original_currencies`/`merchants`/`amount_min`/`amount_max` aren't already used as param names elsewhere in these two schemas (they aren't).

- [ ] **Step 7: Run the full unit test suite**

Run: `npm run test:unit`
Expected: PASS — no existing test regresses. (No existing unit test currently calls `fetchParsedTransactions` directly or checks the exact zero-match message text; if one does and now fails due to the Step 5 wording change, update that assertion to match the new message.)

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire category/currency/merchant/amount filters into get_transactions and summarize_transactions"
```

---

### Task 3: Documentation updates

**Files:**
- Modify: `docs/guide/tools/get_transactions.md`
- Modify: `docs/guide/tools/summarize_transactions.md`
- Modify: `docs/guide/overview.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing code-level — this task only updates prose to describe the filters shipped in Tasks 1-2. No test cycle (docs-only); reviewed by reading the diff.

- [ ] **Step 1: Update `docs/guide/tools/get_transactions.md`**

Replace the full file content:

```markdown
# get_transactions

**When to use:** To extract structured transaction records from bank notification messages in a LINE chat.

**Prerequisites:** `manage_templates` must have been called at least once to save templates for this chat. Templates load automatically — no need to pass them on each call.

**Next steps:** `summarize_transactions` to aggregate totals by month, merchant, or category.

**Key parameters:**
- `chatMid`: the chat MID from `list_chats`
- `since` (ISO date string, e.g. `"2026-05-01"`): **always pass this** for complete history over a date range. Without `since`, only the latest 200 messages are scanned and a note is appended recommending `since` for accuracy.
- `until` (ISO date string): optional end bound; defaults to now
- `categories` (array of strings, optional): keep only transactions whose `category` exactly matches one of these (case-sensitive; `"uncategorized"` is a valid value)
- `original_currencies` (array of strings, optional): keep only transactions whose `original_currency` matches one of these (case-insensitive)
- `merchants` (array of regex strings, optional): keep only transactions whose `merchant` (or `rawText`, if `merchant` is absent) matches any of these patterns (case-insensitive)
- `amount_min` / `amount_max` (numbers, optional): keep only transactions whose absolute amount (`amount` if present, else `original_amount`) falls within this inclusive range

Filters combine with AND across the different filter types above; multiple values within one filter type combine with OR (e.g. `categories: ["Coffee", "Dining"]` matches either).

**Categorization:** Every returned transaction includes a `category` field — automatically assigned from saved categories (see `manage_categories`), or `"uncategorized"` when no category pattern matches. Categories are global, not per-chat. This applies on both the saved-templates and inline-templates code paths.

**Avoid:** Don't call without `since` if you need complete monthly data — you will get incomplete results. Don't pass inline `templates` unless testing a new pattern; saved templates are already loaded automatically and apply `valid_from`/`valid_until` filtering per message. An invalid regex in `merchants` returns an error before any messages are fetched — check the pattern named in the error message.
```

- [ ] **Step 2: Update `docs/guide/tools/summarize_transactions.md`**

Replace the full file content:

```markdown
# summarize_transactions

**When to use:** To aggregate parsed transaction data into totals grouped by month, merchant, or category.

**Prerequisites:** `get_transactions` — this tool operates on the same parsed data pipeline. For category grouping, set up categories first via `manage_categories`.

**Next steps:** None — this is the final step in the transaction workflow.

**Key parameters:**
- `chatMid`: the chat MID
- `group_by`: `month` | `merchant` | `category`
- `since` / `until`: filter the aggregation window (ISO date strings)
- `categories` / `original_currencies` / `merchants` / `amount_min` / `amount_max`: same filters as `get_transactions` (see that tool's guide for full semantics) — applied before aggregation, so totals and group breakdowns reflect only the matching transactions. Filter types combine with AND; multiple values within one type combine with OR.

**Avoid:** Don't call before `get_transactions` has run with a `since` range covering the period you want to summarize — the result will be incomplete. When grouping by `category`, transactions with no matching category are grouped under `"uncategorized"`. A filter combination that matches nothing produces zero totals, not an error.
```

- [ ] **Step 3: Update `docs/guide/overview.md`**

Find the line (around line 18):

```markdown
- **Categories persist:** Spending categories saved with `manage_categories` are stored globally in `data/cache/messages.db` (not per-chat) and applied automatically to every transaction returned by `get_transactions` and `summarize_transactions`.
```

Add a new bullet immediately after it:

```markdown
- **Filtering:** `get_transactions` and `summarize_transactions` both accept `categories`, `original_currencies`, `merchants` (regex), `amount_min`, and `amount_max` to narrow results — different filter types AND together, multiple values within one type OR together.
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the `index.ts` bullet list, find the `get_transactions` line (line 34):

```markdown
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `data/templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. After parsing, calls `applyBalanceDiffs()` to populate the `amount` and `currency` fields from consecutive balance diffs for transactions that did not capture them explicitly, then calls `categorize()` to stamp each transaction's `category` field from saved categories (first pattern match against `merchant`/`rawText` wins; `"uncategorized"` when none match). Returns a zero-match hint when saved templates exist but nothing matched.
```

Replace with:

```markdown
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `data/templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. After parsing, calls `applyBalanceDiffs()` to populate the `amount` and `currency` fields from consecutive balance diffs for transactions that did not capture them explicitly, then calls `categorize()` to stamp each transaction's `category` field from saved categories (first pattern match against `merchant`/`rawText` wins; `"uncategorized"` when none match) — this now runs on both the saved-templates and inline-templates code paths. Finally applies `filterTransactions()` against optional `categories`/`original_currencies`/`merchants`/`amount_min`/`amount_max` params (AND across filter types, OR within a type; validated eagerly via `validateFilters()` before any LINE API call). Returns a zero-match hint when saved templates exist but nothing matched.
```

Find the `transaction-parser.ts` paragraph (line 87) and append this sentence to its end (after "`summarize`'s `groupBy` parameter also accepts `'category'`."):

```markdown
 Also exports `TransactionFilterSchema`/`TransactionFilter`, `validateFilters(filters)` (returns an error string naming the first invalid `merchants` regex, or `null`), and `filterTransactions(transactions, filters)` — a pure post-processing filter (categories: exact case-sensitive match on `category`; original_currencies: case-insensitive match; merchants: regex against `merchant`/`rawText` fallback, reusing the same `getRegex` cache and ReDoS guard as `categorize`; amount_min/amount_max: inclusive bounds on `Math.abs(amount ?? original_amount)`), called by `get_transactions` and `summarize_transactions` (via `fetchParsedTransactions`) as the final step after `categorize()`.
```

- [ ] **Step 5: Update `README.md`**

In the Tools table (lines 7-15), replace these two rows:

```markdown
| `get_transactions` | Parse bank notifications into structured transactions; paginates the full history when `since` is given; auto-loads saved templates |
| `summarize_transactions` | Aggregate transactions into totals grouped by month or merchant |
```

with:

```markdown
| `get_transactions` | Parse bank notifications into structured transactions; paginates the full history when `since` is given; auto-loads saved templates; supports filtering by category, currency, merchant regex, and amount range |
| `summarize_transactions` | Aggregate transactions into totals grouped by month, merchant, or category; supports the same filters as `get_transactions` |
```

In the "Transaction tools" section, after the existing tip about `since` (around line 55), add a new example before the "When a bank changes its message format..." line:

```markdown
> **Tip:** Narrow results with filters instead of fetching everything and filtering client-side. Example — dining spend over 500 THB in June: `get_transactions({ chatMid, since: "2026-06-01", until: "2026-06-30", categories: ["Dining"], amount_min: 500 })`. Filter types combine with AND; multiple values within one type (e.g. `categories: ["Dining", "Coffee"]`) combine with OR.
```

- [ ] **Step 6: Commit**

```bash
git add docs/guide/tools/get_transactions.md docs/guide/tools/summarize_transactions.md docs/guide/overview.md CLAUDE.md README.md
git commit -m "docs: document category/currency/merchant/amount filters for transaction tools"
```

---

## Self-Review Notes

- **Spec coverage:** `TransactionFilterSchema`/`validateFilters`/`filterTransactions` (Task 1), wiring into both tools + inline-path `categorize()` fix (Task 2), all five doc/guide files (Task 3) — matches every section of the 2026-07-05 design spec, including the "Fix in scope" inline-categorize decision.
- **Placeholder scan:** none — every step has literal code/commands.
- **Type consistency:** `TransactionFilter` field names (`categories`, `original_currencies`, `merchants`, `amount_min`, `amount_max`) are identical across the Zod schema (Task 1), the destructured handler params and `filters` object construction (Task 2), and the prose in Task 3 — checked for drift.
