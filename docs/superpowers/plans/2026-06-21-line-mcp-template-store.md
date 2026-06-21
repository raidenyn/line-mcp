# LINE MCP Template Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side template persistence and two new MCP tools (`sample_messages`, `manage_templates`) so Claude can derive, save, and reuse transaction regex patterns across sessions without any external skill loaded.

**Architecture:** A new `src/template-store.ts` module handles all file I/O against `.line-templates/<chatMid>.json`. Two new tools are registered in `src/index.ts`; `get_transactions` is modified to auto-load saved templates when none are supplied. All regex guidance is embedded in tool/parameter descriptions.

**Tech Stack:** TypeScript, Node.js `fs` module (no new dependencies), Zod (already in use), Vitest for unit tests.

## Global Constraints

- No new npm dependencies
- Unit tests live in `src/*.test.ts` and run with `npm run test:unit` (`vitest run src`)
- Vitest style: `describe` / `it` / `expect` — see `src/transaction-parser.test.ts` as the style reference
- Chat MID validated against `/^[a-zA-Z0-9_-]+$/` before any file path is built (path traversal guard)
- `NamedTemplate` extends `TransactionTemplate` — import `TransactionTemplateSchema` from `./transaction-parser`, do not duplicate it
- All store functions accept an optional `storeDir` parameter (default: `join(process.cwd(), '.line-templates')`) so tests can pass a temp directory without mocking `fs`
- `filterByTime`: if `valid_from` or `valid_until` is present but `new Date(value).getTime()` returns `NaN`, treat that field as absent (always-valid)
- Spec: `docs/superpowers/specs/2026-06-21-line-mcp-template-store-design.md`

---

### Task 1: `src/template-store.ts` — storage module

**Files:**
- Create: `src/template-store.ts`
- Create: `src/template-store.test.ts`

**Interfaces:**
- Produces:
  - `NamedTemplateSchema` — Zod schema (extends `TransactionTemplateSchema`)
  - `NamedTemplate` — TypeScript type
  - `loadTemplates(chatMid, storeDir?) → { templates: NamedTemplate[]; warning?: string }`
  - `upsertTemplate(chatMid, template, storeDir?) → void`
  - `deleteTemplate(chatMid, name, storeDir?) → boolean`
  - `listTemplates(chatMid, storeDir?) → NamedTemplate[]`
  - `filterByTime(templates, timestampMs) → NamedTemplate[]`

- [ ] **Step 1: Write the failing tests**

Create `src/template-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTemplates,
  upsertTemplate,
  deleteTemplate,
  listTemplates,
  filterByTime,
  NamedTemplate,
} from './template-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-tmpl-'));
});
// cleanup is not strictly needed in CI but keeps local runs tidy
import { afterEach } from 'vitest';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TMPL_A: NamedTemplate = {
  name: 'uob-debit-v1',
  pattern: 'spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_until: '2025-02-28T23:59:59+07:00',
};
const TMPL_B: NamedTemplate = {
  name: 'uob-debit-v2',
  pattern: 'deducted\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_from: '2025-03-01T00:00:00+07:00',
};

describe('loadTemplates', () => {
  it('returns empty array for missing file', () => {
    const result = loadTemplates('mid123', dir);
    expect(result.templates).toEqual([]);
    expect(result.warning).toBeUndefined();
  });
});

describe('upsertTemplate', () => {
  it('creates file and inserts template', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });

  it('replaces template with same name', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    const updated = { ...TMPL_A, valid_until: '2025-03-31T23:59:59+07:00' };
    upsertTemplate('mid123', updated, dir);
    const result = loadTemplates('mid123', dir).templates;
    expect(result).toHaveLength(1);
    expect(result[0].valid_until).toBe('2025-03-31T23:59:59+07:00');
  });

  it('inserts second template without replacing first', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(loadTemplates('mid123', dir).templates).toHaveLength(2);
  });
});

describe('deleteTemplate', () => {
  it('returns false when name not found', () => {
    expect(deleteTemplate('mid123', 'nonexistent', dir)).toBe(false);
  });

  it('removes template and returns true', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(deleteTemplate('mid123', 'uob-debit-v1', dir)).toBe(true);
    const remaining = loadTemplates('mid123', dir).templates;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('uob-debit-v2');
  });
});

describe('listTemplates', () => {
  it('returns full objects in insertion order', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(listTemplates('mid123', dir)).toEqual([TMPL_A, TMPL_B]);
  });

  it('returns empty array when no file exists', () => {
    expect(listTemplates('mid123', dir)).toEqual([]);
  });
});

describe('filterByTime', () => {
  // TMPL_A valid until 2025-02-28T23:59:59+07:00 = 2025-02-28T16:59:59.000Z = 1740762199000 ms UTC
  // TMPL_B valid from 2025-03-01T00:00:00+07:00  = 2025-02-28T17:00:00.000Z = 1740762000000 ms UTC
  const beforeCutover = new Date('2025-02-15T00:00:00.000Z').getTime();
  const afterCutover = new Date('2025-03-15T00:00:00.000Z').getTime();

  it('returns only template valid before cutover', () => {
    const result = filterByTime([TMPL_A, TMPL_B], beforeCutover);
    expect(result.map(t => t.name)).toEqual(['uob-debit-v1']);
  });

  it('returns only template valid after cutover', () => {
    const result = filterByTime([TMPL_A, TMPL_B], afterCutover);
    expect(result.map(t => t.name)).toEqual(['uob-debit-v2']);
  });

  it('returns all templates when no validity range set', () => {
    const noRange: NamedTemplate = { name: 'open', pattern: '(?<currency>THB) (?<amount>[\\d.]+)' };
    expect(filterByTime([noRange], beforeCutover)).toEqual([noRange]);
    expect(filterByTime([noRange], afterCutover)).toEqual([noRange]);
  });

  it('treats unparseable valid_from as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<currency>THB) (?<amount>[\\d.]+)', valid_from: 'not-a-date' };
    expect(filterByTime([bad], beforeCutover)).toEqual([bad]);
  });

  it('treats unparseable valid_until as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<currency>THB) (?<amount>[\\d.]+)', valid_until: 'not-a-date' };
    expect(filterByTime([bad], afterCutover)).toEqual([bad]);
  });
});

describe('path traversal guard', () => {
  it('throws for chatMid with slash', () => {
    expect(() => loadTemplates('../etc/passwd', dir)).toThrow('Invalid chatMid');
  });

  it('throws for chatMid with dot', () => {
    expect(() => loadTemplates('mid.123', dir)).toThrow('Invalid chatMid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/template-store.test.ts
```

Expected: FAIL with `Cannot find module './template-store'`

- [ ] **Step 3: Implement `src/template-store.ts`**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { TransactionTemplateSchema } from './transaction-parser';

export const NamedTemplateSchema = TransactionTemplateSchema.extend({
  name: z.string().min(1).describe('Unique name for this template within the chat'),
  valid_from: z.string().optional().describe(
    'ISO 8601 datetime with timezone offset e.g. "2025-03-01T00:00:00+07:00". ' +
    'Messages before this time skip this template. Omit for beginning of time.'
  ),
  valid_until: z.string().optional().describe(
    'ISO 8601 datetime with timezone offset e.g. "2025-02-28T23:59:59+07:00". ' +
    'Messages after this time skip this template. Omit if template is still active.'
  ),
});
export type NamedTemplate = z.infer<typeof NamedTemplateSchema>;

const DEFAULT_STORE_DIR = join(process.cwd(), '.line-templates');
const SAFE_MID_RE = /^[a-zA-Z0-9_-]+$/;

function safeFilePath(chatMid: string, storeDir: string): string {
  if (!SAFE_MID_RE.test(chatMid)) throw new Error(`Invalid chatMid: ${chatMid}`);
  return join(storeDir, `${chatMid}.json`);
}

export function loadTemplates(
  chatMid: string,
  storeDir = DEFAULT_STORE_DIR,
): { templates: NamedTemplate[]; warning?: string } {
  const path = safeFilePath(chatMid, storeDir);
  if (!existsSync(path)) return { templates: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { templates: raw.templates ?? [] };
  } catch {
    return { templates: [], warning: `Template file for ${chatMid} is corrupt or unreadable — returning empty list.` };
  }
}

function writeTemplates(chatMid: string, templates: NamedTemplate[], storeDir: string): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(safeFilePath(chatMid, storeDir), JSON.stringify({ templates }, null, 2));
}

export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir = DEFAULT_STORE_DIR): void {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  writeTemplates(chatMid, templates, storeDir);
}

export function deleteTemplate(chatMid: string, name: string, storeDir = DEFAULT_STORE_DIR): boolean {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  templates.splice(idx, 1);
  writeTemplates(chatMid, templates, storeDir);
  return true;
}

export function listTemplates(chatMid: string, storeDir = DEFAULT_STORE_DIR): NamedTemplate[] {
  return loadTemplates(chatMid, storeDir).templates;
}

export function filterByTime(templates: NamedTemplate[], timestampMs: number): NamedTemplate[] {
  return templates.filter((t) => {
    if (t.valid_from) {
      const from = new Date(t.valid_from).getTime();
      if (Number.isFinite(from) && timestampMs < from) return false;
    }
    if (t.valid_until) {
      const until = new Date(t.valid_until).getTime();
      if (Number.isFinite(until) && timestampMs > until) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/template-store.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/template-store.ts src/template-store.test.ts
git commit -m "feat: add template-store module with NamedTemplate schema and file persistence"
```

---

### Task 2: `manage_templates` MCP tool

**Files:**
- Modify: `src/index.ts` — import store functions + NamedTemplateSchema, register `manage_templates` tool

**Interfaces:**
- Consumes: `upsertTemplate`, `deleteTemplate`, `listTemplates`, `NamedTemplateSchema`, `NamedTemplate` from `./template-store`

- [ ] **Step 1: Add import to `src/index.ts`**

Add after the existing imports (around line 9):

```typescript
import { upsertTemplate, deleteTemplate, listTemplates, filterByTime, loadTemplates, NamedTemplateSchema, NamedTemplate } from './template-store';
```

- [ ] **Step 2: Register `manage_templates` tool in `src/index.ts`**

Add after the `get_image` tool registration (after line 136, before `get_transactions`):

```typescript
server.registerTool(
  'manage_templates',
  {
    description:
      'Create, update, delete, or list saved transaction regex templates for a LINE chat. ' +
      'Templates are persisted in .line-templates/<chatMid>.json and auto-loaded by get_transactions. ' +
      'Recommended workflow: call sample_messages first to inspect raw message text, ' +
      'then upsert templates here, then call get_transactions with no templates argument.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      action: z.enum(['upsert', 'delete', 'list']).describe(
        '"upsert" — save or replace a template by name. ' +
        '"delete" — remove a named template. ' +
        '"list" — return all saved templates for this chat (full objects, in insertion order).'
      ),
      template: NamedTemplateSchema.optional().describe(
        'Required for action: upsert. Pattern rules: ' +
        'Use named capture groups — (?<currency>...) and (?<amount>...) are REQUIRED; ' +
        '(?<merchant>...), (?<date>...), (?<balance>...), (?<account>...) are optional. ' +
        'Pattern is compiled with the "s" flag (dotAll) — . matches newlines, enabling one pattern for bilingual messages. ' +
        'Backslashes must be doubled in JSON strings: \\\\d, \\\\s, \\\\. — but / does NOT need escaping. ' +
        'Bank messages often use non-breaking spaces (U+00A0) — use \\\\s+ instead of a literal space at word boundaries. ' +
        'amount_sign: "debit" stores amount as negative; "credit" as positive. ' +
        'date_format hint: "DD/MM", "DD/MM/YYYY", or "DD/MM/YYYY HH:mm" — omit if date is already ISO-parseable. ' +
        'valid_from / valid_until: ISO 8601 with timezone offset, e.g. "2025-03-01T00:00:00+07:00". ' +
        'Messages outside this window skip this template — use when the bank changed its message format.'
      ),
      name: z.string().optional().describe('Template name to remove (required for action: delete)'),
    },
  },
  async ({ chatMid, action, template, name }) => {
    if (action === 'upsert') {
      if (!template) {
        return { content: [{ type: 'text' as const, text: 'template is required for action: upsert' }], isError: true };
      }
      try {
        upsertTemplate(chatMid, template);
        return { content: [{ type: 'text' as const, text: `Template '${template.name}' saved for chat ${chatMid}.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to save template: ${(err as Error).message}` }], isError: true };
      }
    }

    if (action === 'delete') {
      if (!name) {
        return { content: [{ type: 'text' as const, text: 'name is required for action: delete' }], isError: true };
      }
      try {
        const deleted = deleteTemplate(chatMid, name);
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `No template named '${name}' found for this chat.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Template '${name}' deleted from chat ${chatMid}.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to delete template: ${(err as Error).message}` }], isError: true };
      }
    }

    // action === 'list'
    try {
      const templates = listTemplates(chatMid);
      const text = templates.length === 0
        ? `No templates saved for chat ${chatMid}.`
        : JSON.stringify(templates, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to list templates: ${(err as Error).message}` }], isError: true };
    }
  },
);
```

- [ ] **Step 3: Verify the server starts without errors**

```bash
npm run build 2>&1 | tail -5
```

Expected: no TypeScript errors, `dist/` updated.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add manage_templates MCP tool with inline regex guidance"
```

---

### Task 3: `sample_messages` MCP tool

**Files:**
- Modify: `src/index.ts` — register `sample_messages` tool

**Interfaces:**
- Consumes: `LineClient.getMessages` (already available via `makeLineClient`)

- [ ] **Step 1: Register `sample_messages` tool in `src/index.ts`**

Add after the `manage_templates` tool registration (before `get_transactions`):

```typescript
server.registerTool(
  'sample_messages',
  {
    description:
      'Fetch raw text messages from a LINE chat for regex template derivation. ' +
      'Use this BEFORE writing transaction templates — it shows raw message content with UTC timestamps ' +
      'so you can identify anchor strings, field boundaries, and when the bank changed its message format. ' +
      'Returns only text messages (images, stickers, and other non-text content are excluded), ' +
      'sorted oldest-first so format evolution is visible top-to-bottom.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      count: z.number().int().min(1).max(50).default(20).describe('Number of recent text messages to return'),
    },
  },
  async ({ chatMid, count }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const client = makeLineClient(authData);
      const messages = await client.getMessages(chatMid, count, false);
      const textMessages = messages
        .filter((m) => m.contentType === 0 && m.text)
        .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
      if (textMessages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No text messages found.' }] };
      }
      const lines = textMessages.map((m) => {
        const time = new Date(parseInt(m.createdTime, 10)).toISOString();
        return `[${time}] ${m.text}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to sample messages: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 2: Verify the server compiles**

```bash
npm run build 2>&1 | tail -5
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add sample_messages MCP tool for template derivation"
```

---

### Task 4: Make `templates` optional in `get_transactions`

**Files:**
- Modify: `src/index.ts` — update `get_transactions` inputSchema and handler

**Interfaces:**
- Consumes: `loadTemplates`, `filterByTime` from `./template-store`

- [ ] **Step 1: Replace the `get_transactions` registration in `src/index.ts`**

Replace the entire `server.registerTool('get_transactions', ...)` block (lines 139–180 in the original file) with:

```typescript
server.registerTool(
  'get_transactions',
  {
    description:
      'Fetch messages from a LINE chat and parse them into structured transactions using regex templates. ' +
      'Non-matching messages (promotions, alerts) are silently dropped. Results are sorted oldest→newest. ' +
      'If templates is omitted, saved templates for this chat are loaded automatically from .line-templates/<chatMid>.json ' +
      'and filtered per message by valid_from/valid_until, so bank format changes across time are handled transparently. ' +
      'Use manage_templates to save templates and sample_messages to inspect raw messages before writing patterns.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      templates: z.array(TransactionTemplateSchema).min(1).optional().describe(
        'Ordered list of patterns to try per message; first match wins. ' +
        'Omit to auto-load saved templates for this chat.'
      ),
      limit: z.number().int().min(1).max(200).default(100).describe('Max messages to fetch from LINE'),
      since: z.string().optional().describe('ISO date — exclude transactions before this date'),
      until: z.string().optional().describe('ISO date — exclude transactions after this date'),
    },
  },
  async ({ chatMid, templates: suppliedTemplates, limit, since, until }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const client = makeLineClient(authData);
      const messages = await client.getMessages(chatMid, limit, false);

      const warnings: string[] = [];
      let savedTemplates: NamedTemplate[] | null = null;

      if (!suppliedTemplates) {
        const loaded = loadTemplates(chatMid);
        if (loaded.warning) warnings.push(loaded.warning);
        savedTemplates = loaded.templates;

        if (savedTemplates.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No templates provided and none saved for this chat. ' +
                'Call sample_messages to inspect messages, then manage_templates (action: upsert) to save patterns.',
            }],
            isError: true,
          };
        }

        for (const t of savedTemplates) {
          if (t.valid_from && !Number.isFinite(new Date(t.valid_from).getTime())) {
            warnings.push(`Template "${t.name}": valid_from "${t.valid_from}" could not be parsed — treating as always-valid.`);
          }
          if (t.valid_until && !Number.isFinite(new Date(t.valid_until).getTime())) {
            warnings.push(`Template "${t.name}": valid_until "${t.valid_until}" could not be parsed — treating as always-valid.`);
          }
        }
      }

      let transactions = messages
        .map((msg) => {
          const templatesForMsg = savedTemplates
            ? filterByTime(savedTemplates, parseInt(msg.createdTime, 10))
            : suppliedTemplates!;
          return parseTransaction(msg, templatesForMsg);
        })
        .filter((tx) => tx !== null);

      if (since) transactions = transactions.filter((tx) => tx.date >= since);
      if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
      transactions.sort((a, b) => a.date.localeCompare(b.date));

      const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';

      if (savedTemplates !== null && transactions.length === 0 && messages.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '0 transactions matched. Check that saved templates cover the message timestamps — ' +
              'use manage_templates (action: list) to review validity ranges.' + warningBlock,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get transactions: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 2: Verify the server compiles**

```bash
npm run build 2>&1 | tail -5
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run the unit test suite to confirm no regressions**

```bash
npm run test:unit
```

Expected: all existing tests PASS (template-store tests included).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: make get_transactions templates optional — auto-loads saved templates with time filtering"
```

---

### Task 5: Gitignore and cleanup

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add `.line-templates/` to `.gitignore`**

Open `.gitignore` and append:

```
.line-templates/
```

- [ ] **Step 2: Verify**

```bash
git check-ignore -v .line-templates/
```

Expected: `.gitignore:... .line-templates/`

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore .line-templates/ directory"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Storage layer: `src/template-store.ts` with `NamedTemplate`, all CRUD functions, `filterByTime` — Task 1
- [x] `valid_from`/`valid_until` as full ISO 8601 with timezone — Task 1 schema
- [x] Path traversal guard on chatMid — Task 1 `safeFilePath`
- [x] `manage_templates` tool with upsert/delete/list + inline regex rules — Task 2
- [x] `sample_messages` tool returning oldest-first raw text with timestamps — Task 3
- [x] `get_transactions` templates optional, auto-load, per-message `filterByTime` — Task 4
- [x] Error message when no templates saved or zero matches — Task 4
- [x] Unparseable dates treated as always-valid with warning — Task 4
- [x] Corrupt file returns empty + warning — Task 1 `loadTemplates`
- [x] `.gitignore` — Task 5

**Placeholder scan:** None found.

**Type consistency:**
- `NamedTemplate` defined in Task 1, consumed in Tasks 2, 4 — all use the same import path `./template-store`
- `filterByTime(templates: NamedTemplate[], timestampMs: number): NamedTemplate[]` — consistent across Task 1 definition and Task 4 usage
- `loadTemplates` returns `{ templates, warning? }` — consistent between Task 1 implementation and Task 4 usage
