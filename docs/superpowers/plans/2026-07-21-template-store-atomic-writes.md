# Template Store Atomic Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make template-store reads fail on existing-file errors and make every template, alias, and migration rewrite atomically replace the destination without destroying the prior snapshot on failure.

**Architecture:** `loadTemplates` will treat only `ENOENT` as an empty store and propagate every other read, parse, structure, or migration-write failure. One private same-directory temporary-file writer will serialize complete snapshots, write them exclusively, rename them over the destination, and clean up without masking the original failure.

**Tech Stack:** TypeScript 6, Node.js synchronous `fs` and `crypto` APIs, Vitest 4, npm workspaces, ESLint

## Global Constraints

- Work only on JSON template and currency-alias persistence; category data remains unchanged.
- Do not add backups, automatic repair, retained generations, schema changes, or cross-process locking.
- Preserve the one-process-per-data-root rule.
- A missing template file returns `{ templates: [], currency_aliases: {} }`; every existing-file load failure throws.
- A migration persistence failure throws and must not return the migrated in-memory data.
- Temporary-file cleanup failures must not mask the original write or rename error.
- Do not edit `packages/line-client/assets/ltsm/*`.

---

### Task 1: Fail Fast On Existing-File Load Failures

**Files:**
- Modify: `packages/bank-mcp/src/template-store.ts:26-51`
- Modify: `packages/bank-mcp/src/template-store.test.ts:36-42`
- Modify: `packages/bank-mcp/src/tools/fetch-transactions.ts:61-65`

**Interfaces:**
- Consumes: Existing `safeFilePath(chatMid: string, storeDir: string): string` path guard.
- Produces: `loadTemplates(chatMid: string, storeDir: string): { templates: NamedTemplate[]; currency_aliases: Record<string, string> }`, returning an empty snapshot only for `ENOENT` and throwing all other failures.
- Produces: Existing `upsertTemplate`, `deleteTemplate`, `upsertAlias`, and `deleteAlias` functions that abort before writing when loading throws.

- [ ] **Step 1: Add failing malformed-store read tests**

Add this test after the missing-file test in the existing `describe('loadTemplates', ...)` block:

```ts
  it('throws when an existing file contains malformed JSON', () => {
    writeFileSync(join(dir, 'mid123.json'), '{"templates":[');

    expect(() => loadTemplates('mid123', dir)).toThrow();
  });
```

Add a new block after `describe('listAliases', ...)` to pin all public non-mutating helper behavior:

```ts
describe('corrupt store reads', () => {
  it.each([
    ['listTemplates', () => listTemplates('mid123', dir)],
    ['listAliases', () => listAliases('mid123', dir)],
  ])('%s throws instead of treating an existing malformed store as empty', (_name, read) => {
    writeFileSync(join(dir, 'mid123.json'), '{"templates":[');

    expect(read).toThrow();
  });
});
```

- [ ] **Step 2: Add failing mutation-preservation tests**

Add this block after the corrupt-read tests. Each case recreates the malformed bytes because a broken implementation may overwrite them:

```ts
describe('mutations against a corrupt store', () => {
  const malformed = '{"templates":[';

  it.each([
    ['upsertTemplate', () => upsertTemplate('mid123', TMPL_A, dir)],
    ['deleteTemplate', () => deleteTemplate('mid123', TMPL_A.name, dir)],
    ['upsertAlias', () => upsertAlias('mid123', 'baht', 'THB', dir)],
    ['deleteAlias', () => deleteAlias('mid123', 'baht', dir)],
  ])('%s throws and preserves the malformed file', (_name, mutate) => {
    const file = join(dir, 'mid123.json');
    writeFileSync(file, malformed);

    expect(mutate).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(malformed);
  });
});
```

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```bash
npx vitest run packages/bank-mcp/src/template-store.test.ts
```

Expected: FAIL. The malformed read returns an empty result, and at least the upsert mutation replaces the malformed destination instead of throwing.

- [ ] **Step 4: Narrow the loader catch to the file read and `ENOENT`**

Replace the current `loadTemplates` implementation with:

```ts
export function loadTemplates(
  chatMid: string,
  storeDir: string,
): { templates: NamedTemplate[]; currency_aliases: Record<string, string> } {
  const path = safeFilePath(chatMid, storeDir);
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { templates: [], currency_aliases: {} };
    }
    throw error;
  }

  const raw = JSON.parse(contents);
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
}
```

Remove `existsSync` from the `fs` import because the loader no longer performs a check-before-read. Keep it temporarily if `writeTemplates` still uses it; Task 2 removes the final use.

- [ ] **Step 5: Remove obsolete warning collection from transaction fetching**

Replace:

```ts
  const warnings: string[] = [];
  const loaded = deps.templates.load(chatMid);
  if (loaded.warning) warnings.push(loaded.warning);
```

with:

```ts
  const warnings: string[] = [];
  const loaded = deps.templates.load(chatMid);
```

This preserves all unrelated transaction warnings while allowing template load errors to reject the operation.

- [ ] **Step 6: Run the focused tests and type-check**

Run:

```bash
npx vitest run packages/bank-mcp/src/template-store.test.ts
npm run build
```

Expected: the template-store test file passes with zero failures, and `tsc -b` exits 0 without references to `loaded.warning`.

- [ ] **Step 7: Commit the fail-fast loader**

```bash
git add packages/bank-mcp/src/template-store.ts packages/bank-mcp/src/template-store.test.ts packages/bank-mcp/src/tools/fetch-transactions.ts
git commit -m "fix(bank-mcp): reject corrupt template stores"
```

---

### Task 2: Atomically Replace Template Store Snapshots

**Files:**
- Modify: `packages/bank-mcp/src/template-store.ts:1-2,42-57`
- Modify: `packages/bank-mcp/src/template-store.test.ts:1-21,136-208`

**Interfaces:**
- Consumes: Task 1's fail-fast `loadTemplates` result and existing `safeFilePath` guard.
- Produces: Private `writeTemplates(chatMid: string, templates: NamedTemplate[], aliases: Record<string, string>, storeDir: string): void` using exclusive same-directory temporary creation and atomic rename.
- Produces: All mutation helpers and legacy pattern migration using the same atomic writer.

- [ ] **Step 1: Make filesystem write and rename operations injectable in tests**

Replace the test file's direct `fs` import with a module import and mock the two failure points:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    writeFileSync: vi.fn(original.writeFileSync),
    renameSync: vi.fn(original.renameSync),
  };
});

const { mkdtempSync, rmSync, writeFileSync, readFileSync } = fs;
```

Update test cleanup so mock call state cannot leak between cases:

```ts
afterEach(() => {
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Add failing write- and rename-failure tests**

Add this block after the mutation-preservation tests:

```ts
describe('atomic template writes', () => {
  it('preserves the previous snapshot and cleans up when the temporary write fails', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    const file = join(dir, 'mid123.json');
    const previous = readFileSync(file, 'utf8');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('write denied');
    });

    expect(() => upsertTemplate('mid123', TMPL_B, dir)).toThrow('write denied');
    expect(readFileSync(file, 'utf8')).toBe(previous);
    expect(fs.readdirSync(dir)).toEqual(['mid123.json']);
  });

  it('preserves the previous snapshot and cleans up when rename fails', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    const file = join(dir, 'mid123.json');
    const previous = readFileSync(file, 'utf8');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    expect(() => upsertTemplate('mid123', TMPL_B, dir)).toThrow('rename denied');
    expect(readFileSync(file, 'utf8')).toBe(previous);
    expect(fs.readdirSync(dir)).toEqual(['mid123.json']);
  });

  it('leaves no temporary file after a successful replacement', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);

    expect(fs.readdirSync(dir)).toEqual(['mid123.json']);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A, TMPL_B]);
  });
});
```

- [ ] **Step 3: Add a failing atomic migration-rewrite test**

Add this case to `describe('loadTemplates migration', ...)`:

```ts
  it('throws and preserves the legacy snapshot when migration rename fails', () => {
    const file = join(dir, 'mid123.json');
    const legacy = JSON.stringify({
      templates: [{ name: 'old', pattern: 'pay (?<currency>\\w+) (?<amount>[\\d.]+)' }],
      currency_aliases: { baht: 'THB' },
    });
    writeFileSync(file, legacy);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    expect(() => loadTemplates('mid123', dir)).toThrow('rename denied');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
    expect(fs.readdirSync(dir)).toEqual(['mid123.json']);

    const retried = loadTemplates('mid123', dir);
    expect(retried.templates[0].pattern)
      .toBe('pay (?<original_currency>\\w+) (?<original_amount>[\\d.]+)');
  });
```

- [ ] **Step 4: Run the focused tests to verify they fail**

Run:

```bash
npx vitest run packages/bank-mcp/src/template-store.test.ts
```

Expected: FAIL. Direct destination writes do not call `renameSync`, so the injected rename failures are not observed and the preservation assertions fail.

- [ ] **Step 5: Implement the single atomic snapshot writer**

Replace the top imports in `template-store.ts` with:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import { join } from 'path';
```

Update `loadTemplates` to use `fs.readFileSync`, and replace its direct migration write with:

```ts
    writeTemplates(chatMid, migrated, rawAliases, storeDir);
```

Replace the existing `writeTemplates` function with:

```ts
function writeTemplates(
  chatMid: string,
  templates: NamedTemplate[],
  aliases: Record<string, string>,
  storeDir: string,
): void {
  const destination = safeFilePath(chatMid, storeDir);
  const serialized = JSON.stringify({ templates, currency_aliases: aliases }, null, 2);
  fs.mkdirSync(storeDir, { recursive: true });
  const temporary = join(
    storeDir,
    `.${chatMid}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
    throw error;
  }
}
```

Keep serialization before `mkdirSync` so serialization errors occur before filesystem mutation. Do not add `fsync`, backup files, or locking; they are outside the approved scope.

- [ ] **Step 6: Run focused tests and lint**

Run:

```bash
npx vitest run packages/bank-mcp/src/template-store.test.ts
npm run lint
```

Expected: all template-store tests pass with zero failures, and ESLint exits 0.

- [ ] **Step 7: Commit atomic persistence**

```bash
git add packages/bank-mcp/src/template-store.ts packages/bank-mcp/src/template-store.test.ts
git commit -m "fix(bank-mcp): write template stores atomically"
```

---

### Task 3: Document And Verify The Persistence Contract

**Files:**
- Modify: `docs/ARCHITECTURE.md:72`

**Interfaces:**
- Consumes: Task 1's fail-fast loader and Task 2's atomic snapshot writer.
- Produces: Architecture documentation stating the operational contract for template-store load failures and writes.

- [ ] **Step 1: Update the architecture reference**

Replace the `template-store.ts` bullet with:

```markdown
- **`template-store.ts`** — `TemplateStore` + `loadTemplates`/`upsertTemplate`/`deleteTemplate`/`listTemplates`/`filterByTime`, one JSON file per chat MID under `<dataRoot>/templates/<chatMid>.json`; migrates old `(?<amount>)`/`(?<currency>)` group names; path-traversal guard on chatMid. Missing files load as empty stores, while existing-file read/parse/migration failures throw. Mutations and migration rewrites use same-directory temporary files plus atomic rename so a failed write preserves the prior snapshot.
```

- [ ] **Step 2: Run the complete pre-PR gate**

Run:

```bash
npm run lint
npm run build
npm run test:unit
npm run test:smoke
```

Expected: all four commands exit 0. Unit and smoke output report zero failed tests. Do not run live `test:e2e`; it requires real LINE credentials and is manual-only.

- [ ] **Step 3: Inspect the final diff for scope and whitespace errors**

Run:

```bash
git status --short
git diff --check
git diff origin/main...HEAD
git diff
```

Expected: no whitespace errors; only issue #64 source, tests, the approved design/plan documents, and `docs/ARCHITECTURE.md` are in scope. Leave `docs/superpowers/plans/2026-07-19-line-auth-provider-freshness-state.md` untracked and untouched.

- [ ] **Step 4: Commit the architecture documentation**

```bash
git add docs/ARCHITECTURE.md docs/superpowers/plans/2026-07-21-template-store-atomic-writes.md
git commit -m "docs: document template store persistence safety"
```

- [ ] **Step 5: Verify the committed branch state**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: the branch is ahead of `origin/main`; the only remaining untracked path is the unrelated `docs/superpowers/plans/2026-07-19-line-auth-provider-freshness-state.md`; the log contains the design commit and the three implementation-plan commits.
