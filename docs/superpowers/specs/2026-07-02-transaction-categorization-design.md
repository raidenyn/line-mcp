# Automated Transaction Categorization

**Date:** 2026-07-02
**Status:** Approved

## Overview

Transactions parsed from LINE bank messages currently have no notion of spending category. This adds global, regex-matched categories (e.g. "Groceries", "Transport") that are automatically assigned to every transaction, CRUD-managed via a new MCP tool, and usable as a grouping dimension in `summarize_transactions`.

## Scope decisions

- **Global, not per-chat.** Categories describe spending habits, not bank message formats, so one shared list applies across all chats — unlike templates, which are inherently chat-specific (they parse a particular bank's message format).
- **No time-bounding.** Templates have `valid_from`/`valid_until` because bank message formats change over time. Categories have no such driver; this field is omitted from the category schema.
- **Storage: SQLite, not JSON file.** A new `categories` table is added to the existing `data/cache/messages.db` (the same file `MessageCache` already uses), via a new `CategoryStore` class. This keeps categories out of the per-chat JSON template files (which would be the wrong scope anyway) without introducing a second SQLite database file.

## Data model

New `Category` schema in `src/transaction-parser.ts`, alongside `TransactionTemplateSchema`:

```ts
export const CategorySchema = z.object({
  name: z.string().min(1).describe('Unique category name, e.g. "Groceries"'),
  pattern: z.string().describe('JS regex tested against merchant (falls back to rawText if merchant is absent). Compiled case-insensitively.'),
});
export type Category = z.infer<typeof CategorySchema>;
```

`Transaction` gains one optional field, following the same pattern as `amount`/`currency` (populated by a post-processing pass, not by `parseTransaction` itself):

```ts
category: z.string().optional(), // set by categorize(); a category name, or "uncategorized". Absent when categorize() was not run (see inline-templates path below).
```

## Storage: `src/category-store.ts`

New module, function-per-operation like `template-store.ts` but SQL-backed:

```ts
export class CategoryStore {
  constructor(dbPath: string) { ... }   // opens the same messages.db path
  upsert(category: Category): void;     // INSERT ... ON CONFLICT(name) DO UPDATE — preserves row id/order
  delete(name: string): boolean;
  list(): Category[];                   // ordered by id (insertion order)
}
```

Table (created via `CREATE TABLE IF NOT EXISTS` in the constructor, same pattern as `MessageCache`):

```sql
CREATE TABLE IF NOT EXISTS categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL
);
```

`upsert` on an existing `name` updates in place (`ON CONFLICT(name) DO UPDATE SET pattern = excluded.pattern`) rather than delete+insert, so `id` — and therefore position in `list()`'s insertion order — is stable across edits, matching `upsertTemplate`'s in-place replace semantics.

`CategoryStore` is constructed once in `index.ts` alongside `sharedCache`, pointed at the same `cacheDbPath()`.

## Matching logic

New function in `src/transaction-parser.ts`, parallel to `applyBalanceDiffs`:

```ts
export function categorize(transactions: Transaction[], categories: Category[]): void
```

For each transaction, in category list order, compile `pattern` with the `i` flag (case-insensitive) reusing the existing `getRegex`-style cache and `NESTED_QUANTIFIER_RE` ReDoS guard already used for templates. A category matches if the compiled regex tests true against `tx.merchant ?? tx.rawText`. First match wins; sets `tx.category = name`. No match sets `tx.category = 'uncategorized'`.

Bad/dangerous patterns are silently treated as never-matching (same behavior as templates via `getRegex` returning `null`) — no validation at upsert time.

## `manage_categories` MCP tool

New tool in `src/index.ts`, same action shape as `manage_templates` but without `chatMid` (categories are global):

```ts
inputSchema: {
  action: z.enum(['upsert', 'delete', 'list']),
  category: CategorySchema.optional(),  // required for upsert
  name: z.string().optional(),          // required for delete
}
```

- `upsert` → `categoryStore.upsert(category)`, confirmation text.
- `delete` → `categoryStore.delete(name)`, confirmation or "not found" error.
- `list` → `categoryStore.list()`, JSON or "no categories saved" text.

## Integration with `get_transactions` / `summarize_transactions`

`fetchParsedTransactions()` in `index.ts` — the shared helper both tools already call — gets one new step, after `applyBalanceDiffs(transactions)`:

```ts
categorize(transactions, categoryStore.list());
```

Effects:

- **`get_transactions`** (saved-templates path): every transaction in the JSON output now includes `"category"` (guaranteed present — `categorize()` always sets it, defaulting to `"uncategorized"`).
- **`get_transactions`** (inline-templates path, where the caller supplies `templates` directly): **not** categorized. This path bypasses `fetchParsedTransactions()` and is meant for ad-hoc template testing, consistent with it also skipping saved aliases today.
- **`summarize_transactions`**: `group_by` extends to `z.enum(['month', 'merchant', 'category'])`. `summarize()` in `transaction-parser.ts` gets `category` as a third valid `groupBy` key selector — `tx.category ?? 'uncategorized'` (the `?? 'uncategorized'` fallback mirrors the existing `tx.merchant ?? 'unknown'` pattern for the `merchant` groupBy, and only matters if `summarize()` is called directly with transactions that were never run through `categorize()`, since the production path always categorizes first).

## Error handling

- No categories saved → every transaction is `'uncategorized'`; not an error (categorization degrades gracefully, unlike the "no templates" case which blocks `get_transactions` entirely).
- Invalid regex pattern on upsert → accepted and stored; never matches at parse time (matches template behavior — no upsert-time validation).
- Duplicate `name` on upsert → always an update via `ON CONFLICT`, never an error.

## Documentation

Per `CLAUDE.md`'s maintenance rule:

- Add `docs/guide/tools/manage_categories.md` + `registerResource` call in `index.ts`.
- Update `docs/guide/tools/get_transactions.md` and `summarize_transactions.md` to mention the `category` field / `group_by` option.
- Update `CLAUDE.md`'s Architecture section: new `category-store.ts` entry, `manage_categories` added to the tool list, `fetchParsedTransactions` description updated, guide resource table updated.

## Testing

- `src/category-store.test.ts` (new): upsert/delete/list, order preservation across updates, unique-name constraint behavior.
- `src/transaction-parser.test.ts`: `categorize()` — merchant match, rawText fallback when merchant absent, first-match-wins across multiple candidates, `'uncategorized'` fallback, case-insensitivity; `summarize()` with `group_by: 'category'`.
- No e2e test changes: the e2e suite exercises live LINE data (chats, messages), and `manage_templates` — the closest existing analog — has no e2e coverage of its own CRUD actions either. Unit tests are sufficient for `manage_categories`.

## Files changed

| File | Change |
|------|--------|
| `src/transaction-parser.ts` | `CategorySchema`/`Category` types, `category` field on `Transaction`, new `categorize()` function, `summarize()` gains `category` groupBy key |
| `src/category-store.ts` | New file — `CategoryStore` class |
| `src/index.ts` | New `manage_categories` tool, `categoryStore` instance, `categorize()` call in `fetchParsedTransactions()`, `group_by` enum extended, new guide resource registration |
| `src/category-store.test.ts` | New file — unit tests |
| `src/transaction-parser.test.ts` | New tests for `categorize()` and `summarize()` category grouping |
| `docs/guide/tools/manage_categories.md` | New file |
| `docs/guide/tools/get_transactions.md`, `summarize_transactions.md` | Updated to mention categorization |
| `CLAUDE.md` | Architecture section updated per maintenance rule |
