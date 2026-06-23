# Data Directory Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all runtime artifacts from scattered hidden/prefixed paths into a single `data/` directory, with consistent naming and full `DATA_DIR` env-var support.

**Architecture:** A new `src/data-dir.ts` module exports five lazy path helpers (`dataDir`, `secretPath`, `authDir`, `templatesDir`, `cacheDbPath`). Each source file imports only the helper(s) it needs and drops its own path logic. No migration code; manual migration steps are documented below.

**Tech Stack:** TypeScript, Node.js `path`/`fs`, Vitest

## Global Constraints

- Default data root: `process.env.DATA_DIR ?? path.join(process.cwd(), 'data')`
- All path helpers must be functions (not constants) so `DATA_DIR` is read at call time, not module load time
- No changes to file formats — only locations change
- `docker-compose.yml` and `Dockerfile` require no edits (already correct)
- Unit test isolation: `template-store` tests pass explicit `storeDir`; `message-cache` tests use `:memory:` — neither touches the new default paths

---

### Task 1: Create `src/data-dir.ts` and its test

**Files:**
- Create: `src/data-dir.ts`
- Create: `src/data-dir.test.ts`

**Interfaces:**
- Produces:
  - `dataDir(): string` — returns `DATA_DIR` env var or `<cwd>/data`
  - `secretPath(): string` — `<dataDir>/secret`
  - `authDir(): string` — `<dataDir>/auth`
  - `templatesDir(): string` — `<dataDir>/templates`
  - `cacheDbPath(): string` — `<dataDir>/cache/messages.db`

- [ ] **Step 1: Write the failing test**

Create `src/data-dir.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

describe('data-dir helpers', () => {
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('dataDir defaults to <cwd>/data', async () => {
    const { dataDir } = await import('./data-dir');
    expect(dataDir()).toBe(path.join(process.cwd(), 'data'));
  });

  it('dataDir returns DATA_DIR when set', async () => {
    process.env.DATA_DIR = '/custom/data';
    const { dataDir } = await import('./data-dir');
    expect(dataDir()).toBe('/custom/data');
  });

  it('secretPath is <dataDir>/secret', async () => {
    process.env.DATA_DIR = '/d';
    const { secretPath } = await import('./data-dir');
    expect(secretPath()).toBe('/d/secret');
  });

  it('authDir is <dataDir>/auth', async () => {
    process.env.DATA_DIR = '/d';
    const { authDir } = await import('./data-dir');
    expect(authDir()).toBe('/d/auth');
  });

  it('templatesDir is <dataDir>/templates', async () => {
    process.env.DATA_DIR = '/d';
    const { templatesDir } = await import('./data-dir');
    expect(templatesDir()).toBe('/d/templates');
  });

  it('cacheDbPath is <dataDir>/cache/messages.db', async () => {
    process.env.DATA_DIR = '/d';
    const { cacheDbPath } = await import('./data-dir');
    expect(cacheDbPath()).toBe('/d/cache/messages.db');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/data-dir.test.ts
```

Expected: FAIL — `Cannot find module './data-dir'`

- [ ] **Step 3: Implement `src/data-dir.ts`**

```typescript
import * as path from 'path';

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

export const secretPath   = (): string => path.join(dataDir(), 'secret');
export const authDir      = (): string => path.join(dataDir(), 'auth');
export const templatesDir = (): string => path.join(dataDir(), 'templates');
export const cacheDbPath  = (): string => path.join(dataDir(), 'cache', 'messages.db');
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx vitest run src/data-dir.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/data-dir.ts src/data-dir.test.ts
git commit -m "feat: add data-dir module with centralized path helpers"
```

---

### Task 2: Update `src/oauth.ts` and `src/sync.ts`

**Files:**
- Modify: `src/oauth.ts`
- Modify: `src/sync.ts`

**Interfaces:**
- Consumes: `secretPath()`, `authDir()` from `src/data-dir.ts`

- [ ] **Step 1: Update imports and `loadOrCreateSecret`**

At the top of `src/oauth.ts`, add the import after the existing imports:

```typescript
import { secretPath, authDir as dataDirAuth } from './data-dir';
```

Replace the `loadOrCreateSecret` function (lines ~11–19):

```typescript
function loadOrCreateSecret(): string {
  const file = secretPath();
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, 'utf8');
    return secret;
  }
}
```

- [ ] **Step 2: Update `persistAuthData`**

Replace the body of `persistAuthData` (currently builds `baseDir` / `dir`):

```typescript
export function persistAuthData(authData: AuthData): void {
  if (!isSafeMid(authData.mid)) return;
  try {
    const dir = dataDirAuth();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const filePath = path.resolve(dir, `${authData.mid}.json`);
    fs.writeFileSync(filePath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[OAuth] Failed to persist auth for ${authData.mid}: ${err}\n`);
  }
}
```

- [ ] **Step 3: Update `loadAuthFromDisk`**

Replace the body of `loadAuthFromDisk`:

```typescript
export function loadAuthFromDisk(mid: string): AuthData | null {
  if (!isSafeMid(mid)) return null;
  try {
    const dir = dataDirAuth();
    const file = path.resolve(dir, `${mid}.json`);
    if (!file.startsWith(dir + path.sep)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const authData = JSON.parse(raw) as AuthData;
    if (!authData.mid || authData.mid !== mid || !authData.accessToken) return null;
    latestAuthData.set(mid, authData);
    return authData;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update `src/sync.ts`**

`sync.ts` line 26 has its own path fallback that ignores the `data/` default. Fix it to use `authDir()` from `data-dir`.

Add import at the top of `src/sync.ts` (after existing imports):

```typescript
import { authDir as getAuthDir } from './data-dir';
```

Replace line 26:

```typescript
const authDir = resolve(options.authDir ?? join(process.env.DATA_DIR ?? process.cwd(), 'auth'));
```

With:

```typescript
const authDir = resolve(options.authDir ?? getAuthDir());
```

Also remove the now-unused `join` import from `'path'` if `join` is no longer used elsewhere in the file (check: `join` also appears in `join(authDir, file)` on line 46, so keep it).

- [ ] **Step 5: Run unit tests**

```bash
npm run test:unit
```

Expected: all unit tests PASS (oauth tests exercise `validateBearerToken`, `seedTestToken`, and token flow — not file paths directly)

- [ ] **Step 6: Commit**

```bash
git add src/oauth.ts src/sync.ts
git commit -m "refactor: use data-dir helpers in oauth.ts and sync.ts"
```

---

### Task 3: Update `src/template-store.ts`

**Files:**
- Modify: `src/template-store.ts`

**Interfaces:**
- Consumes: `templatesDir()` from `src/data-dir.ts`

- [ ] **Step 1: Replace `DEFAULT_STORE_DIR` with lazy default**

At the top of `src/template-store.ts`, add the import:

```typescript
import { templatesDir } from './data-dir';
```

Remove this line:

```typescript
const DEFAULT_STORE_DIR = join(process.cwd(), '.line-templates');
```

In all four exported functions, replace `storeDir = DEFAULT_STORE_DIR` with `storeDir = templatesDir()`:

```typescript
export function loadTemplates(
  chatMid: string,
  storeDir = templatesDir(),
): { templates: NamedTemplate[]; warning?: string } {
```

```typescript
export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir = templatesDir()): void {
```

```typescript
export function deleteTemplate(chatMid: string, name: string, storeDir = templatesDir()): boolean {
```

```typescript
export function listTemplates(chatMid: string, storeDir = templatesDir()): NamedTemplate[] {
```

- [ ] **Step 2: Run unit tests**

```bash
npm run test:unit
```

Expected: all unit tests PASS (template-store tests all pass an explicit `storeDir` from `mkdtempSync`, so the default is never used in tests)

- [ ] **Step 3: Commit**

```bash
git add src/template-store.ts
git commit -m "refactor: use data-dir templatesDir() default in template-store"
```

---

### Task 4: Update `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `cacheDbPath()` from `src/data-dir.ts`

- [ ] **Step 1: Update the `MessageCache` initialization**

Add to the imports at the top of `src/index.ts`:

```typescript
import { cacheDbPath } from './data-dir';
```

Find the line in `main()` (around line 650):

```typescript
sharedCache = new MessageCache('.line-cache/messages.db');
```

Replace with:

```typescript
sharedCache = new MessageCache(cacheDbPath());
```

- [ ] **Step 2: Update tool description strings**

Find and update the two description strings that mention `.line-templates/<chatMid>.json`:

In `manage_templates` description (around line 152):
```typescript
'Templates are persisted in .line-templates/<chatMid>.json and auto-loaded by get_transactions. ' +
```
Change to:
```typescript
'Templates are persisted in data/templates/<chatMid>.json and auto-loaded by get_transactions. ' +
```

In `get_transactions` description (around line 347):
```typescript
'If templates is omitted, saved templates for this chat are loaded automatically from .line-templates/<chatMid>.json ' +
```
Change to:
```typescript
'If templates is omitted, saved templates for this chat are loaded automatically from data/templates/<chatMid>.json ' +
```

- [ ] **Step 3: Run unit tests**

```bash
npm run test:unit
```

Expected: all unit tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: use cacheDbPath() for MessageCache in index.ts, update description strings"
```

---

### Task 5: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Replace old entries with `data/`**

Find the "LINE auth token cache" block in `.gitignore`:

```
# LINE auth token cache
.line-auth.json
.line-mcp-tokens.json
.line-mcp-secret
line-qr.png
auth/

# LINE MCP saved templates
.line-templates/

# LINE MCP message cache (SQLite)
.line-cache/
```

Replace with:

```
# LINE auth token cache
.line-auth.json
.line-mcp-tokens.json
line-qr.png

# LINE MCP runtime data (secret, auth, templates, cache)
data/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: update .gitignore for new data/ directory layout"
```

---

### Task 6: Smoke test

**Files:** none modified

- [ ] **Step 1: Run all unit tests**

```bash
npm run test:unit
```

Expected: all tests PASS

- [ ] **Step 2: Start the server and verify `data/` is created**

```bash
npm start &
sleep 2
ls data/
kill %1
```

Expected output includes `secret` and `cache/` (created on first run). If `data/` was not pre-created, the server should create it automatically.

- [ ] **Step 3: Verify cache subdirectory**

```bash
ls data/cache/
```

Expected: `messages.db`

- [ ] **Step 4: Manual migration (one-time, if you have existing data)**

```bash
mkdir -p data/auth data/templates data/cache
[ -f .line-mcp-secret ] && cp .line-mcp-secret data/secret
[ -d auth ] && cp auth/*.json data/auth/ 2>/dev/null || true
[ -d .line-templates ] && cp .line-templates/*.json data/templates/ 2>/dev/null || true
[ -f .line-cache/messages.db ] && cp .line-cache/messages.db data/cache/ || true
```

- [ ] **Step 5: Run e2e tests**

```bash
npm run test:e2e
```

Expected: all e2e tests PASS (they seed the token directly and don't exercise file paths)
