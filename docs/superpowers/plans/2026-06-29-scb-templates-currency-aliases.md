# SCB Connect Templates + Per-Chat Currency Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-chat currency alias support to the template system, then create 8 SCB Connect transaction templates that use it to produce consistent `THB` currency codes.

**Architecture:** Aliases are stored alongside templates in `data/templates/<chatMid>.json`. `parseTransaction` accepts an optional aliases map and applies it after extracting `original_currency`. The `manage_templates` MCP tool gains three new actions (`upsert_alias`, `delete_alias`, `list_aliases`). The SCB Connect template file is created directly on disk.

**Tech Stack:** TypeScript, Vitest, Node.js built-ins (`fs`, `path`), Zod.

## Global Constraints

- All tests run via `npx vitest run <file>` — never use `npm test` alone (requires `.line-auth.json`)
- Unit test files live in `src/` next to the module they test
- `storeDir` optional parameter on all store functions defaults to `templatesDir()` — always pass an explicit temp dir in tests
- No new dependencies — use only what's already in `package.json`
- Commits must include all changed files for that task, nothing more

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/transaction-parser.ts` | Modify | Accept `aliases` param; normalise `original_currency` on extraction |
| `src/transaction-parser.test.ts` | Modify | Tests for alias normalisation |
| `src/template-store.ts` | Modify | Fix `writeTemplates` to preserve aliases; extend `loadTemplates` return; add `upsertAlias`, `deleteAlias`, `listAliases` |
| `src/template-store.test.ts` | Modify | Tests for all three alias functions + alias preservation |
| `src/index.ts` | Modify | Pass aliases to `parseTransaction` in `fetchParsedTransactions`; add 3 actions to `manage_templates` handler |
| `data/templates/<scb-mid>.json` | Create | 8 SCB Connect templates + 2 currency aliases |
| `docs/guide/tools/manage_templates.md` | Modify | Document 3 new actions |

---

## Task 1: Add `aliases` param to `parseTransaction`

**Files:**
- Modify: `src/transaction-parser.ts`
- Modify: `src/transaction-parser.test.ts`

**Interfaces:**
- Produces: `parseTransaction(message, templates, aliases?)` where `aliases: Record<string, string> = {}`

- [ ] **Step 1: Write failing tests**

Add to the bottom of `src/transaction-parser.test.ts`:

```typescript
describe('parseTransaction currency aliases', () => {
  const SCB_MSG = {
    id: 'scb1',
    createdTime: '1749999600000',
    contentType: 0,
    text: '[รายการเงินออก 100.00 บาท จากบัญชี X-1139 วันที่ 15/06/2025 @10:00 ยอดเงินที่ใช้ได้ 1000.00 บาท]',
  };
  const SCB_TEMPLATE: TransactionTemplate[] = [{
    pattern: '\\[รายการเงินออก\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+จากบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\s+ยอดเงินที่ใช้ได้\\s+(?<balance>[\\d,]+\\.?\\d*)\\s+บาท\\]',
    amount_sign: 'debit',
    date_format: 'DD/MM/YYYY',
  }];

  it('normalises original_currency via aliases', () => {
    const tx = parseTransaction(SCB_MSG, SCB_TEMPLATE, { 'บาท': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('THB');
  });

  it('passes through unrecognised currency unchanged', () => {
    const tx = parseTransaction(SCB_MSG, SCB_TEMPLATE, { 'บ': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('บาท');
  });

  it('applies no aliases when aliases param is omitted', () => {
    const tx = parseTransaction(SCB_MSG, SCB_TEMPLATE);
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('บาท');
  });

  it('aliases empty string aliases map leaves currency unchanged', () => {
    const tx = parseTransaction(SCB_MSG, SCB_TEMPLATE, {});
    expect(tx!.original_currency).toBe('บาท');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: 4 new tests fail with "Expected number of arguments" or type errors.

- [ ] **Step 3: Implement the change**

In `src/transaction-parser.ts`, change the `parseTransaction` signature and the line that sets `original_currency`:

```typescript
// Change signature from:
export function parseTransaction(
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
): Transaction | null {

// To:
export function parseTransaction(
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
  aliases: Record<string, string> = {},
): Transaction | null {
```

Inside the function, find the line that builds the `tx` object and change `original_currency`:

```typescript
// Change from:
    const tx: Transaction = {
      id: message.id,
      date: parseDate(g.date, tmpl.date_format, message.createdTime),
      original_amount,
      original_currency: g.original_currency.trim(),
      rawText: message.text,
    };

// To:
    const rawCurrency = g.original_currency.trim();
    const tx: Transaction = {
      id: message.id,
      date: parseDate(g.date, tmpl.date_format, message.createdTime),
      original_amount,
      original_currency: aliases[rawCurrency] ?? rawCurrency,
      rawText: message.text,
    };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: All tests pass including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: add optional aliases param to parseTransaction for currency normalisation"
```

---

## Task 2: Add alias functions to `template-store.ts`

**Files:**
- Modify: `src/template-store.ts`
- Modify: `src/template-store.test.ts`

**Interfaces:**
- Consumes: `loadTemplates` (from Task 1 context — no change needed, but return type expands)
- Produces:
  - `loadTemplates(chatMid, storeDir?)` → `{ templates: NamedTemplate[]; warning?: string; currency_aliases: Record<string, string> }`
  - `upsertAlias(chatMid, alias, canonical, storeDir?): void`
  - `deleteAlias(chatMid, alias, storeDir?): boolean`
  - `listAliases(chatMid, storeDir?): Record<string, string>`

- [ ] **Step 1: Write failing tests**

Add to the bottom of `src/template-store.test.ts`. First update the imports:

```typescript
import {
  loadTemplates,
  upsertTemplate,
  deleteTemplate,
  listTemplates,
  filterByTime,
  upsertAlias,
  deleteAlias,
  listAliases,
  NamedTemplate,
} from './template-store';
```

Then add these test blocks at the bottom:

```typescript
describe('loadTemplates currency_aliases', () => {
  it('returns empty object when key absent', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    expect(loadTemplates('mid123', dir).currency_aliases).toEqual({});
  });

  it('returns aliases stored in file', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({ templates: [], currency_aliases: { 'บาท': 'THB' } }),
    );
    expect(loadTemplates('mid123', dir).currency_aliases).toEqual({ 'บาท': 'THB' });
  });
});

describe('upsertAlias', () => {
  it('creates alias and persists to file', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });

  it('replaces existing alias with same key', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บาท', 'BAHT', dir);
    expect(listAliases('mid123', dir)['บาท']).toBe('BAHT');
  });

  it('does not erase existing templates', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertAlias('mid123', 'บาท', 'THB', dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });
});

describe('deleteAlias', () => {
  it('returns false when alias not found', () => {
    expect(deleteAlias('mid123', 'บาท', dir)).toBe(false);
  });

  it('removes alias and returns true', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บ', 'THB', dir);
    expect(deleteAlias('mid123', 'บาท', dir)).toBe(true);
    expect(listAliases('mid123', dir)).toEqual({ 'บ': 'THB' });
  });

  it('does not erase existing templates', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertAlias('mid123', 'บาท', 'THB', dir);
    deleteAlias('mid123', 'บาท', dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });
});

describe('listAliases', () => {
  it('returns empty object when no aliases saved', () => {
    expect(listAliases('mid123', dir)).toEqual({});
  });

  it('returns all aliases', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บ', 'THB', dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB', 'บ': 'THB' });
  });
});

describe('upsertTemplate preserves aliases', () => {
  it('does not erase aliases when templates are updated', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertTemplate('mid123', TMPL_A, dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });
});

describe('deleteTemplate preserves aliases', () => {
  it('does not erase aliases when a template is removed', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertTemplate('mid123', TMPL_A, dir);
    deleteTemplate('mid123', TMPL_A.name, dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });
});

describe('migration preserves currency_aliases', () => {
  it('keeps aliases intact after pattern migration and rewrites file with them', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [{ name: 'old', pattern: 'pay (?<currency>\\w+) (?<amount>[\\d.]+)' }],
        currency_aliases: { 'บาท': 'THB' },
      }),
    );
    const result = loadTemplates('mid123', dir);
    expect(result.currency_aliases).toEqual({ 'บาท': 'THB' });
    const file = JSON.parse(readFileSync(join(dir, 'mid123.json'), 'utf8'));
    expect(file.currency_aliases).toEqual({ 'บาท': 'THB' });
  });
});
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
npx vitest run src/template-store.test.ts
```

Expected: New tests fail (functions not exported), existing tests still pass.

- [ ] **Step 3: Implement changes in `template-store.ts`**

**3a.** Update `loadTemplates` return type and body to read `currency_aliases`:

```typescript
// Change return type annotation:
export function loadTemplates(
  chatMid: string,
  storeDir = templatesDir(),
): { templates: NamedTemplate[]; warning?: string; currency_aliases: Record<string, string> } {
  const path = safeFilePath(chatMid, storeDir);
  if (!existsSync(path)) return { templates: [], currency_aliases: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const rawAliases: Record<string, string> = raw.currency_aliases ?? {};
    const rawTemplates: NamedTemplate[] = raw.templates ?? [];
    const migrated = rawTemplates.map((t) => {
      const newPattern = t.pattern
        .replace(/\(\?<amount>/g, '(?<original_amount>')
        .replace(/\(\?<currency>/g, '(?<original_currency>');
      return newPattern === t.pattern ? t : { ...t, pattern: newPattern };
    });
    if (migrated.some((t, i) => t !== rawTemplates[i])) {
      writeFileSync(path, JSON.stringify({ templates: migrated, currency_aliases: rawAliases }, null, 2));
      process.stderr.write(
        `[LINE] Migrated template patterns for chat ${chatMid}: renamed (?<amount>→(?<original_amount>), (?<currency>→(?<original_currency>)\n`,
      );
    }
    return { templates: migrated, currency_aliases: rawAliases };
  } catch {
    return { templates: [], warning: `Template file for ${chatMid} is corrupt or unreadable — returning empty list.`, currency_aliases: {} };
  }
}
```

**3b.** Update `writeTemplates` private function to accept and persist aliases:

```typescript
function writeTemplates(chatMid: string, templates: NamedTemplate[], aliases: Record<string, string>, storeDir: string): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(safeFilePath(chatMid, storeDir), JSON.stringify({ templates, currency_aliases: aliases }, null, 2));
}
```

**3c.** Update `upsertTemplate` and `deleteTemplate` to pass aliases through:

```typescript
export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir = templatesDir()): void {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
}

export function deleteTemplate(chatMid: string, name: string, storeDir = templatesDir()): boolean {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  templates.splice(idx, 1);
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
  return true;
}
```

**3d.** Add the three new exported alias functions at the bottom of the file, before `filterByTime`:

```typescript
export function upsertAlias(
  chatMid: string,
  alias: string,
  canonical: string,
  storeDir = templatesDir(),
): void {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  currency_aliases[alias] = canonical;
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
}

export function deleteAlias(
  chatMid: string,
  alias: string,
  storeDir = templatesDir(),
): boolean {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  if (!(alias in currency_aliases)) return false;
  delete currency_aliases[alias];
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
  return true;
}

export function listAliases(
  chatMid: string,
  storeDir = templatesDir(),
): Record<string, string> {
  return loadTemplates(chatMid, storeDir).currency_aliases;
}
```

- [ ] **Step 4: Run all template-store tests**

```bash
npx vitest run src/template-store.test.ts
```

Expected: All tests pass including all new ones.

- [ ] **Step 5: Commit**

```bash
git add src/template-store.ts src/template-store.test.ts
git commit -m "feat: add per-chat currency aliases to template store"
```

---

## Task 3: Wire aliases in `index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes:
  - `loadTemplates` → `{ templates, warning?, currency_aliases }` (from Task 2)
  - `parseTransaction(msg, templates, aliases)` (from Task 1)
  - `upsertAlias(chatMid, alias, canonical)`, `deleteAlias(chatMid, alias)`, `listAliases(chatMid)` (from Task 2)

- [ ] **Step 1: Update import line**

Find the existing import at the top of `src/index.ts`:

```typescript
import { upsertTemplate, deleteTemplate, listTemplates, filterByTime, loadTemplates, NamedTemplateSchema } from './template-store';
```

Change to:

```typescript
import { upsertTemplate, deleteTemplate, listTemplates, filterByTime, loadTemplates, upsertAlias, deleteAlias, listAliases, NamedTemplateSchema } from './template-store';
```

- [ ] **Step 2: Pass aliases in `fetchParsedTransactions`**

Find the `fetchParsedTransactions` function. It currently has:

```typescript
  const loaded = loadTemplates(chatMid);
  if (loaded.warning) warnings.push(loaded.warning);
  const savedTemplates = loaded.templates;
```

And further down:

```typescript
      return parseTransaction(msg, templatesForMsg);
```

Change both:

```typescript
  const loaded = loadTemplates(chatMid);
  if (loaded.warning) warnings.push(loaded.warning);
  const savedTemplates = loaded.templates;
  const savedAliases = loaded.currency_aliases;
```

```typescript
      return parseTransaction(msg, templatesForMsg, savedAliases);
```

- [ ] **Step 3: Extend `manage_templates` input schema**

Find the `manage_templates` `inputSchema` object. It currently has:

```typescript
      action: z.enum(['upsert', 'delete', 'list']).describe(
        '"upsert" — save or replace a template by name. ' +
        '"delete" — remove a named template. ' +
        '"list" — return all saved templates for this chat (full objects, in insertion order).'
      ),
```

And:

```typescript
      name: z.string().optional().describe('Template name to remove (required for action: delete)'),
```

Change `action` to include the three new values:

```typescript
      action: z.enum(['upsert', 'delete', 'list', 'upsert_alias', 'delete_alias', 'list_aliases']).describe(
        '"upsert" — save or replace a template by name. ' +
        '"delete" — remove a named template. ' +
        '"list" — return all saved templates for this chat (full objects, in insertion order). ' +
        '"upsert_alias" — save or replace a currency alias (e.g. alias: "บาท", canonical: "THB"). ' +
        '"delete_alias" — remove a currency alias by its alias string. ' +
        '"list_aliases" — return all currency aliases for this chat.'
      ),
```

After the `name` field, add two new optional fields:

```typescript
      alias: z.string().optional().describe('Currency string captured by regex (required for upsert_alias and delete_alias)'),
      canonical: z.string().optional().describe('Canonical currency code to normalise to, e.g. "THB" (required for upsert_alias)'),
```

- [ ] **Step 4: Add the three new action handlers**

Find the handler function signature: `async ({ chatMid, action, template, name }) => {`

Change to: `async ({ chatMid, action, template, name, alias, canonical }) => {`

Then find the `// action === 'list'` block and insert before it:

```typescript
    if (action === 'upsert_alias') {
      if (!alias || !canonical) {
        return { content: [{ type: 'text' as const, text: 'alias and canonical are required for action: upsert_alias' }], isError: true };
      }
      try {
        upsertAlias(chatMid, alias, canonical);
        return { content: [{ type: 'text' as const, text: `Alias '${alias}' → '${canonical}' saved for chat ${chatMid}.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to save alias: ${(err as Error).message}` }], isError: true };
      }
    }

    if (action === 'delete_alias') {
      if (!alias) {
        return { content: [{ type: 'text' as const, text: 'alias is required for action: delete_alias' }], isError: true };
      }
      try {
        const deleted = deleteAlias(chatMid, alias);
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `No alias '${alias}' found for this chat.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Alias '${alias}' deleted from chat ${chatMid}.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to delete alias: ${(err as Error).message}` }], isError: true };
      }
    }

    if (action === 'list_aliases') {
      try {
        const aliases = listAliases(chatMid);
        const text = Object.keys(aliases).length === 0
          ? `No currency aliases saved for chat ${chatMid}.`
          : JSON.stringify(aliases, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to list aliases: ${(err as Error).message}` }], isError: true };
      }
    }
```

- [ ] **Step 5: Build to confirm no TypeScript errors**

```bash
npm run build
```

Expected: `dist/` updated with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire currency aliases into manage_templates tool and fetchParsedTransactions"
```

---

## Task 4: Create SCB Connect template file and update guide

**Files:**
- Create: `data/templates/<scb-mid>.json`
- Modify: `docs/guide/tools/manage_templates.md`

- [ ] **Step 1: Find the SCB Connect chatMid**

```bash
sqlite3 data/cache/messages.db "SELECT DISTINCT chat_mid FROM messages LIMIT 20"
```

Look for the chatMid whose messages match SCB Connect — you can cross-reference with:

```bash
sqlite3 data/cache/messages.db "SELECT chat_mid, raw_json FROM messages LIMIT 5" | grep -i "รายการเงิน"
```

The `chat_mid` value from that query is `<scb-mid>`. Use it in the next step.

- [ ] **Step 2: Create the template file**

Replace `<scb-mid>` with the actual chatMid found above and create the file:

```bash
cat > data/templates/<scb-mid>.json << 'JSONEOF'
{
  "templates": [
    {
      "name": "scb-credit-labeled",
      "pattern": "\\[รายการเงินเข้า:\\s+(?<merchant>.+?)\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+เข้าบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\]",
      "amount_sign": "credit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-credit-standard",
      "pattern": "\\[รายการเงินเข้า\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+เข้าบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\s+ยอดเงินที่ใช้ได้\\s+(?<balance>[\\d,]+\\.?\\d*)\\s+บาท\\]",
      "amount_sign": "credit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-atm-withdrawal",
      "pattern": "\\[รายการเงินออก\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+ด้วยบัตรเดบิต\\s+\\S+\\s+จากบัญชี\\s+(?<account>\\S+)\\s+ผ่านตู้\\s+(?<merchant>.+?)\\s+ATM\\s+ค่าธรรมเนียม\\s+[\\d,]+\\.?\\d*\\s+บาท\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\]",
      "amount_sign": "debit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-debit-standard",
      "pattern": "\\[รายการเงินออก\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+จากบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\s+ยอดเงินที่ใช้ได้\\s+(?<balance>[\\d,]+\\.?\\d*)\\s+บาท\\]",
      "amount_sign": "debit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-card-payment",
      "pattern": "\\[ชำระเงิน\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+ด้วยบัตรเดบิต\\s+\\S+\\s+จากบัญชี\\s+(?<account>\\S+)\\s+@(?<merchant>.+?)\\s+ค่าธรรมเนียม\\s+[\\d,]+\\.?\\d*\\s+บาท\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\]",
      "amount_sign": "debit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-tax-deduction",
      "pattern": "\\[หักภาษีเงินได้\\s+(?<merchant>.+?)\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+จากบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\]",
      "amount_sign": "debit",
      "date_format": "DD/MM/YYYY"
    },
    {
      "name": "scb-salary-sms",
      "pattern": "เงินโอน/เงินเดือน\\s+(?<original_amount>[\\d,]+\\.?\\d*)(?<original_currency>บ)\\s+เข้าบ/ชx(?<account>\\d+)\\s+(?<date>\\d{2}/\\d{2})@\\d{2}:\\d{2}",
      "amount_sign": "credit",
      "date_format": "DD/MM"
    },
    {
      "name": "scb-fee-sms",
      "pattern": "หัก(?:ค่าธรรมเนียมอัตโนมัติ|เงินอัตโนมัติ)\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บ)\\.\\s+(?:จาก\\s+)?บ/ช\\s+x(?<account>\\d+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2})\\s+เวลา\\s+\\d{2}:\\d{2}",
      "amount_sign": "debit",
      "date_format": "DD/MM"
    }
  ],
  "currency_aliases": {
    "บาท": "THB",
    "บ": "THB"
  }
}
JSONEOF
```

- [ ] **Step 3: Verify the JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('data/templates/<scb-mid>.json', 'utf8')); console.log('valid')"
```

Expected: `valid`

- [ ] **Step 4: Update the guide**

Replace the full contents of `docs/guide/tools/manage_templates.md` with:

```markdown
# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat. Also to manage currency aliases that normalise captured currency strings (e.g. `"บาท"` → `"THB"`).

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern.

**Next steps:** `get_transactions` — saved templates and aliases load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list` | `upsert_alias` | `delete_alias` | `list_aliases`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones
- `alias`: the raw currency string captured by the regex (required for `upsert_alias` and `delete_alias`)
- `canonical`: the normalised currency code to map to, e.g. `"THB"` (required for `upsert_alias`)

**Currency aliases:** When a template captures a non-standard currency string (e.g. Thai `"บาท"` or abbreviated `"บ"`), use `upsert_alias` to map it to a standard code. Aliases are applied at parse time so `get_transactions` and `summarize_transactions` always return the canonical code.

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
```

- [ ] **Step 5: Run unit tests to confirm nothing regressed**

```bash
npx vitest run src/template-store.test.ts src/transaction-parser.test.ts
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add data/templates/<scb-mid>.json docs/guide/tools/manage_templates.md
git commit -m "feat: add SCB Connect transaction templates with THB currency aliases"
```

---

## Self-Review

**Spec coverage:**
- ✅ `parseTransaction` gains `aliases` param — Task 1
- ✅ `loadTemplates` returns `currency_aliases` — Task 2
- ✅ `writeTemplates` updated to preserve `currency_aliases` — Task 2
- ✅ Migration write preserves `currency_aliases` — Task 2 step 3a
- ✅ `upsertAlias`, `deleteAlias`, `listAliases` exported — Task 2 step 3d
- ✅ `upsertTemplate` / `deleteTemplate` pass aliases through — Task 2 step 3c
- ✅ `fetchParsedTransactions` loads and passes aliases — Task 3 step 2
- ✅ `manage_templates` tool gains 3 new actions — Task 3 steps 3–4
- ✅ 8 SCB Connect templates created — Task 4 step 2
- ✅ 2 currency aliases (`บาท`→THB, `บ`→THB) in template file — Task 4 step 2
- ✅ Guide updated — Task 4 step 4

**Type consistency:**
- `loadTemplates` return type matches across Task 2 (definition) and Task 3 (consumption): `{ templates, warning?, currency_aliases }`
- `writeTemplates` private signature updated in all callers (`upsertTemplate`, `deleteTemplate`, `upsertAlias`, `deleteAlias`) in Task 2
- `parseTransaction(msg, templates, aliases)` defined in Task 1, consumed in Task 3
