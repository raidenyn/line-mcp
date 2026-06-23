# Daily Message Sync Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process daily sync loop that tops up the SQLite message cache for all previously-accessed chats so that no messages are lost during long idle periods.

**Architecture:** A new `sync.ts` module exports `syncAll(cache, options?)` and `startSyncLoop(cache, intervalMs?)`. On startup, `main()` in `index.ts` calls `startSyncLoop(sharedCache)`, which runs `syncAll` immediately and then every 24 hours via `setInterval`. `syncAll` scans `auth/<mid>.json` files to discover authenticated users, queries the cache for previously-accessed chat MIDs, and calls `CachingLineClient.getMessagesInRange` for each — using the same client stack as normal tool calls. Errors are caught per chat and logged; the loop is never interrupted.

**Tech Stack:** TypeScript, `better-sqlite3` (existing), `vitest` for tests

## Global Constraints

- Run `npm run test:unit` (vitest running `src/**`) after each task — all tests must pass before committing
- Log to `process.stderr` with the `[sync]` prefix; no `console.log`
- Follow existing code style: no inline comments unless the WHY is non-obvious
- The `sync.ts` module must not import from `index.ts` (no circular deps)

---

### Task 1: Add `getDistinctChatMids()` to `MessageCache`

**Files:**
- Modify: `src/message-cache.ts`
- Test: `src/message-cache.test.ts`

**Interfaces:**
- Produces: `MessageCache.getDistinctChatMids(): string[]` — used by `syncAll` in Task 2

- [ ] **Step 1: Write the failing test**

Add to the bottom of `src/message-cache.test.ts`:

```typescript
describe('MessageCache.getDistinctChatMids', () => {
  it('returns empty array when cache is empty', () => {
    const cache = new MessageCache(':memory:');
    expect(cache.getDistinctChatMids()).toEqual([]);
  });

  it('returns each chat mid exactly once', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);
    cache.upsertMessages('chat1', [msg('3', '3000')]); // second insert for chat1
    const mids = cache.getDistinctChatMids();
    expect(mids.sort()).toEqual(['chat1', 'chat2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/message-cache.test.ts
```

Expected: FAIL with `cache.getDistinctChatMids is not a function`

- [ ] **Step 3: Implement the method**

Add after `latestTimestamp` in `src/message-cache.ts`:

```typescript
getDistinctChatMids(): string[] {
  const rows = this.db.prepare('SELECT DISTINCT chat_mid FROM messages').all() as { chat_mid: string }[];
  return rows.map(r => r.chat_mid);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/message-cache.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/message-cache.ts src/message-cache.test.ts
git commit -m "feat: add getDistinctChatMids() to MessageCache"
```

---

### Task 2: Implement `src/sync.ts`

**Files:**
- Create: `src/sync.ts`
- Create: `src/sync.test.ts`

**Interfaces:**
- Consumes: `MessageCache.getDistinctChatMids(): string[]` (Task 1), `CachingLineClient.getMessagesInRange(chatMid, sinceMs): Promise<Message[]>`, `AuthData` from `./line-client`, `LineClient` from `./line-client`, `MessageCache` from `./message-cache`, `CachingLineClient` from `./caching-line-client`
- Produces:
  - `syncAll(cache: MessageCache, options?: SyncOptions): Promise<void>` — one full sync pass
  - `startSyncLoop(cache: MessageCache, intervalMs?: number): ReturnType<typeof setInterval>` — starts the repeating loop

- [ ] **Step 1: Write the failing tests**

Create `src/sync.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MessageCache } from './message-cache';
import { syncAll, startSyncLoop } from './sync';
import type { AuthData } from './line-client';

function msg(id: string, createdTime: string) {
  return { id, from: 'u1', to: 'chat1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

function makeAuthDir(authData: AuthData): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  writeFileSync(join(dir, `${authData.mid}.json`), JSON.stringify(authData));
  return dir;
}

const TEST_AUTH: AuthData = {
  mid: 'u123',
  accessToken: 'tok',
  refreshToken: 'ref',
  certificate: 'cert',
  wrappedNonce: 'nonce',
  kdfParameter1: 'kdf1',
  kdfParameter2: 'kdf2',
};

describe('syncAll', () => {
  it('calls getMessagesInRange for each previously-accessed chat', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);

    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).toHaveBeenCalledWith(TEST_AUTH, cache);
    expect(getMessagesInRange).toHaveBeenCalledWith('chat1', 0);
    expect(getMessagesInRange).toHaveBeenCalledWith('chat2', 0);
  });

  it('does not throw when auth dir is missing', async () => {
    const cache = new MessageCache(':memory:');
    await expect(syncAll(cache, { authDir: '/nonexistent/auth' })).resolves.not.toThrow();
  });

  it('continues syncing other chats when one chat fails', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);

    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn()
      .mockRejectedValueOnce(new Error('LINE API error'))
      .mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await expect(syncAll(cache, { authDir, makeClient })).resolves.not.toThrow();
    expect(getMessagesInRange).toHaveBeenCalledTimes(2);
  });

  it('skips mid if auth file contains invalid JSON', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);

    const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
    writeFileSync(join(authDir, 'badusr.json'), 'not-json');
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange: vi.fn() });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).not.toHaveBeenCalled();
  });

  it('does nothing when cache has no previously-accessed chats', async () => {
    const cache = new MessageCache(':memory:');
    const authDir = makeAuthDir(TEST_AUTH);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange: vi.fn() });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).not.toHaveBeenCalled();
  });
});

describe('startSyncLoop', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs syncAll immediately on start', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    const handle = startSyncLoop(cache, 100_000, { authDir, makeClient });
    // wait for the immediate async call to complete
    await new Promise(r => setTimeout(r, 50));
    clearInterval(handle);

    expect(getMessagesInRange).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/sync.test.ts
```

Expected: FAIL with `Cannot find module './sync'`

- [ ] **Step 3: Implement `src/sync.ts`**

Create `src/sync.ts`:

```typescript
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { AuthData, LineClient } from './line-client';
import { MessageCache } from './message-cache';
import { CachingLineClient } from './caching-line-client';

type SyncClient = { getMessagesInRange(chatMid: string, sinceMs: number): Promise<unknown> };
type MakeClient = (authData: AuthData, cache: MessageCache) => SyncClient;

const defaultMakeClient: MakeClient = (authData, cache) =>
  new CachingLineClient(new LineClient(authData, globalThis.fetch, () => {}), cache);

export interface SyncOptions {
  authDir?: string;
  makeClient?: MakeClient;
}

export async function syncAll(cache: MessageCache, options: SyncOptions = {}): Promise<void> {
  const authDir = resolve(options.authDir ?? join(process.env.DATA_DIR ?? process.cwd(), 'auth'));
  const makeClient = options.makeClient ?? defaultMakeClient;

  let files: string[];
  try {
    files = readdirSync(authDir).filter(f => f.endsWith('.json'));
  } catch {
    process.stderr.write('[sync] auth dir not found or unreadable, skipping\n');
    return;
  }

  const chatMids = cache.getDistinctChatMids();
  if (chatMids.length === 0) return;

  for (const file of files) {
    const mid = file.slice(0, -5);
    if (!/^[A-Za-z0-9_-]+$/.test(mid)) continue;

    let authData: AuthData;
    try {
      authData = JSON.parse(readFileSync(join(authDir, file), 'utf8')) as AuthData;
    } catch {
      process.stderr.write(`[sync] Failed to load auth for ${mid}, skipping\n`);
      continue;
    }

    const client = makeClient(authData, cache);
    let synced = 0;
    let errors = 0;

    for (const chatMid of chatMids) {
      try {
        await client.getMessagesInRange(chatMid, 0);
        synced++;
      } catch (err) {
        process.stderr.write(`[sync] Error syncing ${chatMid} for ${mid}: ${(err as Error).message}\n`);
        errors++;
      }
    }

    process.stderr.write(`[sync] mid=${mid}: ${synced} chats synced, ${errors} errors\n`);
  }
}

export function startSyncLoop(
  cache: MessageCache,
  intervalMs = 24 * 60 * 60 * 1000,
  options: SyncOptions = {},
): ReturnType<typeof setInterval> {
  process.stderr.write(`[sync] Starting daily sync loop (interval: ${Math.round(intervalMs / 3_600_000)}h)\n`);
  const run = () => syncAll(cache, options).catch(err =>
    process.stderr.write(`[sync] Unexpected error: ${(err as Error).message}\n`),
  );
  run();
  return setInterval(run, intervalMs);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/sync.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Run full unit test suite**

```bash
npm run test:unit
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/sync.ts src/sync.test.ts
git commit -m "feat: add daily sync loop — syncAll and startSyncLoop"
```

---

### Task 3: Wire `startSyncLoop` into `main()`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `startSyncLoop(cache, intervalMs?, options?)` from `./sync` (Task 2), `sharedCache: MessageCache` (already exists in `main()`)

- [ ] **Step 1: Add the import**

At the top of `src/index.ts`, add after the existing imports:

```typescript
import { startSyncLoop } from './sync';
```

- [ ] **Step 2: Call `startSyncLoop` in `main()`**

In `src/index.ts`, find the `main()` function. After `sharedCache = new MessageCache(...)` and before `app.listen(...)`, add:

```typescript
startSyncLoop(sharedCache);
```

The `main()` body should look like:

```typescript
async function main() {
  sharedCache = new MessageCache('.line-cache/messages.db');
  startSyncLoop(sharedCache);
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  // ... rest unchanged
```

- [ ] **Step 3: Run full unit test suite**

```bash
npm run test:unit
```

Expected: all tests PASS

- [ ] **Step 4: Verify startup log**

```bash
npm start 2>&1 | head -5
```

Expected: output includes `[sync] Starting daily sync loop (interval: 24h)`

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire startSyncLoop into server startup"
```
