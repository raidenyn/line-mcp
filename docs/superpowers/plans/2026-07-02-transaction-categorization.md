# Automated Transaction Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically tag every parsed transaction with a spending category, matched via user-managed regexes, and let `summarize_transactions` group totals by category.

**Architecture:** A new global (not per-chat) `categories` table lives in the existing `data/cache/messages.db` SQLite file, managed by a new `CategoryStore` class. A pure `categorize()` function in `transaction-parser.ts` stamps each `Transaction` with a `category` field by testing category regexes against `merchant` (falling back to `rawText`), first match wins. This runs inside the shared `fetchParsedTransactions()` helper in `index.ts`, so both `get_transactions` and `summarize_transactions` pick it up automatically. A new `manage_categories` MCP tool exposes CRUD.

**Tech Stack:** TypeScript, `better-sqlite3`, `zod`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-07-02-transaction-categorization-design.md`

## Global Constraints

- Categories are **global**, not scoped per chat (unlike templates) — no `chatMid` parameter anywhere in category CRUD.
- Categories have **no time-bounding** (`valid_from`/`valid_until`) — that's a templates-only concept.
- Categories are stored in a new `categories` table inside the **existing** `data/cache/messages.db` file — no second SQLite database file.
- Category regex matching is **case-insensitive** (`i` flag) plus the `s` (dotAll) flag, applied automatically — the user never writes flags themselves.
- Matching target: `tx.merchant ?? tx.rawText`. **First match in category list order wins.** No match → `category = 'uncategorized'`.
- `Transaction.category` is **optional at the type level** (`z.string().optional()`), populated only by `categorize()` — it mirrors how `amount`/`currency` are optional and populated by `applyBalanceDiffs()`.
- The **inline-templates path** in `get_transactions` (caller supplies `templates` directly) does **not** run `categorize()` — only the saved-templates path (via `fetchParsedTransactions()`) does.
- Per `CLAUDE.md`'s maintenance rule: any new tool requires a `docs/guide/tools/<name>.md` file and a matching `registerResource` call in `index.ts`, done in the same task that adds the tool.
- Bad/unparseable category regex patterns are accepted at upsert time and simply never match at categorize time (no upsert-time validation) — same behavior as templates.

---

### Task 1: Category schema, `categorize()`, and category grouping in `summarize()`

**Files:**
- Modify: `src/transaction-parser.ts`
- Test: `src/transaction-parser.test.ts`

**Interfaces:**
- Consumes: nothing new — uses existing `Transaction` type and the module-private `NESTED_QUANTIFIER_RE` already defined in this file.
- Produces:
  - `CategorySchema: z.ZodObject`, `Category` type — `{ name: string; pattern: string }`
  - `Transaction.category?: string`
  - `categorize(transactions: Transaction[], categories: Category[]): void` — mutates `transactions` in place
  - `summarize(transactions, groupBy: 'month' | 'merchant' | 'category', since?, until?): SummaryOutput` — `groupBy` union extended with `'category'`

- [ ] **Step 1: Write failing tests for `categorize()`**

Add to `src/transaction-parser.test.ts`. First update the import at the top of the file:

```ts
import { parseTransaction, summarize, expandUntilBound, TransactionTemplate, applyBalanceDiffs, categorize, Transaction, Category } from './transaction-parser';
```

Then append this new `describe` block at the end of the file:

```ts
describe('categorize', () => {
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

  it('matches against the merchant field', () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ merchant: 'Starbucks Siam' })];
    categorize(txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });

  it('falls back to rawText when merchant is absent', () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ rawText: 'You spent THB 120 at Starbucks Siam' })];
    expect(txs[0].merchant).toBeUndefined();
    categorize(txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });

  it('picks the first matching category in list order', () => {
    const categories: Category[] = [
      { name: 'Food', pattern: 'starbucks' },
      { name: 'Coffee', pattern: 'starbucks' },
    ];
    const txs = [tx({ merchant: 'Starbucks Siam' })];
    categorize(txs, categories);
    expect(txs[0].category).toBe('Food');
  });

  it('sets uncategorized when no category matches', () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ merchant: 'Grab' })];
    categorize(txs, categories);
    expect(txs[0].category).toBe('uncategorized');
  });

  it('sets uncategorized when no categories are configured', () => {
    const txs = [tx({ merchant: 'Grab' })];
    categorize(txs, []);
    expect(txs[0].category).toBe('uncategorized');
  });

  it('matches case-insensitively', () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'STARBUCKS' }];
    const txs = [tx({ merchant: 'starbucks siam' })];
    categorize(txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: FAIL — `categorize` is not exported from `./transaction-parser` (and `Category` type does not exist), causing a TypeScript/import error.

- [ ] **Step 3: Implement `CategorySchema`, `Category`, `Transaction.category`, and `categorize()`**

In `src/transaction-parser.ts`, add `CategorySchema`/`Category` right after the existing `TransactionTemplate` type (after line 8, `export type TransactionTemplate = z.infer<typeof TransactionTemplateSchema>;`):

```ts
export const CategorySchema = z.object({
  name: z.string().min(1).describe('Unique category name, e.g. "Groceries"'),
  pattern: z.string().describe(
    'JS regex tested against merchant (falls back to rawText if merchant is absent). Compiled case-insensitively.'
  ),
});
export type Category = z.infer<typeof CategorySchema>;
```

Add `category` to `TransactionSchema` (currently lines 10-21), inserting before `rawText`:

```ts
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
  category: z.string().optional(),
  rawText: z.string(),
});
```

Append `categorize()` and its private regex cache/compiler at the end of the file (after `applyBalanceDiffs`):

```ts
const categoryRegexCache = new Map<string, RegExp | null>();
function getCategoryRegex(pattern: string): RegExp | null {
  if (!categoryRegexCache.has(pattern)) {
    try {
      if (NESTED_QUANTIFIER_RE.test(pattern)) {
        categoryRegexCache.set(pattern, null);
      } else {
        // 'i' for case-insensitive merchant matching, 's' for consistency with template patterns
        categoryRegexCache.set(pattern, new RegExp(pattern, 'is'));
      }
    } catch {
      categoryRegexCache.set(pattern, null);
    }
  }
  return categoryRegexCache.get(pattern)!;
}

export function categorize(transactions: Transaction[], categories: Category[]): void {
  for (const tx of transactions) {
    const text = tx.merchant ?? tx.rawText;
    let matchedName: string | undefined;
    for (const cat of categories) {
      const regex = getCategoryRegex(cat.pattern);
      if (regex && regex.test(text)) {
        matchedName = cat.name;
        break;
      }
    }
    tx.category = matchedName ?? 'uncategorized';
  }
}
```

- [ ] **Step 4: Run tests to verify `categorize()` tests pass**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: PASS for all `categorize` tests. (Pre-existing tests must still pass too.)

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: add category schema and categorize() transaction tagging"
```

- [ ] **Step 6: Write failing test for `summarize()` category grouping**

Append inside the existing `describe('summarize', ...)` block in `src/transaction-parser.test.ts` (add as a new `it` alongside the existing `'groups by month'` / `'groups by merchant'` tests):

```ts
  it('groups by category', () => {
    const categorized = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', category: 'Food', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', category: 'Transport', rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'THB', rawText: '' },
    ];
    const result = summarize(categorized, 'category');
    expect(result.by_group['Food'].debit).toBe(100);
    expect(result.by_group['Transport'].debit).toBe(200);
    expect(result.by_group['uncategorized'].debit).toBe(50);
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: FAIL — TypeScript error, `'category'` is not assignable to `summarize`'s `groupBy: 'month' | 'merchant'` parameter (or a runtime failure if TS is lenient about the string literal — either way, `result.by_group['Food']` will be `undefined` because `summarize` doesn't recognize `'category'` as a valid `groupBy`).

- [ ] **Step 8: Implement `category` groupBy support in `summarize()`**

In `src/transaction-parser.ts`, change the `summarize` function signature:

```ts
// Before
export function summarize(
  transactions: Transaction[],
  groupBy: 'month' | 'merchant',
  since?: string,
  until?: string,
): SummaryOutput {
```

```ts
// After
export function summarize(
  transactions: Transaction[],
  groupBy: 'month' | 'merchant' | 'category',
  since?: string,
  until?: string,
): SummaryOutput {
```

And change the `key` computation inside the loop:

```ts
// Before
    const key =
      groupBy === 'month'
        ? tx.date.slice(0, 7) // "YYYY-MM"
        : (tx.merchant ?? 'unknown');
```

```ts
// After
    const key =
      groupBy === 'month'
        ? tx.date.slice(0, 7) // "YYYY-MM"
        : groupBy === 'merchant'
        ? (tx.merchant ?? 'unknown')
        : (tx.category ?? 'uncategorized');
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/transaction-parser.test.ts`
Expected: PASS for the new `'groups by category'` test and all pre-existing tests.

- [ ] **Step 10: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: support grouping by category in summarize()"
```

---

### Task 2: `CategoryStore` — SQLite persistence for categories

**Files:**
- Create: `src/category-store.ts`
- Test: `src/category-store.test.ts`

**Interfaces:**
- Consumes: `Category` type from `./transaction-parser` (produced by Task 1).
- Produces:
  - `class CategoryStore { constructor(dbPath: string); upsert(category: Category): void; delete(name: string): boolean; list(): Category[]; }`

- [ ] **Step 1: Write failing tests**

Create `src/category-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CategoryStore } from './category-store';

describe('CategoryStore.list', () => {
  it('returns empty array when no categories saved', () => {
    const store = new CategoryStore(':memory:');
    expect(store.list()).toEqual([]);
  });
});

describe('CategoryStore.upsert', () => {
  it('creates a new category', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' });
    expect(store.list()).toEqual([{ name: 'Groceries', pattern: 'tesco|lotus' }]);
  });

  it('updates pattern when name already exists', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' });
    const result = store.list();
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe('tesco|lotus');
  });

  it('preserves insertion order across updates', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Transport', pattern: 'grab' });
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' }); // update, not reorder
    expect(store.list().map(c => c.name)).toEqual(['Groceries', 'Transport']);
  });
});

describe('CategoryStore.delete', () => {
  it('returns false when name not found', () => {
    const store = new CategoryStore(':memory:');
    expect(store.delete('Groceries')).toBe(false);
  });

  it('removes category and returns true', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    expect(store.delete('Groceries')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('does not affect other categories', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Transport', pattern: 'grab' });
    store.delete('Groceries');
    expect(store.list()).toEqual([{ name: 'Transport', pattern: 'grab' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/category-store.test.ts`
Expected: FAIL — cannot find module `./category-store`.

- [ ] **Step 3: Implement `CategoryStore`**

Create `src/category-store.ts`:

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Category } from './transaction-parser';

export class CategoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL UNIQUE,
        pattern TEXT NOT NULL
      );
    `);
  }

  upsert(category: Category): void {
    this.db.prepare(
      `INSERT INTO categories (name, pattern) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET pattern = excluded.pattern`,
    ).run(category.name, category.pattern);
  }

  delete(name: string): boolean {
    const info = this.db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    return info.changes > 0;
  }

  list(): Category[] {
    return this.db.prepare('SELECT name, pattern FROM categories ORDER BY id ASC').all() as Category[];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/category-store.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add src/category-store.ts src/category-store.test.ts
git commit -m "feat: add CategoryStore for SQLite-backed category persistence"
```

---

### Task 3: Wire categorization into `index.ts` (`manage_categories` tool + auto-categorization)

**Files:**
- Modify: `src/index.ts`
- Create: `docs/guide/tools/manage_categories.md`

**Interfaces:**
- Consumes:
  - `CategoryStore` class from `./category-store` (Task 2): `new CategoryStore(dbPath)`, `.upsert(category)`, `.delete(name): boolean`, `.list(): Category[]`
  - `categorize(transactions, categories): void` and `CategorySchema` from `./transaction-parser` (Task 1)
  - `cacheDbPath()` from `./data-dir` (already imported in `index.ts`)
- Produces:
  - New MCP tool `manage_categories`
  - `fetchParsedTransactions()` now returns transactions with `category` populated
  - `summarize_transactions` tool's `group_by` accepts `'category'`

- [ ] **Step 1: Add imports and `categoryStore` module state**

In `src/index.ts`, update the `transaction-parser` import (currently line 13):

```ts
// Before
import { parseTransaction, summarize, expandUntilBound, applyBalanceDiffs, TransactionTemplateSchema, Transaction } from './transaction-parser';
```

```ts
// After
import { parseTransaction, summarize, expandUntilBound, applyBalanceDiffs, categorize, TransactionTemplateSchema, CategorySchema, Transaction } from './transaction-parser';
```

Add a new import right after the `MessageCache` import (currently line 12):

```ts
import { CategoryStore } from './category-store';
```

Add a module-level variable next to `let sharedCache: MessageCache;` (currently line 33):

```ts
let sharedCache: MessageCache;
let categoryStore: CategoryStore;
```

- [ ] **Step 2: Instantiate `CategoryStore` at startup**

In `main()`, find:

```ts
  sharedCache = new MessageCache(cacheDbPath());
  startSyncLoop(sharedCache);
```

Change to:

```ts
  sharedCache = new MessageCache(cacheDbPath());
  categoryStore = new CategoryStore(cacheDbPath());
  startSyncLoop(sharedCache);
```

- [ ] **Step 3: Register the `guide-manage_categories` resource**

Add immediately after the existing `guide-manage_templates` resource registration block (after the block ending at the line containing `(_uri) => readGuideFile('docs/guide/tools/manage_templates.md', 'line://guide/tools/manage_templates'),\n);`):

```ts
server.registerResource(
  'guide-manage_categories',
  'line://guide/tools/manage_categories',
  { description: 'When to use manage_categories, pattern matching rules, global scope vs per-chat templates', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/manage_categories.md', 'line://guide/tools/manage_categories'),
);
```

- [ ] **Step 4: Register the `manage_categories` tool**

Add immediately after the `manage_templates` tool's `server.registerTool(...)` block closes (right before the `server.registerTool('sample_messages', ...)` block):

```ts
server.registerTool(
  'manage_categories',
  {
    description:
      'Create, update, delete, or list global spending categories used to automatically tag transactions. ' +
      'Categories apply across all chats — unlike templates, which are chat-specific. ' +
      "Each category has a regex `pattern` matched against a transaction's merchant (falling back to its raw message text when no merchant was captured). " +
      'Patterns are tried in the order categories were created; the first match wins. ' +
      'get_transactions and summarize_transactions apply categorization automatically — no need to call this before every use, only when adding or changing categories.',
    inputSchema: {
      action: z.enum(['upsert', 'delete', 'list']).describe(
        '"upsert" — save or replace a category by name. "delete" — remove a named category. "list" — return all saved categories in match order.'
      ),
      category: CategorySchema.optional().describe(
        'Required for action: upsert. `pattern` is a JS regex matched case-insensitively against merchant (or rawText when merchant is absent). No named capture groups needed — this is a plain match test.'
      ),
      name: z.string().optional().describe('Category name to remove (required for action: delete)'),
    },
  },
  async ({ action, category, name }) => {
    if (action === 'upsert') {
      if (!category) {
        return { content: [{ type: 'text' as const, text: 'category is required for action: upsert' }], isError: true };
      }
      try {
        categoryStore.upsert(category);
        return { content: [{ type: 'text' as const, text: `Category '${category.name}' saved.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to save category: ${(err as Error).message}` }], isError: true };
      }
    }

    if (action === 'delete') {
      if (!name) {
        return { content: [{ type: 'text' as const, text: 'name is required for action: delete' }], isError: true };
      }
      try {
        const deleted = categoryStore.delete(name);
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `No category named '${name}' found.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Category '${name}' deleted.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to delete category: ${(err as Error).message}` }], isError: true };
      }
    }

    // action === 'list'
    try {
      const categories = categoryStore.list();
      const text = categories.length === 0
        ? 'No categories saved.'
        : JSON.stringify(categories, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to list categories: ${(err as Error).message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 5: Call `categorize()` inside `fetchParsedTransactions()`**

Find, inside `fetchParsedTransactions()`:

```ts
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  applyBalanceDiffs(transactions);

  const rangeNote = since
```

Change to:

```ts
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  applyBalanceDiffs(transactions);
  categorize(transactions, categoryStore.list());

  const rangeNote = since
```

- [ ] **Step 6: Extend `summarize_transactions`'s `group_by` enum**

Find, in the `summarize_transactions` tool's `inputSchema`:

```ts
      group_by: z.enum(['month', 'merchant']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name'),
```

Change to:

```ts
      group_by: z.enum(['month', 'merchant', 'category']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name; "category" groups by assigned spending category'),
```

- [ ] **Step 7: Create the guide doc**

Create `docs/guide/tools/manage_categories.md`:

```md
# manage_categories

**When to use:** To save, update, delete, or list global spending categories used to automatically tag transactions with a `category`.

**Prerequisites:** None — unlike templates, categories are global and not tied to a specific chat.

**Next steps:** `get_transactions` and `summarize_transactions` — categorization applies automatically to every parsed transaction, and `summarize_transactions` can group totals by `category`.

**Key parameters:**
- `action`: `upsert` | `delete` | `list`
- `category.name`: unique category name, e.g. `"Groceries"`
- `category.pattern`: regex tested against the transaction's `merchant` field (falls back to the raw message text when no merchant was captured). Matched case-insensitively; no named capture groups needed.
- `name`: category name to remove (required for `delete`)

**Matching order:** Categories are tried in the order they were created (insertion order); the first pattern that matches wins. Reordering isn't supported directly — delete and re-upsert categories in the order you want if match priority matters.

**Avoid:** Don't rely on a category matching a transaction with no `merchant` and no distinguishing text in `rawText` — those fall back to `"uncategorized"`.
```

- [ ] **Step 8: Type-check and build**

Run: `npm run build`
Expected: Compiles cleanly with no TypeScript errors.

- [ ] **Step 9: Run the full unit test suite**

Run: `npm run test:unit`
Expected: All tests pass, including the new `transaction-parser.test.ts` and `category-store.test.ts` cases from Tasks 1-2.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts docs/guide/tools/manage_categories.md
git commit -m "feat: add manage_categories tool and wire auto-categorization into transaction tools"
```

---

### Task 4: Update existing documentation

**Files:**
- Modify: `docs/guide/overview.md`
- Modify: `docs/guide/tools/get_transactions.md`
- Modify: `docs/guide/tools/summarize_transactions.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing (docs-only task); reflects behavior implemented in Tasks 1-3.
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Update `docs/guide/overview.md`**

In the `## Workflow Map` table, change:

```md
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
```

to:

```md
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Categorize transactions | `manage_categories` (any time) → categorization is applied automatically inside `get_transactions` / `summarize_transactions` |
```

In `## Key Facts`, add a new bullet after the "Templates persist" bullet:

```md
- **Categories persist:** Spending categories saved with `manage_categories` are stored globally in `data/cache/messages.db` (not per-chat) and applied automatically to every transaction returned by `get_transactions` and `summarize_transactions`.
```

In `## Per-Tool Guides`, add a new line after `- line://guide/tools/manage_templates`:

```md
- `line://guide/tools/manage_categories`
```

- [ ] **Step 2: Update `docs/guide/tools/get_transactions.md`**

Replace the file contents with:

```md
# get_transactions

**When to use:** To extract structured transaction records from bank notification messages in a LINE chat.

**Prerequisites:** `manage_templates` must have been called at least once to save templates for this chat. Templates load automatically — no need to pass them on each call.

**Next steps:** `summarize_transactions` to aggregate totals by month, merchant, or category.

**Key parameters:**
- `chatMid`: the chat MID from `list_chats`
- `since` (ISO date string, e.g. `"2026-05-01"`): **always pass this** for complete history over a date range. Without `since`, only the latest 200 messages are scanned and a note is appended recommending `since` for accuracy.
- `until` (ISO date string): optional end bound; defaults to now

**Categorization:** Every returned transaction includes a `category` field — automatically assigned from saved categories (see `manage_categories`), or `"uncategorized"` when no category pattern matches. Categories are global, not per-chat.

**Avoid:** Don't call without `since` if you need complete monthly data — you will get incomplete results. Don't pass inline `templates` unless testing a new pattern; saved templates are already loaded automatically and apply `valid_from`/`valid_until` filtering per message — note that inline `templates` calls also skip categorization, since only the saved-templates path assigns `category`.
```

- [ ] **Step 3: Update `docs/guide/tools/summarize_transactions.md`**

Replace the file contents with:

```md
# summarize_transactions

**When to use:** To aggregate parsed transaction data into totals grouped by month, merchant, or category.

**Prerequisites:** `get_transactions` — this tool operates on the same parsed data pipeline. For category grouping, set up categories first via `manage_categories`.

**Next steps:** None — this is the final step in the transaction workflow.

**Key parameters:**
- `chatMid`: the chat MID
- `group_by`: `month` | `merchant` | `category`
- `since` / `until`: filter the aggregation window (ISO date strings)

**Avoid:** Don't call before `get_transactions` has run with a `since` range covering the period you want to summarize — the result will be incomplete. When grouping by `category`, transactions with no matching category are grouped under `"uncategorized"`.
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the `index.ts` bullet (starts `**\`index.ts\`** — entry point.`), change:

```md
Creates an Express app, registers nine tools (`list_chats`, `get_messages`, `get_image`, `sample_messages`, `manage_templates`, `get_transactions`, `summarize_transactions`, `initiate_import`, `complete_import`) on an `McpServer`, mounts OAuth routes from `oauth.ts`, and serves `POST /mcp` protected by bearer-token validation. Uses `AsyncLocalStorage` to pass the per-request `AuthData` into tool handlers without threading it through parameters. When `TEST_TOKEN` + `LINE_AUTH_DATA` env vars are both set, pre-seeds the token bypass so e2e tests skip the OAuth flow. Initialises `MessageCache` once at startup (`sharedCache`) and creates a `CachingLineClient` per request via `makeLineClient()`, which wires the `onTokenRefreshed` callback to update `latestAuthData` in `oauth.ts`.
```

to:

```md
Creates an Express app, registers ten tools (`list_chats`, `get_messages`, `get_image`, `sample_messages`, `manage_templates`, `manage_categories`, `get_transactions`, `summarize_transactions`, `initiate_import`, `complete_import`) on an `McpServer`, mounts OAuth routes from `oauth.ts`, and serves `POST /mcp` protected by bearer-token validation. Uses `AsyncLocalStorage` to pass the per-request `AuthData` into tool handlers without threading it through parameters. When `TEST_TOKEN` + `LINE_AUTH_DATA` env vars are both set, pre-seeds the token bypass so e2e tests skip the OAuth flow. Initialises `MessageCache` once at startup (`sharedCache`) and `CategoryStore` (`categoryStore`), which share the same SQLite file, and creates a `CachingLineClient` per request via `makeLineClient()`, which wires the `onTokenRefreshed` callback to update `latestAuthData` in `oauth.ts`.
```

Add a new bullet after the `manage_templates` bullet:

```md
- `manage_categories` — CRUD for global spending categories; delegates to `category-store.ts`. Actions: `upsert`, `delete`, `list`. Categories are not scoped per chat, unlike templates.
```

Change the `get_transactions` bullet's ending — find:

```md
After parsing, calls `applyBalanceDiffs()` to populate the `amount` and `currency` fields from consecutive balance diffs for transactions that did not capture them explicitly. Returns a zero-match hint when saved templates exist but nothing matched.
```

to:

```md
After parsing, calls `applyBalanceDiffs()` to populate the `amount` and `currency` fields from consecutive balance diffs for transactions that did not capture them explicitly, then calls `categorize()` to stamp each transaction's `category` field from saved categories (first pattern match against `merchant`/`rawText` wins; `"uncategorized"` when none match). Returns a zero-match hint when saved templates exist but nothing matched.
```

Change the `### MCP Resources (`docs/guide/`)` section's opening line:

```md
Ten static markdown resources are registered in `index.ts` via `server.registerResource()` and served over the MCP protocol:
```

to:

```md
Eleven static markdown resources are registered in `index.ts` via `server.registerResource()` and served over the MCP protocol:
```

Add a new bullet after the `template-store.ts` bullet block (before the `transaction-parser.ts` bullet):

```md
**`category-store.ts`** — SQLite-backed persistence for global spending categories, sharing the same database file as `message-cache.ts` (`data/cache/messages.db`) via a separate `categories` table (`id`, `name` UNIQUE, `pattern`). Exports the `CategoryStore` class: `upsert(category)` (insert or update-in-place by `name`, preserving row order), `delete(name)` → `boolean`, `list()` → `Category[]` in insertion order.
```

Change the `transaction-parser.ts` bullet's ending — find:

```md
No LINE API calls; used directly by the `get_transactions` and `summarize_transactions` tool handlers in `index.ts`. The `'s'` (dotAll) flag is applied to all patterns so `.` matches newlines in bilingual messages (e.g. UOB Thai + English in one blob).
```

to:

```md
No LINE API calls; used directly by the `get_transactions` and `summarize_transactions` tool handlers in `index.ts`. The `'s'` (dotAll) flag is applied to all patterns so `.` matches newlines in bilingual messages (e.g. UOB Thai + English in one blob). Also exports `CategorySchema`/`Category` and `categorize(transactions, categories)`, which stamps each transaction's `category` field by testing each category's regex (case-insensitive, dotAll) against `merchant` (falling back to `rawText`); first match wins, unmatched transactions get `"uncategorized"`. `summarize`'s `groupBy` parameter also accepts `'category'`.
```

- [ ] **Step 5: Run lint and full unit test suite one more time**

Run: `npm run lint && npm run build && npm run test:unit`
Expected: All pass — lint clean, build succeeds, all unit tests green.

- [ ] **Step 6: Commit**

```bash
git add docs/guide/overview.md docs/guide/tools/get_transactions.md docs/guide/tools/summarize_transactions.md CLAUDE.md
git commit -m "docs: document automated transaction categorization"
```

---

## Self-Review Notes

- **Spec coverage:** Global category scope (Task 2/3, no `chatMid`), rawText fallback + first-match-wins + case-insensitivity (Task 1), new `manage_categories` tool (Task 3), `category` on `get_transactions` output (Task 3 Step 5), `summarize_transactions` `group_by: 'category'` (Task 1 Step 8, Task 3 Step 6), SQLite storage sharing `messages.db` (Task 2), guide doc + `CLAUDE.md` maintenance rule (Task 3 Step 3/7, Task 4) — all covered.
- **Type consistency:** `Category` (`name`, `pattern`) is identical across Task 1 (`transaction-parser.ts`), Task 2 (`category-store.ts` consumes it), and Task 3 (`index.ts` uses `CategorySchema` for tool input, `categoryStore.list()` return type feeds `categorize()`). `categorize(transactions: Transaction[], categories: Category[]): void` signature matches its Task 1 definition and Task 3 call site.
- **No placeholders:** every step has literal code; no "add error handling" or "similar to Task N" placeholders.
