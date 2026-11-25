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
export interface MessageRangeOptions { signal?: AbortSignal }
```

The new calls never reject for LINE, network, auth or abort failures; they
resolve to `{ ok: false, error }`. Invalid arguments reject with `RangeError`
before any request. `cause` is present when an underlying failure value
exists (absent for a synthesized abort or truncation result); it is defined
as a non-enumerable property so `JSON.stringify` of a result never serializes
it, and it is for logs only — the source port must not forward it into tool
responses. Alternative: an exported, thrown `LineReadError` class — rejected
because nothing forces callers to handle it and the port contract is a result
value anyway.

### D2 — Error classification

An internal pure function `classifyLineReadError(err: unknown, context?: { refreshFailedTransiently?: boolean }): LineReadError`
in `client.ts` (not exported from `index.ts`; the issue only needs the typed
failure). It never throws: all inspection of `err` (`instanceof`, property
reads) runs inside `try`, and any exception during inspection yields
`unavailable` / `LINE unavailable: unexpected error`. It never copies text from
`err` into `message`; numbers are interpolated only after `Number.isInteger`
checks (otherwise the text without the number is used).

| Failure | Kind | `message` |
| --- | --- | --- |
| `LineHttpError` 401, `refreshFailedTransiently` not set | `session_expired` | `LINE session expired; log in again` |
| `LineHttpError` 401 with `refreshFailedTransiently` | `unavailable` | `LINE unavailable: token refresh failed` |
| `LineNotAuthenticatedError` (no auth, login in progress, login failed for any cause — `login()` has already cleared `auth`, so no retry can succeed) | `session_expired` | `LINE session expired; log in again` |
| `LineHttpError` 5xx, 429, other 4xx | `unavailable` | `LINE unavailable: HTTP <status>` (`LINE unavailable: HTTP error` if not an integer) |
| `LineApiError` | `unavailable` | `LINE unavailable: LINE error <code>` (`LINE unavailable: LINE error` if not an integer) |
| `TypeError` (network failure from `fetch`) | `unavailable` | `LINE unavailable: network error` |
| anything else, or inspection threw | `unavailable` | `LINE unavailable: unexpected error` |

Abort is not classified here: D4 gives it precedence over every other failure.
Transient = `TypeError`, `name === 'AbortError'`, or `LineHttpError` with
status ≥ 500 or 429. `LineNotAuthenticatedError extends Error` is a new
private class (exported from `client.ts` for tests only) with an optional
`cause`.

### D3 — Authentication for the typed read

The legacy `ensureAuthenticated` keeps its exact behaviour and text, including
waiting for a pending login. The typed read uses a separate private
`authenticateForRead(): Promise<{ refreshFailedStatus: number | null }>` that
never waits for a login:

1. a login is in progress (`pendingLogin !== null`, i.e. waiting for the QR
   scan or the PIN) → throw `LineNotAuthenticatedError('Login in progress')`;
2. `pendingLoginError` set → throw `LineNotAuthenticatedError('Login failed', { cause: pendingLoginError })`;
3. no `auth` → throw `LineNotAuthenticatedError('Not authenticated')`;
4. token refresh: `refreshIfExpired` is split into a private
   `refreshOutcome(): Promise<{ failedStatus: number | null }>` that the legacy
   `refreshIfExpired` awaits and ignores. The static refresh-lock promise
   resolves to an internal `{ data } | { failedStatus }` union so concurrent
   waiters learn the outcome of the refresh they joined; tokens are applied
   only on success, as today. The read keeps `refreshFailedStatus` in a local
   variable — no per-instance shared field — so a later, successful refresh by
   another read cannot change this read's classification.

   Refresh is best-effort on the typed path, as on the legacy one: a refresh
   that answers non-2xx (including 401) does not stop the read; the read goes
   on with the current access token. If LINE then serves the history, the
   result is `ok: true`; if it answers 401, the classifier decides
   (`session_expired`, or `unavailable` when the refresh failed with 5xx/429).
   A refresh 401 is therefore never reported by itself.

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
keeps its exact behaviour (it ignores `stop`). The private page fetchers and
`fetchContactsV2` / `resolveContactNames` gain an optional `signal` forwarded
to `request()`.

Stop reason, decided once from the last page the walk fetched:
1. `reached_since` whenever any fetched message is older than `sinceMs`.
2. The recent page is empty or shorter than `pageSize` → `history_end`.
3. For the last previous page, in this order:
   - no fresh ids, and the page is empty or holds only the exact boundary
     message → `history_end` (the mock answers `[]` when the boundary is the
     oldest message; a boundary-only page is accepted for compatibility with
     inclusive pagination but is not verified real-LINE behaviour);
   - no fresh ids otherwise (a full or short replay of already-seen
     messages) → `truncated`;
   - fresh messages not strictly older than the current oldest (progress
     guard; with `keepNonAdvancing: true` they are kept before stopping) →
     `truncated`;
   - page shorter than `pageSize` → `history_end`;
4. the loop ended only because the 1000-iteration cap was reached and the last
   page was full and advancing (another request would have been needed) →
   `truncated`.

`pageSize` is not a public parameter: `LineClient` holds it in a private
instance field `rangePageSize = 200` (tests override it through a cast). It
must be ≥ 2 because LINE's previous page includes its boundary.

`LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?: MessageRangeOptions)`:

1. validates that both bounds are finite and `0 <= sinceMs <= untilMs`
   (else rejects with `RangeError`, no request);
2. if `signal` is already aborted → returns the abort result, no request;
3. runs the work — `authenticateForRead()`, the walk, keep
   `sinceMs <= createdTime <= untilMs`, `resolveContactNames(mids, signal)`,
   map — and races it against the signal's `abort` event. The abort
   listener is registered with `node:events` `addAbortListener` (it fires
   even if an earlier listener calls `stopImmediatePropagation()`; disposed
   in `finally`) before the work starts, because the work can run
   synchronously into the injected `fetch` (token refresh) and abort there;
   the race also re-checks `signal.aborted` right after registering;
4. cancellation checkpoints stop the losing work from issuing new requests:
   `signal.throwIfAborted()` after `authenticateForRead()`, before each page
   and before the contact lookup; and `request()` gets a new opt-in option
   `read?: { signal?: AbortSignal }`, set (with or without a signal) only by
   the typed read's page and contact requests. With `read` set, `request()`
   uses the access token it captured for signing also for `x-line-access`
   (today it re-reads `this.auth.accessToken` after the signer's `await`, so a
   refresh by an overlapping read during signing would pair an HMAC of the old
   token with the new token, which the mock rejects); and `read.signal` is
   checked after signing and before calling `fetch`, and forwarded to `fetch`.
   Without `read`, `request()` behaves exactly as today. The existing `signal` option (used by QR and PIN
   polling) keeps its current behaviour — no new check — so the login path is
   unchanged;
5. cancellation has precedence: if the signal is aborted when the race settles
   (whichever side won, whatever the work's error), the result is
   `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } }`
   regardless of the abort `reason`; leftover work (a queued signer call, a
   body read, a shared refresh) finishes or fails silently and issues no
   further request;
6. otherwise success → `{ ok: true, value: { messages, coverage, oldestReachedMs } }`
   (`coverage` = `complete` for `reached_since`, else the stop reason;
   `oldestReachedMs` = oldest fetched `createdTime` or `null`); failure →
   `{ ok: false, error: classifyLineReadError(err, { refreshFailedTransiently }) }`.
   Any page or contact failure fails the whole call — never a partial
   `ok: true` built from earlier pages.

The walk still starts at the newest message (LINE offers no time-anchored
call). Starting from the oldest cached message would need a stored
`deliveredTime`, which the cache lacks — out of scope.

### D4b — Public surface, cache write and the source-port hand-off

- `LineApiClient` is NOT changed (adding a required member would break its
  structural implementations such as `fakeLineApi`). A new exported interface
  `LineReadClient extends LineApiClient` adds
  `getMessagesBetween(chatMid, sinceMs, untilMs, options?: MessageRangeOptions): Promise<LineReadResult>`;
  `createLineClient` returns `LineReadClient` (assignable wherever
  `LineApiClient` is expected). The source-port task widens the type where its
  adapter needs the method.
- New module `packages/line-client/src/message-range.ts` exports
  `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal?, rejectTruncated? }): Promise<LineReadResult>`.
  It calls `client.getMessagesBetween(chatMid, sinceMs, untilMs, { signal })`, then,
  before inspecting the result or writing:
  - `signal?.aborted` → the abort result, nothing written (abort first);
  - failure → returned, nothing written;
  - `rejectTruncated` and `coverage === 'truncated'` →
    `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: history walk truncated' } }`,
    nothing written;
  - otherwise `cache.upsertMessages(ownerMid, chatMid, messages)` when there
    are messages, and the result is returned unchanged.
  A cache write that throws propagates (storage error). It never reads
  `latestTimestamp`.
- How the next task maps this onto the RFC's two outcomes (messages or typed
  error) without a third outcome:
  - live catch-up calls with `rejectTruncated: true`; `complete` and
    `history_end` count as caught up (an empty or new chat must not stay
    behind forever); a truncated walk becomes `unavailable` with no LINE
    messages added, as the RFC's failure rule requires;
  - a re-request keeps partial results (`rejectTruncated` false) and reports
    `coverage` / `oldestReachedMs` in its own result ("cut short" for
    `truncated`, "LINE has nothing older" for `history_end`);
  - a deadline-enforcing caller passes an `AbortSignal` it aborts at the
    deadline; the call settles promptly, writes nothing and issues no further
    request, so the per-source lock can be released when it settles.
- `index.ts` exports `fetchMessageRange` and the types `LineReadClient`,
  `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`,
  `RangeCoverage`, `MessageRangeOptions`, `MessageRangeRequest`. Not exported:
  the classifier and the private error classes.
- `packages/server/src/test-support.ts` is not touched.

### D5 — Tests

- Classifier, auth paths and walk edge cases: unit tests with stubbed `fetch`
  in `packages/line-client/src/client.test.ts` (signer mocked). Every non-empty
  success stub also answers `getContactsV2` (`{ contacts: {} }` or named
  contacts).
- Acceptance against the LINE mock:
  `packages/line-client/src/message-range.mock.test.ts`, signer not mocked.
  The mock's HMAC verifier imports `@raidenyn/line-client` from `dist`, and the
  signer's sandbox can be initialised only once per process, so the test
  loads `createLineClient` and `fetchMessageRange` from the built
  `@raidenyn/line-client` too, like `tests/smoke/mock-line-contract.test.ts`,
  but through a re-export module outside the package's `src`
  (`tests/support/line-client-built.ts`: `export * from '@raidenyn/line-client'`).
  The architecture gate (`tests/architecture/import-boundaries.test.ts`) scans
  every `.ts` under `packages/line-client/src` and rejects a self-import of
  `@raidenyn/line-client`, so the test file must not name that package; the
  re-export resolves the same `dist` module as the mock's verifier, so one
  signer instance runs. The architecture test is not changed. It needs `npm run build` first;
  `npm run verify` builds before testing. Test files are excluded from
  `tsc -b`, so the relative import into `tests/support` does not affect the
  build or the packed artifact.
  - Fixture facts: the group chat has 205 messages (`group-history-000`…`201`,
    then `group-debit`, `group-credit`, `group-image`). The recent page (200)
    holds `group-history-005` upward; the previous page from `005` is
    inclusive and returns `005`…`000` (a short page with fresh, older
    messages). A range `005`…`010` is therefore `coverage: 'complete'`;
    `000`…`010` is `'history_end'`. (The mock answers `[]` only when the
    boundary is the oldest message.)
  - The seeded access token expires within 24 h, so the first read refreshes
    it and supersedes the seeded pair: both success cases use one client.
  - `session_expired`: a client with a far-expiry token unknown to the mock;
    the scenario is configured with `expectedRejections: { unknown_access_token: 1 }`
    and the test asserts the observed expected rejection in the mock report.
  - `unavailable`: a far-expiry token (no refresh) against the origin of a
    stopped mock (connection refused); the client gets a wrapped real `fetch`
    and the test asserts it was called for the recent-messages route of that
    origin, and that the result is `unavailable` / `LINE unavailable: network error`. HTTP 500 is covered by the stubbed
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
