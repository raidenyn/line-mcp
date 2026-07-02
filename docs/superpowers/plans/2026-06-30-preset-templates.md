# Preset Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship predefined working regex templates ("presets") for known banks, auto-suggested when `sample_messages` finds unmatched messages that a preset would cover.

**Architecture:** Presets are JSON files in `src/presets/` (same format as `data/templates/<chatMid>.json` plus a `description` field). A new `preset-store.ts` module loads them and provides a `detectPresets()` helper used by the `sample_messages` handler. Two new actions — `list_presets` and `apply_preset` — are added to `manage_templates`.

**Tech Stack:** TypeScript, Node.js `fs` module, Vitest, Zod (already in use).

## Global Constraints

- Unit test files live in `src/*.test.ts`; run with `npm run test:unit`
- Tests use Vitest `describe`/`it`/`expect` — no `beforeAll` unless the test needs shared setup
- All regex patterns must be compiled with the `'s'` (dotAll) flag — required for bilingual messages
- `chatMid` remains `z.string()` (required) in `manage_templates` — `list_presets` accepts and ignores it
- Never write to `data/` from preset code — presets are read-only source files
- Build script must copy `src/presets/` to `dist/presets/` — add to `package.json`

---

### Task 1: Preset JSON files and build script update

**Files:**
- Create: `src/presets/scb.json`
- Create: `src/presets/cardx.json`
- Modify: `package.json` (build script)

**Interfaces:**
- Produces: Two preset files readable by `loadAllPresets()` in Task 2. Shape: `{ description: string, templates: NamedTemplate[], currency_aliases: Record<string, string> }`.

- [ ] **Step 1: Create `src/presets/scb.json`**

```json
{
  "description": "SCB Connect — Thai baht debit/credit notifications (LINE bot)",
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
```

- [ ] **Step 2: Create `src/presets/cardx.json`**

```json
{
  "description": "CardX credit card — English spend notifications",
  "templates": [
    {
      "name": "cardx-debit",
      "pattern": "CardX\\s+would\\s+like\\s+to\\s+inform\\s+that\\s+you\\s+have\\s+made\\s+transaction\\s+via\\s+card\\s+ending\\s+with\\s+(?<account>\\d+)\\s+at\\s+(?<merchant>.+?)\\s+in\\s+the\\s+amount\\s+of\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>[A-Z]+)\\s+on\\s+(?<date>.+?)\\.\\s+You\\s+have\\s+available\\s+credit\\s+limit\\s+(?<balance>[\\d,]+\\.?\\d*)",
      "amount_sign": "debit"
    }
  ],
  "currency_aliases": {}
}
```

- [ ] **Step 3: Update `package.json` build script to copy presets**

In `package.json`, change the `"build"` script from:
```
"build": "tsc && cp src/index.html dist/index.html && cp -r src/ltsm dist/ltsm"
```
to:
```
"build": "tsc && cp src/index.html dist/index.html && cp -r src/ltsm dist/ltsm && cp -r src/presets dist/presets"
```

- [ ] **Step 4: Verify the JSON files are valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/presets/scb.json','utf8')); console.log('scb OK')"
node -e "JSON.parse(require('fs').readFileSync('src/presets/cardx.json','utf8')); console.log('cardx OK')"
```

Expected: both print `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/presets/scb.json src/presets/cardx.json package.json
git commit -m "feat: add SCB and CardX preset template files"
```

---

### Task 2: `src/preset-store.ts` with `detectPresets` + unit tests

**Files:**
- Create: `src/preset-store.ts`
- Create: `src/preset-store.test.ts`

**Interfaces:**
- Consumes: `NamedTemplate` from `./template-store`
- Produces:
  - `Preset` interface exported from `src/preset-store.ts`
  - `loadAllPresets(dir?: string): Record<string, Preset>` — key is filename stem (e.g. `"scb"`)
  - `getPreset(name: string, dir?: string): Preset | null`
  - `detectPresets(messages: Array<{ text?: string }>, savedTemplates: Array<{ pattern: string }>, presets: Record<string, Preset>): Array<{ preset_name: string; matched_count: number; description: string }>`

- [ ] **Step 1: Write failing tests for `preset-store.ts`**

Create `src/preset-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAllPresets, getPreset, detectPresets, Preset } from './preset-store';

const FAKE_PRESET: Preset = {
  description: 'Test Bank notifications',
  templates: [
    { name: 'test-debit', pattern: 'TESTBANK debit (?<original_amount>[\\d.]+) (?<original_currency>THB)', amount_sign: 'debit' },
  ],
  currency_aliases: { 'THB': 'THB' },
};

const OTHER_PRESET: Preset = {
  description: 'Other Bank',
  templates: [
    { name: 'other-credit', pattern: 'OTHERBANK credit (?<original_amount>[\\d.]+) (?<original_currency>USD)', amount_sign: 'credit' },
  ],
  currency_aliases: {},
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'line-presets-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadAllPresets', () => {
  it('returns empty object when directory has no json files', () => {
    expect(loadAllPresets(dir)).toEqual({});
  });

  it('loads a single preset keyed by filename stem', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    const result = loadAllPresets(dir);
    expect(result['testbank']).toBeDefined();
    expect(result['testbank'].description).toBe('Test Bank notifications');
    expect(result['testbank'].templates).toHaveLength(1);
  });

  it('loads multiple presets', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    writeFileSync(join(dir, 'other.json'), JSON.stringify(OTHER_PRESET));
    const result = loadAllPresets(dir);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['testbank']).toBeDefined();
    expect(result['other']).toBeDefined();
  });

  it('ignores non-json files', () => {
    writeFileSync(join(dir, 'readme.txt'), 'ignore me');
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    expect(Object.keys(loadAllPresets(dir))).toHaveLength(1);
  });

  it('skips files that fail to parse', () => {
    writeFileSync(join(dir, 'broken.json'), 'not valid json {{{');
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    expect(Object.keys(loadAllPresets(dir))).toHaveLength(1);
  });
});

describe('getPreset', () => {
  it('returns the preset for a known name', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    const p = getPreset('testbank', dir);
    expect(p).not.toBeNull();
    expect(p!.description).toBe('Test Bank notifications');
  });

  it('returns null for an unknown name', () => {
    expect(getPreset('nonexistent', dir)).toBeNull();
  });
});

describe('detectPresets', () => {
  const presets: Record<string, Preset> = {
    testbank: FAKE_PRESET,
    other: OTHER_PRESET,
  };

  it('suggests a preset when a message matches preset but no saved template', () => {
    const messages = [{ text: 'TESTBANK debit 100.00 THB' }];
    const result = detectPresets(messages, [], presets);
    expect(result).toHaveLength(1);
    expect(result[0].preset_name).toBe('testbank');
    expect(result[0].matched_count).toBe(1);
    expect(result[0].description).toBe('Test Bank notifications');
  });

  it('does not suggest preset when message already matched by saved template', () => {
    const messages = [{ text: 'TESTBANK debit 100.00 THB' }];
    const savedTemplates = [{ pattern: 'TESTBANK debit (?<original_amount>[\\d.]+) (?<original_currency>THB)' }];
    const result = detectPresets(messages, savedTemplates, presets);
    expect(result).toHaveLength(0);
  });

  it('counts multiple unmatched messages', () => {
    const messages = [
      { text: 'TESTBANK debit 50.00 THB' },
      { text: 'TESTBANK debit 200.00 THB' },
      { text: 'Some promo message' },
    ];
    const result = detectPresets(messages, [], presets);
    expect(result).toHaveLength(1);
    expect(result[0].matched_count).toBe(2);
  });

  it('suggests multiple presets when different messages match different presets', () => {
    const messages = [
      { text: 'TESTBANK debit 50.00 THB' },
      { text: 'OTHERBANK credit 99.00 USD' },
    ];
    const result = detectPresets(messages, [], presets);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.preset_name).sort();
    expect(names).toEqual(['other', 'testbank']);
  });

  it('does not suggest preset when message has no text', () => {
    const messages = [{ text: undefined }];
    const result = detectPresets(messages, [], presets);
    expect(result).toHaveLength(0);
  });

  it('skips preset patterns that are invalid regex', () => {
    const badPresets: Record<string, Preset> = {
      bad: {
        description: 'Bad preset',
        templates: [{ name: 'bad', pattern: '(?<original_amount>[[[)', amount_sign: 'debit' }],
        currency_aliases: {},
      },
    };
    const messages = [{ text: 'anything' }];
    expect(() => detectPresets(messages, [], badPresets)).not.toThrow();
    expect(detectPresets(messages, [], badPresets)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/preset-store.test.ts
```

Expected: FAIL with `Cannot find module './preset-store'`

- [ ] **Step 3: Implement `src/preset-store.ts`**

```typescript
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { NamedTemplate } from './template-store';

export interface Preset {
  description: string;
  templates: NamedTemplate[];
  currency_aliases: Record<string, string>;
}

function presetsDir(): string {
  return join(__dirname, 'presets');
}

export function loadAllPresets(dir = presetsDir()): Record<string, Preset> {
  const result: Record<string, Preset> = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      const name = entry.slice(0, -5);
      result[name] = {
        description: raw.description ?? '',
        templates: raw.templates ?? [],
        currency_aliases: raw.currency_aliases ?? {},
      };
    } catch {
      // skip malformed files
    }
  }
  return result;
}

export function getPreset(name: string, dir = presetsDir()): Preset | null {
  return loadAllPresets(dir)[name] ?? null;
}

function testPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 's').test(text);
  } catch {
    return false;
  }
}

export function detectPresets(
  messages: Array<{ text?: string }>,
  savedTemplates: Array<{ pattern: string }>,
  presets: Record<string, Preset>,
): Array<{ preset_name: string; matched_count: number; description: string }> {
  const suggestions: Array<{ preset_name: string; matched_count: number; description: string }> = [];

  for (const [presetName, preset] of Object.entries(presets)) {
    let gapCount = 0;
    for (const msg of messages) {
      if (!msg.text) continue;
      const matchedBySaved = savedTemplates.some((t) => testPattern(t.pattern, msg.text!));
      if (matchedBySaved) continue;
      const matchedByPreset = preset.templates.some((t) => testPattern(t.pattern, msg.text!));
      if (matchedByPreset) gapCount++;
    }
    if (gapCount > 0) {
      suggestions.push({ preset_name: presetName, matched_count: gapCount, description: preset.description });
    }
  }

  return suggestions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/preset-store.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preset-store.ts src/preset-store.test.ts
git commit -m "feat: add preset-store with loadAllPresets, getPreset, detectPresets"
```

---

### Task 3: `list_presets` and `apply_preset` actions in `manage_templates`

**Files:**
- Modify: `src/index.ts` (manage_templates tool registration only)

**Interfaces:**
- Consumes: `loadAllPresets`, `getPreset` from `./preset-store`; `upsertTemplate`, `upsertAlias` from `./template-store` (already imported)
- Produces: Two new action values in `manage_templates` tool

- [ ] **Step 1: Add import for preset-store in `src/index.ts`**

At line 14, after the existing `template-store` import, add:

```typescript
import { loadAllPresets, getPreset } from './preset-store';
```

- [ ] **Step 2: Extend the `action` enum and add `preset_name` param**

In the `manage_templates` tool's `inputSchema`, change the `action` enum from:

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

to:

```typescript
action: z.enum(['upsert', 'delete', 'list', 'upsert_alias', 'delete_alias', 'list_aliases', 'list_presets', 'apply_preset']).describe(
  '"upsert" — save or replace a template by name. ' +
  '"delete" — remove a named template. ' +
  '"list" — return all saved templates for this chat (full objects, in insertion order). ' +
  '"upsert_alias" — save or replace a currency alias (e.g. alias: "บาท", canonical: "THB"). ' +
  '"delete_alias" — remove a currency alias by its alias string. ' +
  '"list_aliases" — return all currency aliases for this chat. ' +
  '"list_presets" — list all available built-in bank presets (chatMid is ignored). ' +
  '"apply_preset" — copy all templates and aliases from a named preset into this chat\'s template file.'
),
```

Also add `preset_name` to the `inputSchema` (after the `canonical` field):

```typescript
preset_name: z.string().optional().describe('Preset name to apply (required for action: apply_preset). Use list_presets to see available names.'),
```

- [ ] **Step 3: Implement the two new action branches**

In the `manage_templates` handler, add two new branches before the final `// action === 'list'` fallthrough comment. Insert after the `if (action === 'list_aliases') { ... }` block:

```typescript
    if (action === 'list_presets') {
      const presets = loadAllPresets();
      const list = Object.entries(presets).map(([name, p]) => ({
        name,
        description: p.description,
        template_count: p.templates.length,
        currency_alias_count: Object.keys(p.currency_aliases).length,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] };
    }

    if (action === 'apply_preset') {
      if (!preset_name) {
        return { content: [{ type: 'text' as const, text: 'preset_name is required for action: apply_preset' }], isError: true };
      }
      const preset = getPreset(preset_name);
      if (!preset) {
        const available = Object.keys(loadAllPresets()).join(', ') || 'none';
        return { content: [{ type: 'text' as const, text: `Preset '${preset_name}' not found. Available presets: ${available}` }], isError: true };
      }
      for (const template of preset.templates) {
        upsertTemplate(chatMid, template);
      }
      for (const [alias, canonical] of Object.entries(preset.currency_aliases)) {
        upsertAlias(chatMid, alias, canonical);
      }
      const aliasCount = Object.keys(preset.currency_aliases).length;
      return {
        content: [{
          type: 'text' as const,
          text: `Applied preset '${preset_name}': ${preset.templates.length} templates and ${aliasCount} aliases added/updated for chat ${chatMid}.`,
        }],
      };
    }
```

Also update the destructured parameter list for the `manage_templates` handler. Change:

```typescript
async ({ chatMid, action, template, name, alias, canonical }) => {
```

to:

```typescript
async ({ chatMid, action, template, name, alias, canonical, preset_name }) => {
```

- [ ] **Step 4: Run unit tests to verify no regressions**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add list_presets and apply_preset actions to manage_templates"
```

---

### Task 4: Preset detection in `sample_messages`

**Files:**
- Modify: `src/index.ts` (sample_messages handler only)

**Interfaces:**
- Consumes: `loadAllPresets`, `detectPresets` from `./preset-store`; `loadTemplates` from `./template-store` (already imported)
- Produces: `sample_messages` response gains `content[1]` with `{ preset_suggestions: [...] }` and optional text note in `content[0]`

- [ ] **Step 1: Add `detectPresets` to the preset-store import in `src/index.ts`**

Change the import added in Task 3 from:

```typescript
import { loadAllPresets, getPreset } from './preset-store';
```

to:

```typescript
import { loadAllPresets, getPreset, detectPresets } from './preset-store';
```

- [ ] **Step 2: Wire detection into the `sample_messages` handler**

In the `sample_messages` handler, replace the final return statement:

```typescript
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
```

with:

```typescript
      const { templates: savedTemplates } = loadTemplates(chatMid);
      const allPresets = loadAllPresets();
      const presetSuggestions = detectPresets(textMessages, savedTemplates, allPresets);

      let messageText = lines.join('\n');
      if (presetSuggestions.length > 0) {
        const hints = presetSuggestions.map(
          (s) => `${s.matched_count} message(s) matched the '${s.preset_name}' preset but no saved template — run manage_templates with action: apply_preset, preset_name: '${s.preset_name}' to set it up.`,
        );
        messageText += '\n\n' + hints.join('\n');
      }

      return {
        content: [
          { type: 'text' as const, text: messageText },
          { type: 'text' as const, text: JSON.stringify({ preset_suggestions: presetSuggestions }) },
        ],
      };
```

- [ ] **Step 3: Run unit tests to verify no regressions**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 4: Smoke-test the server starts cleanly**

```bash
timeout 5 npm start 2>&1 || true
```

Expected: sees `LINE MCP server listening on` before timeout (exit code 124 is fine — it's the timeout).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: detect preset gaps in sample_messages and surface suggestions"
```

---

### Task 5: Update guide docs

**Files:**
- Modify: `docs/guide/tools/manage_templates.md`
- Modify: `docs/guide/tools/sample_messages.md`

**Interfaces:**
- No code interfaces — doc-only task.

- [ ] **Step 1: Update `docs/guide/tools/manage_templates.md`**

Replace the file content with:

```markdown
# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat. Also to manage currency aliases that normalise captured currency strings (e.g. `"บาท"` → `"THB"`). Use `list_presets` / `apply_preset` to bootstrap from a built-in bank preset instead of writing patterns from scratch.

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern. If `sample_messages` returns a `preset_suggestions` field, use `apply_preset` before writing custom patterns.

**Next steps:** `get_transactions` — saved templates and aliases load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list` | `upsert_alias` | `delete_alias` | `list_aliases` | `list_presets` | `apply_preset`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones
- `alias`: the raw currency string captured by the regex (required for `upsert_alias` and `delete_alias`)
- `canonical`: the normalised currency code to map to, e.g. `"THB"` (required for `upsert_alias`)
- `preset_name`: name of a built-in preset (required for `apply_preset`); use `list_presets` first to see available names

**Preset workflow:**
1. Call `list_presets` to see available built-in bank presets.
2. Call `apply_preset` with `preset_name` and `chatMid` to copy all templates and currency aliases into the chat's template file.
3. Call `get_transactions` — templates are now loaded automatically.
4. Add or override individual templates with `upsert` if the preset doesn't cover all message formats in this chat.

**Currency aliases:** When a template captures a non-standard currency string (e.g. Thai `"บาท"` or abbreviated `"บ"`), use `upsert_alias` to map it to a standard code. Aliases are applied at parse time so `get_transactions` and `summarize_transactions` always return the canonical code. Presets include aliases — `apply_preset` loads them automatically.

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
```

- [ ] **Step 2: Update `docs/guide/tools/sample_messages.md`**

Replace the file content with:

```markdown
# sample_messages

**When to use:** Before writing a regex template — to inspect the raw text format of bank notification messages in a chat.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** If the response includes a `preset_suggestions` field with entries, call `manage_templates` with `action: apply_preset, preset_name: <name>` to bootstrap from a built-in preset. Otherwise, write patterns manually with `manage_templates` (action: upsert).

**Key parameters:**
- `since` / `until` (ISO 8601 date strings) — critical for reaching older messages if a bank changed its format months ago. Without `since`, only the latest messages are returned.
- Results are sorted oldest-first and filtered to text-only messages.

**Response format:**
- `content[0].text`: human-readable list of messages, with an appended note when preset suggestions exist.
- `content[1].text`: JSON object `{ "preset_suggestions": [...] }` — always present. Each entry is `{ preset_name, matched_count, description }`. Empty array means no gaps were detected.

**Preset suggestion logic:** A preset is suggested when at least one returned message matches a preset pattern but is not matched by any existing saved template for this chat. This detects coverage gaps — messages that look like bank notifications but have no template yet.

**Avoid:** Don't skip this step before writing templates — message formats vary significantly between banks and change over time. Use `since` whenever you need to capture historical format variations.
```

- [ ] **Step 3: Run unit tests one final time**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/guide/tools/manage_templates.md docs/guide/tools/sample_messages.md
git commit -m "docs: update manage_templates and sample_messages guides for preset feature"
```
