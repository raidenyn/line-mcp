## Context

Task [#131](https://github.com/raidenyn/line-mcp/issues/131) of the expense-ledger
RFC (`openspec/archived/design/expense-ledger/rfc-expense-ledger.md`, M1 Ledger).
The future source port needs `catchUp` and `fetchRange` that return messages or
a typed error (`session_expired`, `unavailable`), and a range fetch that is not
anchored to the newest cached message. Today:

- `withMessageCache` (`packages/line-client/src/cached-message-reader.ts`) always
  fetches from `cache.latestTimestamp`, whatever start it is given.
- `LineClient.getMessagesInRange` (`packages/line-client/src/client.ts`) walks
  backwards from the newest message page by page
  (`getRecentMessagesV2` then `getPreviousMessagesV2WithRequest`) until a page
  is short, a page's oldest message is older than `sinceMs`, the progress guard
  trips, or 1000 iterations pass. It has no end bound.
- Failures surface as the private `LineHttpError` (non-2xx; carries `status`,
  `lineCode`), the private `LineApiError` (2xx with `code != 0`), a rejected
  `fetch` (network), or plain `Error`s from `ensureAuthenticated`
  ("Not authenticated…", "Login failed…", "PIN required…").

## Goals / Non-Goals

**Goals:**
- A typed failure for message fetches with kinds `session_expired` and
  `unavailable`.
- A range fetch with a start and an end that stores the range in the cache
  whatever the newest cached message is, and tells the caller whether the
  whole range was reached.

**Non-Goals:**
- The source port and the LINE adapter (next task).
- Any change to `packages/line-client-sqlite` or the cache schema.
- Any behaviour change of `getMessages`, `getMessagesInRange`,
  `withMessageCache`, the messenger tools, OAuth or `line-mcp` sync.
- Anything under `packages/line-client/assets/ltsm/`. No new dependencies.

## Decisions

### D1 — Result value, not a thrown error

```ts
export type LineReadErrorKind = 'session_expired' | 'unavailable';
export interface LineReadError { kind: LineReadErrorKind; message: string; cause?: unknown }
export interface MessageRange { messages: Message[]; complete: boolean; oldestReachedMs: number | null }
export type LineReadResult = { ok: true; value: MessageRange } | { ok: false; error: LineReadError };
```

The new calls never reject for LINE, network or auth failures; they resolve to
`{ ok: false, error }`. Programming errors (invalid arguments) still throw
synchronously-rejected `RangeError`. Alternative: an exported, thrown
`LineReadError` class — rejected because nothing forces callers to handle it
and the port contract is a result value anyway.

### D2 — Error classification

One exported pure function `classifyLineReadError(err: unknown): LineReadError`
in `client.ts` (where the private classes live), re-exported from `index.ts`:

| Failure | Kind |
| --- | --- |
| `LineHttpError` with `status === 401` | `session_expired` |
| `LineNotAuthenticatedError` (new private class thrown by `ensureAuthenticated` instead of plain `Error`, same message text) — not authenticated, login failed, PIN pending | `session_expired` |
| `LineHttpError` 5xx, other 4xx, `LineApiError`, `fetch` rejection (`TypeError`, `AbortError`), JSON parse errors, anything else | `unavailable` |

The message text of the errors thrown by `ensureAuthenticated` does not change,
so existing callers that show it are unaffected. Which LINE business codes mean
a displaced session is unverified (RFC open question "Session error"); only
HTTP 401 is mapped, and the PR says so.

### D3 — Range walk with an end bound

`LineClient.getMessagesInRange` is refactored into a private walk
`walkHistory(chatMid, sinceMs, pageSize)` returning `{ raw, reachedSince }`
where `reachedSince` is true when some fetched message has
`createdTime < sinceMs` (or exactly at the boundary page that crossed it).
`getMessagesInRange` keeps its exact behaviour on top of it. A new
`LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, pageSize = 200)`:

1. validates `0 <= sinceMs <= untilMs` (else `RangeError`);
2. runs the walk, keeps messages with `sinceMs <= createdTime <= untilMs`,
   resolves sender names, maps them;
3. returns `{ ok: true, value: { messages, complete: reachedSince, oldestReachedMs } }`
   where `oldestReachedMs` is the oldest `createdTime` fetched (null if the chat
   returned nothing);
4. catches any failure and returns `{ ok: false, error: classifyLineReadError(err) }`.

`complete: false` means the walk ended before `sinceMs`: the chat has no older
messages, LINE no longer serves them, or a safety stop fired. These cannot be
told apart; the caller decides.

The walk still starts at the newest message (LINE offers no time-anchored
call). Starting from the oldest cached message would need a stored
`deliveredTime`, which the cache lacks — out of scope.

### D4 — Public surface

- `LineApiClient` gains `getMessagesBetween(chatMid, sinceMs, untilMs, pageSize?) : Promise<LineReadResult>`;
  `createLineClient` wires it to the inner client.
- New module `packages/line-client/src/message-range.ts` exports
  `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs }): Promise<LineReadResult>`.
  It calls `client.getMessagesBetween`; on success with messages it calls
  `cache.upsertMessages(ownerMid, chatMid, messages)` and returns the same
  result; on failure it returns the failure and writes nothing. A cache write
  that throws is a programming/storage error and propagates (not a LINE error).
  `client` is typed as `Pick<LineApiClient, 'getMessagesBetween'>`.
- `index.ts` exports `fetchMessageRange`, `classifyLineReadError` and the types
  `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`.
- `fakeLineApi` in `packages/server/src/test-support.ts` gets a
  `getMessagesBetween` stub returning an empty complete range.

### D5 — Tests against the LINE mock

- Classifier and walk edge cases: unit tests with stubbed `fetch`, in the style
  of `packages/line-client/src/client.test.ts` (signer mocked).
- Acceptance tests: a new `packages/line-client/src/message-range.mock.test.ts`
  starts the in-process mock (`createMockLineServer` from
  `tests/support/mock-line-server/server.ts`, seeded mode) and drives
  `createLineClient(fixtures.seededAuth, { lineApiBaseUrl: origin })` with the
  real signer, plus an in-memory `MessageCache` double. Test files are excluded
  from `tsc -b` (`packages/line-client/tsconfig.json`), so the relative import
  into `tests/support` does not affect the build or the packed artifact.
  - Range: the mock's group chat has 202 history messages plus three newer
    ones; the cache is seeded with the three newer ones; a range among the
    oldest history messages needs a second page (page size 200).
  - `session_expired`: a client whose access token the mock does not know
    (well-formed JWT, far expiry) gets HTTP 401.
  - `unavailable`: base URL pointing at a stopped mock (connection refused);
    HTTP 500 is covered by the stubbed-`fetch` tests because the mock has no
    5xx injection.
  - The mock's end-of-run verification is not asserted for these scenarios
    (they produce rejections on purpose).

## Risks / Trade-offs

- [Real LINE codes for a displaced session are unknown] → map only 401; record
  in the PR and leave the RFC open question open.
- [Old ranges cost a walk from the newest message] → acceptable for M1; the
  iteration cap bounds it and `complete: false` reports a cut-short walk.
- [Refactoring the walk could change `getMessagesInRange`] → existing
  `client.test.ts` cases for it must pass unchanged.
- [Changing `ensureAuthenticated` error class] → message text identical; the
  class still `extends Error`.

## Migration Plan

Additive. No data migration, no config. Rollback is a revert.

## Open Questions

- RFC open question "Session error": which LINE codes signal a displaced
  session. Not resolvable without a live account.
