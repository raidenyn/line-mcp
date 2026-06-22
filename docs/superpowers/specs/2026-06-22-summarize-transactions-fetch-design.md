# summarize_transactions: fetch from LINE directly

**Date:** 2026-06-22

## Problem

`summarize_transactions` currently requires the caller to pass a full transaction array as input. Because `get_transactions` already returns that array as tool output, the transaction list passes through Claude's context window twice — once as output, once as input — doubling the token cost for what is usually a one-shot "give me the total" query.

## Goal

`summarize_transactions` should fetch and parse transactions internally and return only the aggregated summary. The raw transaction list should never enter Claude's context for a summarize call.

`get_transactions` is kept unchanged for cases where the caller needs the raw transaction details.

## Design

### Shared helper: `fetchParsedTransactions()`

A private async function in `src/index.ts` (not exported). Extracts the fetch+parse pipeline currently duplicated inside the `get_transactions` handler.

**Signature:**
```ts
async function fetchParsedTransactions(
  authData: AuthData,
  chatMid: string,
  since?: string,
  until?: string,
): Promise<
  | { transactions: Transaction[]; warnings: string[]; rangeNote: string }
  | { error: string }
>
```

**Behavior:**
1. Validate `since`/`until` date strings; return `{ error }` if invalid.
2. Load saved templates via `loadTemplates(chatMid)`; return `{ error }` if none exist.
3. Fetch messages: `getMessagesInRange` when `since` is set, otherwise `getMessages(chatMid, 200)`.
4. Parse each message with `parseTransaction`, applying `filterByTime` per message.
5. Filter transactions by `since`/`until`, sort oldest→newest, call `applyBalanceDiffs`.
6. Return `{ transactions, warnings, rangeNote }`.

Templates are always loaded from saved store (`.line-templates/<chatMid>.json`). No inline template override.

### `get_transactions` (unchanged interface)

Calls `fetchParsedTransactions()`. On error return, short-circuits with `isError: true`. On success, returns `JSON.stringify(transactions) + warningBlock + rangeNote` as today. The zero-match hint remains here.

### `summarize_transactions` (new interface)

**New input schema** — replaces `transactions: Transaction[]`:

| Parameter  | Type                      | Required | Notes                              |
|------------|---------------------------|----------|------------------------------------|
| `chatMid`  | string                    | yes      | Chat MID from `list_chats`         |
| `group_by` | `"month" \| "merchant"`   | yes      | Grouping dimension                 |
| `since`    | string (ISO date)         | no       | Lower bound (inclusive)            |
| `until`    | string (ISO date)         | no       | Upper bound (inclusive)            |

Calls `fetchParsedTransactions(authData, chatMid, since, until)`. On error, returns `isError: true`. On success, passes `transactions` into `summarize(transactions, group_by, since, until)` and returns `JSON.stringify(result)`. Warnings and rangeNote are appended to the output string.

## Error handling

All error paths in `fetchParsedTransactions` mirror the existing `get_transactions` messages:
- Invalid date → `"Invalid 'since' date: …"`
- No saved templates → `"No templates provided and none saved for this chat. …"`
- LINE API failure → `"Failed to get transactions: …"`

`summarize_transactions` wraps the whole handler in try/catch and returns `"Failed to summarize: …"` for unexpected errors, matching current behavior.

## Token impact

Before: Claude context sees `N` transactions as `get_transactions` output, then again as `summarize_transactions` input.  
After: Claude context sees only the summary object. Transaction list is internal to the server.

## Out of scope

- Inline template overrides for `summarize_transactions` (always uses saved templates).
- Changes to `get_transactions` interface.
- New modules or files (helper lives in `src/index.ts`).
