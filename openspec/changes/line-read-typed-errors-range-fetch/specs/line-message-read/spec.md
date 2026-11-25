## ADDED Requirements

### Requirement: Typed message-fetch failure
`@raidenyn/line-client` SHALL export a typed failure `LineReadError` with a `kind` of exactly `session_expired` or `unavailable`, a fixed human-readable `message`, and, when an underlying failure value exists, that value as a non-enumerable `cause` that is not serialized with the result. The range fetch SHALL report every LINE, authentication, network or abort failure as `{ ok: false, error }` and SHALL NOT reject for them.

#### Scenario: Failure is a value
- **WHEN** a range fetch fails for any LINE, authentication, network or abort reason
- **THEN** the call resolves to `{ ok: false, error }` whose `error.kind` is `session_expired` or `unavailable`

### Requirement: Failure messages carry no secrets
The `message` of a `LineReadError` SHALL be chosen from fixed texts, with only runtime-validated integer status or code numbers inserted, and SHALL NOT include text taken from the underlying failure. Classifying any value SHALL NOT throw, even when inspecting it throws.

#### Scenario: Token-bearing failure
- **WHEN** the underlying failure's message contains an access token
- **THEN** the `LineReadError.message` does not contain it

#### Scenario: Malformed business error
- **WHEN** LINE answers a range fetch with HTTP 200 and a non-numeric `code` such as a token string
- **THEN** the result is `unavailable`, and neither `message` nor `JSON.stringify` of the result contains that string

#### Scenario: Value that throws on inspection
- **WHEN** the failure value is a proxy whose property access throws
- **THEN** classification returns `unavailable` without throwing

### Requirement: Session failures are session_expired
An HTTP 401 from LINE (except a 401 that follows a token refresh failing with HTTP 5xx or 429 in the same read, which is `unavailable`), missing authentication, a login still in progress, and a failed login whose cause is not transient SHALL be classified as `session_expired`. The range fetch SHALL NOT wait for a login in progress and SHALL send no history request in that case.

#### Scenario: Authentication failure from LINE
- **WHEN** the LINE mock answers a message fetch with HTTP 401 for the access token in use
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `session_expired`

#### Scenario: Refresh rejected but history served
- **WHEN** the token refresh answers HTTP 401 and LINE then serves the history with the current access token
- **THEN** the range fetch resolves to `{ ok: true }` (refresh is best-effort)

#### Scenario: Not authenticated
- **WHEN** the client has no authentication data and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `session_expired`

#### Scenario: Login in progress
- **WHEN** a login is waiting for its PIN (after a certificate rejection) and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `session_expired` without waiting and without a history request

### Requirement: Transient failures are unavailable
A network failure, an abort, an HTTP 5xx or 429, any other non-2xx answer except 401, a LINE business error and any other unexpected failure SHALL be classified as `unavailable`. A 401 that follows a token refresh failing with HTTP 5xx or 429 in the same read, and a failed login whose cause is transient, SHALL also be `unavailable`. The refresh outcome SHALL be attributed per read, so an overlapping read on the same client cannot change another read's classification.

#### Scenario: Network failure
- **WHEN** the LINE endpoint cannot be reached (the connection is refused)
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: Server failure
- **WHEN** LINE answers a message fetch with HTTP 500
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: LINE business error
- **WHEN** LINE answers with HTTP 200 and a non-zero `code` envelope
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: Refresh outage then stale token
- **WHEN** the token refresh answers HTTP 500 and the message fetch then answers HTTP 401
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: Overlapping reads with different refresh outcomes
- **WHEN** one read joins a refresh that answers HTTP 500 and gets HTTP 401, while a later read on the same client refreshes successfully
- **THEN** the first read still reports `unavailable`

#### Scenario: Login failed on a server error
- **WHEN** the background login failed with HTTP 500 and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `unavailable`

### Requirement: Exact range fetch
`LineReadClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)` (on the client returned by `createLineClient`) SHALL return every message received from LINE during the walk whose creation time is within `[sinceMs, untilMs]` inclusive, with sender names resolved, and no message outside it. A failure on any page or during sender-name resolution SHALL fail the whole call.

#### Scenario: Range inside a long history
- **WHEN** a range is requested whose start lies further back than one page of history
- **THEN** exactly the messages inside the range are returned

#### Scenario: Later page fails
- **WHEN** the first page succeeds and a previous-page request fails
- **THEN** the call resolves to `{ ok: false }` and no messages are returned

### Requirement: Range coverage is reported
The range fetch SHALL report `coverage` as `complete` if and only if the walk received a message created before `sinceMs`. Otherwise it SHALL report `truncated` when the walk hit a safety stop, and `history_end` when LINE served nothing older. `oldestReachedMs` SHALL be the creation time of the oldest message received, or `null` when none was received.

#### Scenario: Walk passes the start of the range
- **WHEN** the walk receives a message older than `sinceMs`
- **THEN** `coverage` is `complete`

#### Scenario: Range reaching before the start of history
- **WHEN** the requested `sinceMs` is older than the chat's oldest message and the walk reaches that message without a safety stop (its last page is empty, holds only the boundary message, or is short with new, older messages)
- **THEN** the messages from the oldest message up to `untilMs` are returned, `coverage` is `history_end` and `oldestReachedMs` is the oldest message's creation time

#### Scenario: Progress-guard stop keeps received messages
- **WHEN** a previous page returns fresh messages none of which is strictly older than the current oldest (for example all with the same creation time)
- **THEN** those of them inside `[sinceMs, untilMs]` are included, no further page is requested, and `coverage` is `truncated`

#### Scenario: Safety stops are truncated
- **WHEN**, before receiving a message older than `sinceMs`, the walk stops on its progress guard, on a previous page that only replays already-received messages (full or short, other than a page holding only the boundary message), or on its iteration cap while the last page was full and advancing
- **THEN** `coverage` is `truncated`

#### Scenario: End of served history
- **WHEN**, before receiving a message older than `sinceMs`, the last page is empty, holds only the boundary message, or is shorter than the page size with new, older messages
- **THEN** `coverage` is `history_end`

#### Scenario: Replayed full page
- **WHEN** a previous page is full but contains only messages already received
- **THEN** `coverage` is `truncated`, not `history_end`

#### Scenario: Iteration cap
- **WHEN** the walk hits its iteration cap while the last page was full and advancing, so another request was needed, before receiving a message older than `sinceMs`
- **THEN** the received in-range messages are returned with `coverage` `truncated`

### Requirement: Invalid ranges are rejected
The range fetch SHALL reject with a `RangeError`, before any request to LINE, when either bound is not finite, `sinceMs` is negative, or `sinceMs` is greater than `untilMs`.

#### Scenario: Start after end
- **WHEN** `sinceMs` is greater than `untilMs`
- **THEN** the call rejects with a `RangeError` and no request is sent to LINE

### Requirement: Range fetch into the cache
`fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal? })` SHALL fetch the range with `getMessagesBetween` regardless of the newest message already in the cache, SHALL store the fetched messages with `MessageCache.upsertMessages` for `(ownerMid, chatMid)`, and SHALL return the same result. On a failure it SHALL return the failure and SHALL NOT write to the cache.

#### Scenario: Older range below newer cached messages
- **WHEN** the cache for a chat already holds messages newer than the requested range and that range is fetched
- **THEN** the messages of the range are returned and are in the cache afterwards

#### Scenario: Failure leaves the cache untouched
- **WHEN** the fetch fails with `session_expired` or `unavailable`
- **THEN** the failure is returned and `upsertMessages` is not called

### Requirement: Cancelled fetches write nothing
When the caller's `signal` is aborted before the range fetch returns, the call SHALL settle promptly with `unavailable` and message `LINE unavailable: aborted`, whatever the abort reason and whatever other failure occurred. It SHALL issue no further LINE request afterwards, and `fetchMessageRange` SHALL NOT write to the cache, even if LINE already answered. This SHALL hold during signing, body reads, page and contact requests, and token-refresh waits.

#### Scenario: Abort after LINE answered
- **WHEN** the signal is aborted after `getMessagesBetween` resolved successfully but before the write
- **THEN** the result is `unavailable` and `upsertMessages` is not called

#### Scenario: Abort while signing is blocked
- **WHEN** the signal is aborted while the request signer has not resolved, and the signer resolves afterwards
- **THEN** `getMessagesBetween` resolves to `unavailable` with message `LINE unavailable: aborted` without waiting for the signer, and no request is sent

#### Scenario: Abort wins over a concurrent failure
- **WHEN** the signal is aborted with a custom reason while a 401 response body is being read
- **THEN** the result is `LINE unavailable: aborted`, not `session_expired`

### Requirement: Truncated walks can be refused before writing
When `fetchMessageRange` is called with `rejectTruncated: true` and the walk's coverage is `truncated`, it SHALL return `unavailable` with message `LINE unavailable: history walk truncated` and SHALL NOT write to the cache. Without the flag, a truncated result SHALL be written and returned unchanged.

#### Scenario: Live catch-up refuses a truncated walk
- **WHEN** `rejectTruncated` is true and `getMessagesBetween` returns `coverage` `truncated`
- **THEN** the result is `unavailable` and `upsertMessages` is not called

### Requirement: Existing reads unchanged
The existing `getMessages`, `getMessagesInRange`, `withMessageCache`, login and token-refresh behaviour SHALL remain unchanged, and the errors they throw SHALL keep their message text.

#### Scenario: Existing suites
- **WHEN** the existing unit, smoke and packed-artifact suites run
- **THEN** they pass without modification
