# Message Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache all LINE messages in a local SQLite database so history beyond the ~2-week LINE API window is accessible on future reads.

**Architecture:** A `MessageCache` class wraps SQLite (one `messages` table, upsert by message ID). A `CachingLineClient` wraps the existing `LineClient` — on every `getMessages`/`getMessagesInRange` call it fetches only messages newer than the latest cached entry, writes them to SQLite, then reads the full requested range back from cache. `index.ts` initialises `MessageCache` once at startup and creates a `CachingLineClient` per request; tool handlers are unchanged.

**Tech Stack:** TypeScript, `better-sqlite3` (synchronous SQLite), Vitest.

## Global Constraints

- Node 20+; TypeScript strict mode (existing project setting).
- `better-sqlite3` uses synchronous APIs — no `await` inside `MessageCache`.
- SQLite file lives at `.line-cache/messages.db`; the directory is created automatically on first run.
- `:memory:` is a valid `dbPath` for tests (skip `mkdirSync` in that case).
- All new test files go under `src/` to be picked up by `vitest.config.ts` (`include: ['src/**/*.test.ts']`).
- `Message.createdTime` is a **string** representing Unix milliseconds — always `parseInt(m.createdTime, 10)` before storing.

---

### Task 1: Install `better-sqlite3` and update `.gitignore`

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install dependencies**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

Expected: `package.json` `dependencies` gains `"better-sqlite3"` and `devDependencies` gains `"@types/better-sqlite3"`.

- [ ] **Step 2: Add `.line-cache/` to `.gitignore`**

Open `.gitignore` and add after the `.line-templates/` entry:

```
# LINE MCP message cache (SQLite)
.line-cache/
```

- [ ] **Step 3: Verify TypeScript can see the types**

```bash
npx tsc --noEmit
```

Expected: no errors (project compiles clean before any new code is added).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: add better-sqlite3 for message cache"
```

---

### Task 2: Implement `MessageCache`

**Files:**
- Create: `src/message-cache.ts`
- Create: `src/message-cache.test.ts`

**Interfaces:**
- Consumes: `Message` from `./line-client`
- Produces:
  - `class MessageCache { constructor(dbPath: string) }`
  - `upsertMessages(chatMid: string, messages: Message[]): void`
  - `getMessages(chatMid: string, sinceMs?: number, untilMs?: number): Message[]` — oldest-first
  - `latestTimestamp(chatMid: string): number | null`

- [ ] **Step 1: Write the failing tests**

Create `src/message-cache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MessageCache } from './message-cache';
import type { Message } from './line-client';

function msg(id: string, createdTime: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

describe('MessageCache.getMessages', () => {
  it('returns empty array for unknown chat', () => {
    const cache = new MessageCache(':memory:');
    expect(cache.getMessages('chat1')).toEqual([]);
  });

  it('returns messages oldest-first', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('2', '2000'), msg('1', '1000')]);
    expect(cache.getMessages('chat1').map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by sinceMs (inclusive)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', 2000).map(m => m.id)).toEqual(['2', '3']);
  });

  it('filters by untilMs (inclusive)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', undefined, 2000).map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by both sinceMs and untilMs', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', 1500, 2500).map(m => m.id)).toEqual(['2']);
  });

  it('isolates messages by chatMid', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);
    expect(cache.getMessages('chat1').map(m => m.id)).toEqual(['1']);
    expect(cache.getMessages('chat2').map(m => m.id)).toEqual(['2']);
  });
});

describe('MessageCache.upsertMessages', () => {
  it('deduplicates on re-insert (same message_id)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    expect(cache.getMessages('chat1')).toHaveLength(1);
  });

  it('no-ops on empty array', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', []);
    expect(cache.getMessages('chat1')).toEqual([]);
  });
});

describe('MessageCache.latestTimestamp', () => {
  it('returns null for empty cache', () => {
    const cache = new MessageCache(':memory:');
    expect(cache.latestTimestamp('chat1')).toBeNull();
  });

  it('returns highest createdTime as number', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('3', '3000'), msg('2', '2000')]);
    expect(cache.latestTimestamp('chat1')).toBe(3000);
  });

  it('is scoped per chatMid', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '9000')]);
    expect(cache.latestTimestamp('chat1')).toBe(1000);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/message-cache.test.ts
```

Expected: FAIL with `Cannot find module './message-cache'`.

- [ ] **Step 3: Implement `MessageCache`**

Create `src/message-cache.ts`:

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Message } from './line-client';

export class MessageCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_mid     TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        created_time INTEGER NOT NULL,
        raw_json     TEXT    NOT NULL,
        PRIMARY KEY (chat_mid, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time
        ON messages (chat_mid, created_time);
    `);
  }

  upsertMessages(chatMid: string, messages: Message[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO messages (chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?)',
    );
    const insertAll = this.db.transaction((msgs: Message[]) => {
      for (const m of msgs) {
        stmt.run(chatMid, m.id, parseInt(m.createdTime, 10), JSON.stringify(m));
      }
    });
    insertAll(messages);
  }

  getMessages(chatMid: string, sinceMs?: number, untilMs?: number): Message[] {
    const conditions = ['chat_mid = ?'];
    const params: unknown[] = [chatMid];
    if (sinceMs != null) { conditions.push('created_time >= ?'); params.push(sinceMs); }
    if (untilMs != null) { conditions.push('created_time <= ?'); params.push(untilMs); }
    const sql = `SELECT raw_json FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_time ASC`;
    const rows = (this.db.prepare(sql).all(...params)) as { raw_json: string }[];
    return rows.map(r => JSON.parse(r.raw_json) as Message);
  }

  latestTimestamp(chatMid: string): number | null {
    const row = this.db.prepare(
      'SELECT MAX(created_time) as ts FROM messages WHERE chat_mid = ?',
    ).get(chatMid) as { ts: number | null };
    return row.ts ?? null;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/message-cache.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/message-cache.ts src/message-cache.test.ts
git commit -m "feat: add MessageCache (SQLite-backed message store)"
```

---

### Task 3: Implement `CachingLineClient`

**Files:**
- Create: `src/caching-line-client.ts`
- Create: `src/caching-line-client.test.ts`

**Interfaces:**
- Consumes:
  - `LineClient` from `./line-client` (inner client, created per request in `index.ts`)
  - `MessageCache` from `./message-cache`
- Produces:
  - `class CachingLineClient { constructor(inner: LineClient, cache: MessageCache) }`
  - `getMessages(chatMid: string, count?: number, resolveNames?: boolean): Promise<Message[]>`
  - `getMessagesInRange(chatMid: string, sinceMs: number, resolveNames?: boolean, pageSize?: number): Promise<Message[]>`
  - `listChats()`, `getImageBuffer(url)`, `waitForPin()`, `waitForCompletion()`, `getCompletedAuth()` — all forwarded directly to inner

- [ ] **Step 1: Write the failing tests**

Create `src/caching-line-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CachingLineClient } from './caching-line-client';
import { MessageCache } from './message-cache';
import type { Message } from './line-client';

function msg(id: string, createdTime: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

function makeMockInner(liveMessages: Message[] = []) {
  return {
    getMessages: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
    getMessagesInRange: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
    listChats: vi.fn().mockResolvedValue([]),
    getImageBuffer: vi.fn().mockResolvedValue({ buffer: Buffer.from(''), mimeType: 'image/jpeg' }),
    waitForPin: vi.fn().mockResolvedValue(null),
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    getCompletedAuth: vi.fn().mockReturnValue(null),
  };
}

describe('CachingLineClient.getMessages', () => {
  it('calls getMessagesInRange on inner with latestTimestamp when cache has data', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    const inner = makeMockInner([msg('2', '2000')]);
    const client = new CachingLineClient(inner as any, cache);

    await client.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 1000, true);
  });

  it('calls getMessagesInRange on inner with 0 when cache is empty', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as any, cache);

    await client.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 0, true);
  });

  it('writes live messages to cache', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as any, cache);

    await client.getMessages('chat1', 10);
    expect(cache.getMessages('chat1').map(m => m.id)).toEqual(['1']);
  });

  it('skips upsert when live returns empty', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    const inner = makeMockInner([]);
    const upsertSpy = vi.spyOn(cache, 'upsertMessages');
    const client = new CachingLineClient(inner as any, cache);

    await client.getMessages('chat1', 10);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('returns newest `count` messages from cache', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    const inner = makeMockInner([]);
    const client = new CachingLineClient(inner as any, cache);

    const result = await client.getMessages('chat1', 2);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });
});

describe('CachingLineClient.getMessagesInRange', () => {
  it('fetches live from latestTimestamp and reads cache from sinceMs', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '3000')]);
    const inner = makeMockInner([msg('3', '5000')]);
    const client = new CachingLineClient(inner as any, cache);

    const result = await client.getMessagesInRange('chat1', 2000);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 3000, true, 200);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });

  it('on empty cache fetches from 0', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as any, cache);

    await client.getMessagesInRange('chat1', 500);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 0, true, 200);
  });

  it('returns messages from sinceMs even when LINE returns nothing new', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000')]);
    const inner = makeMockInner([]);
    const client = new CachingLineClient(inner as any, cache);

    const result = await client.getMessagesInRange('chat1', 1500);
    expect(result.map(m => m.id)).toEqual(['2']);
  });
});

describe('CachingLineClient forwarded methods', () => {
  it('forwards listChats', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));
    await client.listChats();
    expect(inner.listChats).toHaveBeenCalledOnce();
  });

  it('forwards getImageBuffer', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));
    await client.getImageBuffer('http://example.com/img.jpg');
    expect(inner.getImageBuffer).toHaveBeenCalledWith('http://example.com/img.jpg');
  });

  it('forwards waitForPin', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));
    await client.waitForPin();
    expect(inner.waitForPin).toHaveBeenCalledOnce();
  });

  it('forwards waitForCompletion', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));
    await client.waitForCompletion();
    expect(inner.waitForCompletion).toHaveBeenCalledOnce();
  });

  it('forwards getCompletedAuth', () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));
    client.getCompletedAuth();
    expect(inner.getCompletedAuth).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/caching-line-client.test.ts
```

Expected: FAIL with `Cannot find module './caching-line-client'`.

- [ ] **Step 3: Implement `CachingLineClient`**

Create `src/caching-line-client.ts`:

```ts
import type { LineClient, Message } from './line-client';
import type { MessageCache } from './message-cache';

export class CachingLineClient {
  constructor(private inner: LineClient, private cache: MessageCache) {}

  async getMessages(chatMid: string, count = 50, resolveNames = true): Promise<Message[]> {
    const latestMs = this.cache.latestTimestamp(chatMid);
    const live = await this.inner.getMessagesInRange(chatMid, latestMs ?? 0, resolveNames);
    if (live.length > 0) this.cache.upsertMessages(chatMid, live);
    const all = this.cache.getMessages(chatMid);
    return all.slice(-count);
  }

  async getMessagesInRange(
    chatMid: string,
    sinceMs: number,
    resolveNames = true,
    pageSize = 200,
  ): Promise<Message[]> {
    const latestMs = this.cache.latestTimestamp(chatMid);
    const live = await this.inner.getMessagesInRange(chatMid, latestMs ?? 0, resolveNames, pageSize);
    if (live.length > 0) this.cache.upsertMessages(chatMid, live);
    return this.cache.getMessages(chatMid, sinceMs);
  }

  listChats() { return this.inner.listChats(); }
  getImageBuffer(url: string) { return this.inner.getImageBuffer(url); }
  waitForPin() { return this.inner.waitForPin(); }
  waitForCompletion() { return this.inner.waitForCompletion(); }
  getCompletedAuth() { return this.inner.getCompletedAuth(); }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/caching-line-client.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/caching-line-client.ts src/caching-line-client.test.ts
git commit -m "feat: add CachingLineClient wrapping LineClient with SQLite cache"
```

---

### Task 4: Wire `CachingLineClient` into `index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes:
  - `CachingLineClient` from `./caching-line-client`
  - `MessageCache` from `./message-cache`

`makeLineClient` is called per tool invocation (once per MCP request). `MessageCache` must be initialised once at server startup in `main()` and captured in a module-level variable so all per-request `CachingLineClient` instances share one SQLite connection.

- [ ] **Step 1: Add imports to `src/index.ts`**

At the top of `src/index.ts`, after the existing imports, add:

```ts
import { CachingLineClient } from './caching-line-client';
import { MessageCache } from './message-cache';
```

- [ ] **Step 2: Add module-level `sharedCache` variable**

After line `const authStore = new AsyncLocalStorage<AuthData>();`, add:

```ts
let sharedCache: MessageCache;
```

- [ ] **Step 3: Initialise `sharedCache` in `main()`**

In the `main()` function, add the first line (before `seedTestToken()`):

```ts
async function main() {
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  const WWW_AUTH = makeWwwAuthenticate(PORT);
  sharedCache = new MessageCache('.line-cache/messages.db');  // add this line
  seedTestToken();
  // ... rest unchanged
```

- [ ] **Step 4: Update `makeLineClient` to return `CachingLineClient`**

Replace the existing `makeLineClient` function (currently returns `LineClient`) with:

```ts
function makeLineClient(authData: AuthData): CachingLineClient {
  return new CachingLineClient(
    new LineClient(authData, globalThis.fetch, () => {
      latestAuthData.set(authData.mid, authData);
      persistAuthData(authData);
    }),
    sharedCache,
  );
}
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors. (All call sites use `client.getMessages`, `client.getMessagesInRange`, `client.listChats`, `client.getImageBuffer` — `CachingLineClient` exposes all of these with identical signatures.)

- [ ] **Step 6: Run all unit tests**

```bash
npm run test:unit
```

Expected: all tests PASS including the new `message-cache` and `caching-line-client` suites.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire CachingLineClient into index.ts — all reads now auto-cache to SQLite"
```
