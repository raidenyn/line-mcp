# Pagination Design — Fetch All Messages for a Time Range

**Date:** 2026-06-21  
**Status:** Approved

## Problem

LINE's `getRecentMessagesV2` API returns at most 200 messages (the newest N). When `get_transactions` or `sample_messages` is asked for a month-range, any messages older than the 200-message window are silently missing, producing incomplete transaction lists.

LINE provides a cursor-based pagination endpoint (`getPreviousMessagesV2WithRequest`) that fetches messages older than a given message ID. This design adds support for it.

## Architecture

### `LineClient` refactor (`src/line-client.ts`)

Four private helpers are extracted from `getMessages` to eliminate duplication:

- **`fetchRawPage(chatMid, count)`** — calls `getRecentMessagesV2`; returns raw array.
- **`fetchPreviousRawPage(chatMid, endMessageId: { messageId: string; deliveredTime: string }, count)`** — calls `getPreviousMessagesV2WithRequest`; returns raw array of messages older than `endMessageId`.
- **`resolveContactNames(mids: string[])`** — fetches display names for unknown mids into `contactNameCache`; extracted from the inline block in `getMessages`.
- **`mapRawMessages(raw[])`** — converts raw LINE objects to the `Message` interface; extracted from the `.map()` call in `getMessages`.

`getMessages` is rewired to use these helpers with no change to its public API or behavior.

New public method added:

```typescript
async getMessagesInRange(chatMid: string, sinceMs: number, resolveNames = true): Promise<Message[]>
```

**Algorithm:**
1. Calls `ensureAuthenticated()` once.
2. Fetches first page via `fetchRawPage(chatMid, 200)`.
3. Loops: if the oldest message in the current page has `createdTime >= sinceMs`, fetches the next page via `fetchPreviousRawPage` using `{ messageId: oldest.id, deliveredTime: oldest.createdTime }`.
4. Stops when the oldest message in a page has `createdTime < sinceMs`, or the page returns fewer messages than requested (end of history).
5. Filters accumulated raw messages to `createdTime >= sinceMs`.
6. If `resolveNames`, resolves contact names once across all accumulated messages.
7. Maps and returns.

No artificial page cap — fetches until `sinceMs` is reached or history is exhausted.

### Tool layer changes (`src/index.ts`)

**`get_transactions`:**
- The `limit` parameter is removed (it was a workaround for the 200-message cap).
- When `since` is provided: calls `getMessagesInRange(chatMid, sinceMs)`.
- When `since` is omitted: falls back to `getMessages(chatMid, 200)` with a hint in the response encouraging `since` for complete results.
- `until` filtering remains a post-fetch filter in the tool layer (unchanged).

**`sample_messages`:**
- Gains optional `since` and `until` parameters.
- When `since` is provided: calls `getMessagesInRange(chatMid, sinceMs)`.
- When `since` is omitted: existing `count`-based path unchanged.
- After fetching, messages are filtered to `[since, until]`, then sorted oldest-first (existing behavior).

**`get_messages`:** No changes.

## Error Handling and Edge Cases

- **End of history:** `fetchPreviousRawPage` returning an empty array terminates pagination.
- **No results in range:** The existing "0 transactions matched" hint in `get_transactions` handles this.
- **`since`-less `get_transactions`:** Single 200-message fetch; response includes a hint to pass `since` for full month-range accuracy.
- **Contact name resolution:** Called once after all pages are accumulated — one `fetchContactsV2` batch covers all pages.

## What Does Not Change

- `get_messages` tool API and behavior.
- `summarize_transactions` tool (operates on already-fetched transactions).
- `manage_templates` tool.
- Template loading, `filterByTime`, `parseTransaction` logic.
- OAuth and auth flows.
- All existing tests continue to pass without modification (pagination path is only triggered when `sinceMs` is provided).
