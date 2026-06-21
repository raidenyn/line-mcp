# Message Cache Design

**Date:** 2026-06-21
**Status:** Approved

## Problem

The LINE API exposes only a limited window of history (roughly 2 weeks). Calls to `getMessagesInRange` with a `since` date older than that window silently return nothing for that period, making transaction parsing and message search over longer periods impossible.

## Goal

Cache every message fetched from LINE into a local SQLite database so that future reads can serve the full history, including periods the LINE API no longer exposes. Caching is automatic, universal (all chats), and invisible to callers.

## Architecture

Three components:

1. `src/message-cache.ts` — SQLite wrapper (`MessageCache` class)
2. `src/caching-line-client.ts` — `CachingLineClient` wrapper class
3. `src/index.ts` — wires the two together; no other changes to tool handlers

---

## Component 1: `MessageCache` (`src/message-cache.ts`)

Wraps a single SQLite file at `.line-cache/messages.db`. The directory is created on first run if absent.

### Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  chat_mid     TEXT    NOT NULL,
  message_id   TEXT    NOT NULL,
  created_time INTEGER NOT NULL,  -- Unix ms
  raw_json     TEXT    NOT NULL,  -- full Message object as JSON
  PRIMARY KEY (chat_mid, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time
  ON messages (chat_mid, created_time);
```

`INSERT OR REPLACE` is used for upserts so re-fetched messages never produce duplicates.

### Public API

```ts
class MessageCache {
  constructor(dbPath: string)

  upsertMessages(chatMid: string, messages: Message[]): void
  getMessages(chatMid: string, sinceMs?: number, untilMs?: number): Message[]
  latestTimestamp(chatMid: string): number | null  // null if no cached messages
}
```

- `getMessages` returns messages ordered oldest-first (ascending `created_time`).
- `latestTimestamp` returns the highest `created_time` for the chat, used by `CachingLineClient` to know where live fetching should start.

---

## Component 2: `CachingLineClient` (`src/caching-line-client.ts`)

Wraps a `LineClient` instance. All methods are forwarded to the inner client except `getMessages` and `getMessagesInRange`, which are replaced with cache-aware versions.

### Constructor

```ts
class CachingLineClient {
  constructor(inner: LineClient, cache: MessageCache)
}
```

### `getMessages(chatMid, count, resolveNames)`

1. Get `latestMs = cache.latestTimestamp(chatMid)`.
2. Fetch live: `inner.getMessagesInRange(chatMid, latestMs ?? 0)` — returns all messages newer than the last cached entry (or everything if the cache is empty).
3. Write live results to cache via `cache.upsertMessages()`.
4. Read back from cache: `cache.getMessages(chatMid)`, sorted oldest-first; take the last `count` entries (newest).
5. Return.

On first call for a chat the cache is empty, so step 2 fetches as far back as LINE allows and primes the cache.

### `getMessagesInRange(chatMid, sinceMs, resolveNames, pageSize)`

1. Get `latestMs = cache.latestTimestamp(chatMid)`.
2. Fetch live: `inner.getMessagesInRange(chatMid, latestMs ?? 0)` — fetches only messages newer than the latest cached entry, avoiding re-fetching already-cached history. Write results to cache.
3. Read `cache.getMessages(chatMid, sinceMs)` — spans as far back as the cache holds, covering gaps the LINE API can no longer reach.
4. Return.

### Forwarded methods (no cache involvement)

- `listChats()`
- `getImageBuffer(url)`
- `waitForPin()`
- `waitForCompletion()`
- `getCompletedAuth()`

---

## Component 3: Wiring in `index.ts`

Replace the `makeLineClient(...)` call with:

```ts
const lineClient = makeLineClient({ onTokenRefreshed: ... });
const cache = new MessageCache('.line-cache/messages.db');
const client = new CachingLineClient(lineClient, cache);
```

`client` is then used by all tool handlers exactly as before — same method names, same signatures. No changes to any tool handler logic.

---

## Storage

- Database file: `.line-cache/messages.db` (added to `.gitignore`)
- Dependency: `better-sqlite3` (synchronous SQLite bindings for Node.js; `@types/better-sqlite3` for TypeScript)

---

## Error Handling

- If SQLite operations fail (disk full, corrupt DB), the error propagates up and the MCP tool returns an error to the caller. No silent fallback — a failing cache should be visible.
- If the LINE API fails during the live-fetch step, the error propagates as before; no partial cache writes occur (the upsert only runs after a successful fetch).

---

## Testing

- Unit tests for `MessageCache` in `src/message-cache.test.ts`: upsert deduplication, range queries, `latestTimestamp` edge cases. Use an in-memory SQLite path (`:memory:`) for isolation.
- Unit tests for `CachingLineClient` in `src/caching-line-client.test.ts`: mock `LineClient` and `MessageCache`; verify cache-first behavior, live top-up, and correct forwarding of non-message methods.
- Existing e2e tests (`tests/e2e.test.ts`) continue to pass unchanged since `CachingLineClient` presents the same interface.
