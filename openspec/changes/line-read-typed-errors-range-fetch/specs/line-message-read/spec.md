## ADDED Requirements

### Requirement: Typed message-fetch failure
`@raidenyn/line-client` SHALL export a typed failure `LineReadError` with a `kind` of exactly `session_expired` or `unavailable`, a fixed human-readable `message`, and the original failure as `cause`. The range fetch SHALL report every LINE, authentication, network or abort failure as `{ ok: false, error }` and SHALL NOT reject for them.

#### Scenario: Failure is a value
- **WHEN** a range fetch fails for any LINE, authentication, network or abort reason
- **THEN** the call resolves to `{ ok: false, error }` whose `error.kind` is `session_expired` or `unavailable`

### Requirement: Failure messages carry no secrets
The `message` of a `LineReadError` SHALL be chosen from fixed texts and SHALL NOT include text taken from the underlying failure. Classifying any value, including one that cannot be converted to a string, SHALL NOT throw.

#### Scenario: Token-bearing failure
- **WHEN** the underlying failure's message contains an access token
- **THEN** the `LineReadError.message` does not contain it

#### Scenario: Unstringifiable failure
- **WHEN** the failure value is an object without a prototype
- **THEN** classification returns `unavailable` without throwing

### Requirement: Session failures are session_expired
An HTTP 401 from LINE, missing authentication, a login waiting for its PIN, and a failed login whose cause is not transient SHALL be classified as `session_expired`.

#### Scenario: Authentication failure from LINE
- **WHEN** the LINE mock answers a message fetch with HTTP 401 for the access token in use
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `session_expired`

#### Scenario: Not authenticated
- **WHEN** the client has no authentication data and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `session_expired`

#### Scenario: Login waiting for its PIN
- **WHEN** a login is waiting for the PIN to be entered and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `session_expired`

### Requirement: Transient failures are unavailable
A network failure, an abort, an HTTP 5xx or 429, any other non-2xx answer except 401, a LINE business error and any other unexpected failure SHALL be classified as `unavailable`. A 401 that follows a token refresh failing with HTTP 5xx or 429 in the same read, and a failed login whose cause is transient, SHALL also be `unavailable`.

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

#### Scenario: Login failed on a server error
- **WHEN** the background login failed with HTTP 500 and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `unavailable`

### Requirement: Exact range fetch
`LineApiClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)` SHALL return every message the walk fetched whose creation time is within `[sinceMs, untilMs]` inclusive, with sender names resolved, and no message outside it. A failure on any page or during sender-name resolution SHALL fail the whole call.

#### Scenario: Range inside a long history
- **WHEN** a range is requested whose start lies further back than one page of history
- **THEN** exactly the messages inside the range are returned

#### Scenario: Later page fails
- **WHEN** the first page succeeds and a previous-page request fails
- **THEN** the call resolves to `{ ok: false }` and no messages are returned

### Requirement: Range coverage is reported
The range fetch SHALL report `complete: true` if and only if the walk fetched at least one message created before `sinceMs`, and SHALL report `oldestReachedMs` as the creation time of the oldest message fetched, or `null` when none was fetched. A walk that ends earlier SHALL return the fetched in-range messages with `complete: false`.

#### Scenario: Walk passes the start of the range
- **WHEN** the walk fetches a message older than `sinceMs`
- **THEN** `complete` is `true`

#### Scenario: Range reaching before the start of history
- **WHEN** the requested `sinceMs` is older than the chat's oldest message
- **THEN** the messages from the oldest message up to `untilMs` are returned, `complete` is `false` and `oldestReachedMs` is the oldest message's creation time

#### Scenario: Safety stop
- **WHEN** the walk stops on its progress guard or iteration cap before fetching a message older than `sinceMs`
- **THEN** the fetched in-range messages are returned with `complete` `false`

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
When the caller's `signal` is aborted before the cache write, `fetchMessageRange` SHALL return an `unavailable` failure and SHALL NOT write to the cache, even if LINE already answered.

#### Scenario: Abort after LINE answered
- **WHEN** the signal is aborted after `getMessagesBetween` resolved successfully but before the write
- **THEN** the result is `unavailable` and `upsertMessages` is not called

### Requirement: Existing reads unchanged
The existing `getMessages`, `getMessagesInRange`, `withMessageCache`, login and token-refresh behaviour SHALL remain unchanged, and the errors they throw SHALL keep their message text.

#### Scenario: Existing suites
- **WHEN** the existing unit, smoke and packed-artifact suites run
- **THEN** they pass without modification
