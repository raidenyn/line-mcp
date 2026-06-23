# Daily Message Sync Scheduler — Design Spec

**Date:** 2026-06-23
**Status:** Approved

## Problem

LINE's API does not return messages beyond a certain historical limit. If no tool calls are made for an extended period, new messages accumulate beyond that limit and are permanently lost to the cache. A daily background sync ensures the SQLite cache stays current regardless of tool call frequency.

## Scope

- Sync messages for all previously-accessed chats (chats that already have at least one entry in the SQLite cache)
- Run as an in-process background timer inside the existing server process
- Support all authenticated users (each `auth/<mid>.json` file on disk represents one user)

## Architecture

A new `src/sync.ts` module is the only new file. It exports two functions:

- `syncAll(cache, authDir?)` — performs one full sync pass across all users and their previously-accessed chats
- `startSyncLoop(cache, intervalMs?)` — calls `syncAll()` immediately, then repeats on a `setInterval`

`main()` in `index.ts` calls `startSyncLoop(sharedCache)` after `sharedCache` is initialized, before `app.listen()`. Default interval is 24 hours.

No other files are introduced. `message-cache.ts` gains one small method; `index.ts` gains one call in `main()`.

## Data Flow

For each sync run, `syncAll()` does the following:

1. **Discover users** — scan the `auth/` directory (respecting `DATA_DIR` env var) for `<mid>.json` files
2. **Load auth** — call `loadAuthFromDisk(mid)` for each mid; skip if it returns null
3. **Discover chats** — call `cache.getDistinctChatMids(mid)` to get the list of previously-accessed chat MIDs for this user (new method, see below)
4. **Sync each chat** — create a `CachingLineClient` (same factory as tool calls) and call `getMessagesInRange(chatMid, latestTimestamp ?? 0)`, which tops up the cache from the last stored message to now
5. **Log and continue** — catch errors per chat, log them, and proceed to the next

## MessageCache Changes

Add one method to `MessageCache`:

```ts
getDistinctChatMids(): string[]
```

Executes `SELECT DISTINCT chat_mid FROM messages` and returns the results. No filtering by user — the cache is currently single-user per server instance, but this keeps the query simple. (If multi-user isolation is needed later, a `user_mid` column can be added to the schema.)

## Error Handling

- Each chat sync is wrapped in `try/catch`; errors are logged to stderr with a `[sync]` prefix and the affected chat mid
- Token refresh errors surface at the chat level and are caught there — other chats for the same user continue
- A failed `syncAll()` does not stop the `setInterval`; the next daily run fires regardless
- No within-run retry — failed chats are retried in the next daily cycle
- Log lines:
  - Startup: `[sync] Starting daily sync loop (interval: 24h)`
  - Per-run summary: `[sync] Run complete — N chats synced, M errors`
  - Per-chat error: `[sync] Error syncing <chatMid> for <mid>: <message>`

## Testing

- `syncAll()` is exported and can be called directly in tests without starting the loop
- `startSyncLoop(cache, intervalMs)` accepts a short interval (e.g., 100ms) for unit tests — no timer mocking needed
- `getDistinctChatMids()` gets a unit test in `message-cache.test.ts` alongside existing cache tests
- Tests point `authDir` to a temp directory with fixture `<mid>.json` files (follows the existing `DATA_DIR` convention)
- No new e2e test required — the underlying sync path (`getMessagesInRange` → cache upsert) is covered by existing tests

## Files Changed

| File | Change |
|------|--------|
| `src/sync.ts` | New — exports `syncAll` and `startSyncLoop` |
| `src/message-cache.ts` | Add `getDistinctChatMids()` method |
| `src/index.ts` | Call `startSyncLoop(sharedCache)` in `main()` |
