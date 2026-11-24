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
export type RangeCoverage = 'complete' | 'history_end' | 'truncated';
export interface MessageRange { messages: Message[]; coverage: RangeCoverage; oldestReachedMs: number | null }
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
in `client.ts`, re-exported from `index.ts`. It never throws: all inspection of
`err` (`instanceof`, property reads) runs inside `try`, and any exception
during inspection yields `unavailable` / `LINE unavailable: unexpected error`.
It never copies text from `err` into `message`; numbers are interpolated only
after `Number.isInteger` checks (otherwise the text without the number is
used). The original value is kept only as `cause`.

| Failure | Kind | `message` |
| --- | --- | --- |
| `LineHttpError` 401, `refreshFailedTransiently` not set | `session_expired` | `LINE session expired; log in again` |
| `LineHttpError` 401 with `refreshFailedTransiently` | `unavailable` | `LINE unavailable: token refresh failed` |
| `LineNotAuthenticatedError` without a transient `cause` (no auth, login in progress, login failed on a non-transient cause) | `session_expired` | `LINE session expired; log in again` |
| `LineNotAuthenticatedError` whose `cause` is transient | `unavailable` | the cause's row below |
| `LineHttpError` 5xx, 429, other 4xx | `unavailable` | `LINE unavailable: HTTP <status>` (`LINE unavailable: HTTP error` if not an integer) |
| `LineApiError` | `unavailable` | `LINE unavailable: LINE error <code>` (`LINE unavailable: LINE error` if not an integer) |
| abort (`name === 'AbortError'`) | `unavailable` | `LINE unavailable: aborted` |
| `TypeError` (network failure from `fetch`) | `unavailable` | `LINE unavailable: network error` |
| anything else, or inspection threw | `unavailable` | `LINE unavailable: unexpected error` |

Transient = abort, `TypeError`, `LineHttpError` with status ≥ 500 or 429.
`LineNotAuthenticatedError extends Error` is a new private class (exported from
`client.ts` for tests only) with an optional `cause`.

### D3 — Authentication for the typed read

The legacy `ensureAuthenticated` keeps its exact behaviour and text, including
waiting for a pending login. The typed read uses a separate private
`authenticateForRead(signal?)` that never waits for a login:

1. a login is in progress (`pendingLogin !== null`) → throw
   `LineNotAuthenticatedError('Login in progress')` (the user must finish it);
2. `pendingLoginError` set → throw `LineNotAuthenticatedError('Login failed', { cause: pendingLoginError })`;
3. no `auth` → throw `LineNotAuthenticatedError('Not authenticated')`;
4. token refresh: `refreshIfExpired` is split into a private
   `refreshOutcome(): Promise<{ failedStatus: number | null }>` that the legacy
   `refreshIfExpired` awaits and ignores. The static refresh-lock promise
   resolves to an internal `{ data } | { failedStatus }` union so concurrent
   waiters learn the same outcome; tokens are applied only on success, as
   today. The typed read awaits the outcome raced against its `signal` (the
   shared refresh keeps running; only this read stops waiting) and keeps
   `failedStatus` in a local variable passed to the classifier — no
   per-instance shared field.

`pendingLogin` is cleared on success (`client.ts` ~line 537) and on failure, so
"login in progress" is never reported after a completed login. Which LINE
business codes mean a displaced session is unverified (RFC open question
"Session error"); only HTTP 401 and local auth state map to `session_expired`,
and the PR says so.

### D4 — Range walk with an end bound and coverage

`LineClient.getMessagesInRange` is refactored onto a private
`walkHistory(chatMid, sinceMs, pageSize, opts: { signal?: AbortSignal; keepNonAdvancing: boolean })`
returning `{ raw, stop: 'reached_since' | 'history_end' | 'truncated' }`.
`getMessagesInRange` calls it with `keepNonAdvancing: false` and no signal and
keeps its exact behaviour. The private page fetchers and `fetchContactsV2` /
`resolveContactNames` gain an optional `signal` forwarded to `request()`;
legacy callers pass none.

Stop reasons (`reached_since` takes precedence whenever any fetched message is older than `sinceMs`):
- `reached_since`: a fetched message has `createdTime < sinceMs`;
- `history_end`: the recent page is empty or shorter than `pageSize`, a
  previous page is shorter than `pageSize`, or a previous page holds no fresh
  ids (only the inclusive boundary re-included — what the mock and LINE return
  at the start of served history);
- `truncated`: a previous page's fresh messages are not strictly older than the
  current oldest (progress guard), or the 1000-iteration cap is hit. With
  `keepNonAdvancing: true` the fresh messages of the non-advancing page are
  kept before stopping (they were received from LINE); legacy discards them.

`LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)`:

1. validates that both bounds are finite and `0 <= sinceMs <= untilMs`
   (else rejects with `RangeError`, no request);
2. inside one `try`: `authenticateForRead(signal)`, the walk
   (`signal.throwIfAborted()` before each page), keep
   `sinceMs <= createdTime <= untilMs`, `resolveContactNames(…, signal)`, map,
   then `signal.throwIfAborted()` once more before returning success;
3. returns `{ ok: true, value: { messages, coverage, oldestReachedMs } }` with
   `coverage` = `complete` for `reached_since`, else the stop reason;
   `oldestReachedMs` = oldest fetched `createdTime` or `null`;
4. any failure, including a `getContactsV2` failure and an abort, returns
   `{ ok: false, error }` — never a partial `ok: true` built from earlier pages.

Meaning for the next task (documented in `docs/ARCHITECTURE.md`):
- `complete`: the whole range was walked.
- `history_end`: LINE served nothing older; for live catch-up this counts as
  caught up (an empty or new chat must not stay behind forever). For a
  re-request it is reported to the caller as "LINE has nothing older than
  `oldestReachedMs`" (chat start or no longer served; indistinguishable).
- `truncated`: a safety stop; never counts as caught up; the re-request reports
  it as cut short.

The walk still starts at the newest message (LINE offers no time-anchored
call). Starting from the oldest cached message would need a stored
`deliveredTime`, which the cache lacks — out of scope.

### D4b — Public surface and cancellation

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
  `AbortSignal` it aborts at the deadline; the read then settles promptly
  (requests in flight are aborted, refresh waits are abandoned without
  cancelling the shared refresh), and the caller can release its per-source
  lock when the call settles.
- `index.ts` exports `fetchMessageRange`, `classifyLineReadError` and the types
  `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`,
  `RangeCoverage`, `MessageRangeOptions`, `MessageRangeRequest`. The private
  error classes are not exported from `index.ts`.
- `fakeLineApi` in `packages/server/src/test-support.ts` gets a
  `getMessagesBetween` stub returning
  `{ ok: true, value: { messages: [], coverage: 'history_end', oldestReachedMs: null } }`.

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
    inclusive and returns `005`…`000` (a short page). A range `005`…`010` is
    therefore `coverage: 'complete'`; `000`…`010` is `'history_end'`.
  - The seeded access token expires within 24 h, so the first read refreshes
    it and supersedes the seeded pair: both success cases use one client.
  - `session_expired`: a client with a far-expiry token unknown to the mock;
    assert the mock reported an `unknown_access_token` rejection.
  - `unavailable`: a far-expiry token (no refresh) against the origin of a
    stopped mock (connection refused); assert `message` is
    `LINE unavailable: network error`, proving the request was attempted. HTTP 500 is covered by the stubbed
    tests because the mock has no 5xx injection.
  - The mock's end-of-run verification is not asserted.

## Risks / Trade-offs

- [Real LINE codes for a displaced session are unknown] → map only 401 and
  local auth state; record in the PR and leave the RFC open question open.
- [Old ranges cost a walk from the newest message] → acceptable for M1; the
  iteration cap bounds it and `coverage: 'truncated'` reports a cut-short walk.
- [Size: the issue targets ~450 lines and says stop at ~1.5x] → the plan has a
  size checkpoint after Task 3; if the diff (excluding OpenSpec files) heads
  past ~675 lines of source, or tests make the total clearly larger, stop and
  report with a split proposal (e.g. cancellation as a follow-up).
- [Refactoring the walk and the refresh lock could change legacy behaviour] →
  existing `client.test.ts` cases must pass unchanged.
- [Mock test needs a build] → documented verify command; `npm run verify`
  builds first.

## Migration Plan

Additive. No data migration, no config. Rollback is a revert.

## Open Questions

- RFC open question "Session error": which LINE codes signal a displaced
  session. Not resolvable without a live account.
