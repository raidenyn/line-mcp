## Context

Task [#131](https://github.com/raidenyn/line-mcp/issues/131) of the expense-ledger
RFC (`openspec/archived/design/expense-ledger/rfc-expense-ledger.md`, M1 Ledger).
The future source port needs `catchUp` and `fetchRange` that return messages or
a typed error (`session_expired`, `unavailable`) and take a deadline, and a
range fetch that is not anchored to the newest cached message. Today:

- `withMessageCache` (`packages/line-client/src/cached-message-reader.ts`) always
  fetches from `cache.latestTimestamp`, whatever start it is given.
- `LineClient.getMessagesInRange` (`packages/line-client/src/client.ts`) walks
  backwards from the newest message page by page
  (`getRecentMessagesV2` then `getPreviousMessagesV2WithRequest`) until a page
  is short, a page's oldest message is older than `sinceMs`, the progress guard
  trips (no fresh ids, or fresh ids not strictly older), or 1000 iterations
  pass. It has no end bound. It then resolves sender names with
  `resolveContactNames`, which lets `getContactsV2` failures propagate.
- Failures surface as the private `LineHttpError` (non-2xx; carries `status`,
  `lineCode`), the private `LineApiError` (2xx with `code != 0`), a rejected
  `fetch` (network), or plain `Error`s from `ensureAuthenticated`
  ("Not authenticated…", "Login failed: <cause message>", "PIN required…").
  The background login stores its raw failure in `pendingLoginError`.
- `refreshIfExpired` silently ignores any non-2xx token-refresh answer (the
  refresh lock resolves `null`), so a refresh outage later shows up as a 401
  on the stale token. A rejected refresh `fetch` propagates.

## Goals / Non-Goals

**Goals:**
- A typed failure for message fetches with kinds `session_expired` and
  `unavailable`, with fixed, secret-free messages.
- A range fetch with a start and an end that stores the range in the cache
  whatever the newest cached message is, tells the caller whether the whole
  range was reached, and can be cancelled so nothing is written late.

**Non-Goals:**
- The source port, the LINE adapter, the per-source lock and the deadline
  timer (next task: "Ingest new bank messages as transactions").
- Any change to `packages/line-client-sqlite` or the cache schema; no
  persistent coverage state.
- Any behaviour or error-text change of `getMessages`, `getMessagesInRange`,
  `withMessageCache`, login, token refresh, the messenger tools, OAuth or
  `line-mcp` sync.
- Anything under `packages/line-client/assets/ltsm/`. No new dependencies.

## Decisions

### D1 — Result value, not a thrown error

```ts
export type LineReadErrorKind = 'session_expired' | 'unavailable';
export interface LineReadError { kind: LineReadErrorKind; message: string; cause?: unknown }
export interface MessageRange { messages: Message[]; complete: boolean; oldestReachedMs: number | null }
export type LineReadResult = { ok: true; value: MessageRange } | { ok: false; error: LineReadError };
export interface MessageRangeOptions { pageSize?: number; signal?: AbortSignal }
```

The new calls never reject for LINE, network, auth or abort failures; they
resolve to `{ ok: false, error }`. Invalid arguments reject with `RangeError`
before any request. Alternative: an exported, thrown `LineReadError` class —
rejected because nothing forces callers to handle it and the port contract is a
result value anyway.

### D2 — Error classification

One exported pure function `classifyLineReadError(err: unknown, context?: { refreshFailedTransiently?: boolean }): LineReadError`
in `client.ts`, re-exported from `index.ts`. It never throws (no `String(err)`
on arbitrary values) and never copies `err.message` into `message`; the
original value is kept only as `cause`.

| Failure | Kind | `message` |
| --- | --- | --- |
| `LineHttpError` 401, refresh in this read did not fail transiently | `session_expired` | `LINE session expired; log in again` |
| `LineHttpError` 401 after this read's token refresh got a 5xx or 429 | `unavailable` | `LINE unavailable: token refresh failed` |
| `LineNotAuthenticatedError` (no auth, PIN pending, or login failed whose `cause` is not transient) | `session_expired` | as above |
| `LineNotAuthenticatedError` whose `cause` is transient (network, abort, HTTP 5xx/429) | `unavailable` | per the cause row below |
| `LineHttpError` 5xx, 429, other 4xx | `unavailable` | `LINE unavailable: HTTP <status>` |
| `LineApiError` | `unavailable` | `LINE unavailable: LINE error <code>` |
| abort (`signal.aborted`, or `name === 'AbortError'`) | `unavailable` | `LINE unavailable: aborted` |
| `TypeError` from `fetch` (network) | `unavailable` | `LINE unavailable: network error` |
| anything else | `unavailable` | `LINE unavailable: unexpected error` |

`LineNotAuthenticatedError extends Error` is a new private class thrown by
`ensureAuthenticated` at its three sites with the same message text as today;
the "Login failed" site sets `cause` to `pendingLoginError`.

Refresh outcome: the refresh lock's promise value becomes an internal
discriminated result so that both the refreshing caller and concurrent waiters
learn a failed status; `LineClient` records the last refresh failure status
per instance. `getMessagesBetween` clears it at start and passes
`refreshFailedTransiently` to the classifier. Legacy callers see no
difference (same return/throw behaviour).

Which LINE business codes mean a displaced session is unverified (RFC open
question "Session error"); only HTTP 401 and local auth state are mapped to
`session_expired`, and the PR says so.

### D3 — Range walk with an end bound and honest coverage

`LineClient.getMessagesInRange` is refactored onto a private
`walkHistory(chatMid, sinceMs, pageSize, signal?)` returning
`{ raw, reachedSince }`. `reachedSince` is true iff at least one fetched
message has `createdTime < sinceMs` (coverage is what the walk fetched, not
what the chat holds). `getMessagesInRange` keeps its exact behaviour on top of
it (it passes no signal). The private page fetchers gain an optional `signal`
forwarded to `request()`.

`LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)`:

1. validates that both bounds are finite and `0 <= sinceMs <= untilMs`
   (else rejects with `RangeError`, no request);
2. inside one `try`: `ensureAuthenticated`, the walk (checking
   `signal.aborted` before each page), keep `sinceMs <= createdTime <= untilMs`,
   `resolveContactNames`, map;
3. returns `{ ok: true, value: { messages, complete: reachedSince, oldestReachedMs } }`,
   `oldestReachedMs` = oldest fetched `createdTime` or `null`;
4. any failure, including a `getContactsV2` failure and an abort, returns
   `{ ok: false, error }` — never a partial `ok: true` built from earlier pages.

`complete: false` is still `ok: true`: the walk ended (short page = start of
what LINE serves, progress guard, or the 1000-iteration cap) before fetching
anything older than `sinceMs`. Messages that were fetched are returned and
cached; the caller must not report the re-request as fully covered. The
progress guard may drop same-millisecond messages exactly as today; it then
ends the walk, so the result is `complete: false` unless an older message was
already fetched. The three causes cannot be told apart.

The walk still starts at the newest message (LINE offers no time-anchored
call). Starting from the oldest cached message would need a stored
`deliveredTime`, which the cache lacks — out of scope.

### D4 — Public surface and cancellation

- `LineApiClient` gains
  `getMessagesBetween(chatMid, sinceMs, untilMs, options?: MessageRangeOptions): Promise<LineReadResult>`;
  `createLineClient` wires it to the inner client.
- New module `packages/line-client/src/message-range.ts` exports
  `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal? }): Promise<LineReadResult>`.
  It calls `client.getMessagesBetween(chatMid, sinceMs, untilMs, { signal })`;
  on failure it returns it and writes nothing; on success it re-checks
  `signal?.aborted` immediately before writing and, if aborted, returns
  `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } }`
  without writing; otherwise it calls `cache.upsertMessages(ownerMid, chatMid, messages)`
  when there are messages and returns the result. A cache write that throws
  propagates (storage error, not a LINE error). It never reads
  `latestTimestamp`.
- Hand-off to the source-port task: a deadline-enforcing caller passes an
  `AbortSignal` it aborts at the deadline (or uses `getMessagesBetween` and
  writes itself), and holds the per-source lock until the call settles.
- `index.ts` exports `fetchMessageRange`, `classifyLineReadError` and the types
  `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`,
  `MessageRangeOptions`, `MessageRangeRequest`. The private error classes are
  not exported from `index.ts` (exported from `client.ts` for tests only).
- `fakeLineApi` in `packages/server/src/test-support.ts` gets a
  `getMessagesBetween` stub returning
  `{ ok: true, value: { messages: [], complete: false, oldestReachedMs: null } }`.

### D5 — Tests

- Classifier, auth paths and walk edge cases: unit tests with stubbed `fetch`
  in `packages/line-client/src/client.test.ts` (signer mocked). Every non-empty
  success stub also answers `getContactsV2` (`{ contacts: {} }` or named
  contacts).
- Acceptance against the LINE mock:
  `packages/line-client/src/message-range.mock.test.ts`, signer not mocked.
  The mock's HMAC verifier imports `@raidenyn/line-client` from `dist`, and the
  signer's sandbox can be initialised only once per process, so the test
  imports `createLineClient` and `fetchMessageRange` from
  `@raidenyn/line-client` (the built package) too, like
  `tests/smoke/mock-line-contract.test.ts`. It needs `npm run build` first;
  `npm run verify` builds before testing. Test files are excluded from
  `tsc -b`, so the relative import into `tests/support` does not affect the
  build or the packed artifact.
  - Fixture facts: the group chat has 205 messages (`group-history-000`…`201`,
    then `group-debit`, `group-credit`, `group-image`). The recent page (200)
    holds `group-history-005` upward; the previous page from `005` is
    inclusive and returns `005`…`000`. A range `005`…`010` is therefore
    `complete: true`; `000`…`010` is `complete: false`.
  - The seeded access token expires within 24 h, so the first read refreshes
    it and supersedes the seeded pair: both success cases use one client.
  - `session_expired`: a client with a far-expiry token unknown to the mock;
    assert the mock reported an `unknown_access_token` rejection.
  - `unavailable`: a far-expiry token (no refresh) against the origin of a
    stopped mock (connection refused). HTTP 500 is covered by the stubbed
    tests because the mock has no 5xx injection.
  - The mock's end-of-run verification is not asserted.

## Risks / Trade-offs

- [Real LINE codes for a displaced session are unknown] → map only 401 and
  local auth state; record in the PR and leave the RFC open question open.
- [Old ranges cost a walk from the newest message] → acceptable for M1; the
  iteration cap bounds it and `complete: false` reports a cut-short walk.
- [Refactoring the walk and the refresh lock could change legacy behaviour] →
  existing `client.test.ts` cases must pass unchanged.
- [Mock test needs a build] → documented verify command; `npm run verify`
  builds first.

## Migration Plan

Additive. No data migration, no config. Rollback is a revert.

## Open Questions

- RFC open question "Session error": which LINE codes signal a displaced
  session. Not resolvable without a live account.
