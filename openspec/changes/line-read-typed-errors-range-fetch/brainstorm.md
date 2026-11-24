## Design Summary

Input: task [#131](https://github.com/raidenyn/line-mcp/issues/131) (expense-ledger RFC, M1 Ledger, task 1).

`@raidenyn/line-client` gains one way to fetch exactly a requested stretch of a
chat's history (`sinceMs` … `untilMs`) into the message cache, returning either
the messages or a typed error with kind `session_expired` or `unavailable`.
Nothing calls it yet; the source port of the next task ("Ingest new bank
messages as transactions") does.

Findings from the code as merged (`a56f130`):

- LINE has no "start at time T" call, only "page before message X". The
  existing `LineClient.getMessagesInRange` already walks backwards from the
  newest message until it passes `sinceMs`. The defect is only in
  `withMessageCache` (`cached-message-reader.ts`), which replaces the given
  start with the cache's `latestTimestamp`.
- The client distinguishes authentication failures only by HTTP 401. The
  mock's 401 codes (10006/10007/10008) are mock-defined, not verified against
  real LINE. A failed token refresh is swallowed and later surfaces as a 401.
  "Not authenticated" / pending-login failures are plain `Error`s raised by
  `ensureAuthenticated`.
- "LINE no longer serves this range" is indistinguishable from "the chat has
  no older messages": in both cases the backwards walk ends before `sinceMs`.
- `LineApiClient` is implemented by `createLineClient` and by the stub
  `fakeLineApi` in `packages/server/src/test-support.ts`.

## Alternatives Considered

### Alternative A: Result value
- **Approach**: the new calls resolve to
  `{ ok: true, messages, complete, oldestReachedMs } | { ok: false, error: { kind, message, cause } }`
  and never reject for LINE/network failures.
- **Pros**: the compiler forces the source port to handle both branches;
  matches the RFC's "returns messages or a typed error" wording for
  `catchUp`/`fetchRange`; coverage information has a natural home.
- **Cons**: differs from the throwing style of the existing `MessageReader`.

### Alternative B: Exported error class, thrown
- **Approach**: export `LineReadError extends Error` with `kind`; the new call
  throws it.
- **Pros**: matches the existing readers; `instanceof` checks.
- **Cons**: nothing forces callers to handle it; the port has to catch and
  convert anyway; coverage still needs a richer success value.
- **Why not chosen**: the port's contract is a result value, so B only adds a
  conversion step.

### Alternative C: Fix `withMessageCache.getMessagesInRange` to honour `sinceMs`
- **Approach**: change the existing wrapper so it fetches from `sinceMs` when
  that is older than the cache.
- **Pros**: no new surface.
- **Cons**: changes behaviour of existing callers (`line-mcp` sync, bank tools),
  which the task puts out of scope; still no end bound, no typed errors.
- **Why not chosen**: violates "existing `MessageReader` methods behave as
  before".

## Agreed Approach

Alternative A (approved by the user on 2026-11-24):

- `LineClient` gets a range walk with an end bound and a progress flag; the
  public `LineApiClient` gets `getMessagesBetween(chatMid, sinceMs, untilMs)`
  returning the result value.
- A new exported `fetchMessageRange(client, cache, ownerMid, chatMid, range)`
  calls it, upserts the messages into the cache with the existing
  `MessageCache.upsertMessages` (no schema change) and returns the result.
- Error mapping (one exported classifier):
  - HTTP 401, "not authenticated", pending/failed login → `session_expired`
  - network errors (fetch rejects), HTTP 5xx, any other failure → `unavailable`
  - the original error is kept as `cause`.
- `complete: false` with `oldestReachedMs` tells the caller the walk ended
  before `sinceMs` (history start, LINE no longer serving it, or the walk's
  safety stops).
- Existing reader methods and `withMessageCache` are unchanged.

## Key Decisions

- Result value, not a thrown class (A over B).
- The range fetch lives in `@raidenyn/line-client`: the walk in `client.ts`, the
  cache-storing function in a new module next to `cached-message-reader.ts`.
- `fakeLineApi` in `packages/server/src/test-support.ts` gains a stub for the new
  member; no existing test is changed.
- Unverified: which real LINE codes signal a displaced session. Only HTTP 401
  is mapped; the PR reports this.

## Open Questions

- Real LINE error codes for a displaced/revoked session (RFC open question
  "Session error") — not resolvable without a live account; reported in the PR.
- Whether the walk can start from the oldest cached message instead of the
  newest (needs a stored `deliveredTime`, which the cache does not hold) —
  out of scope, possible later optimisation.
