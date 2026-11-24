## ADDED Requirements

### Requirement: Typed message-fetch failure
`@raidenyn/line-client` SHALL export a typed failure `LineReadError` with a `kind` of exactly `session_expired` or `unavailable`, a human-readable `message`, and the original failure as `cause`. The range fetch SHALL report every LINE, authentication or network failure as `{ ok: false, error }` and SHALL NOT reject for them.

#### Scenario: Failure is a value
- **WHEN** a range fetch fails for any LINE, authentication or network reason
- **THEN** the call resolves to `{ ok: false, error }` whose `error.kind` is `session_expired` or `unavailable`

### Requirement: Session failures are session_expired
An HTTP 401 from LINE, missing authentication, a failed login and a login waiting for its PIN SHALL be classified as `session_expired`.

#### Scenario: Authentication failure from LINE
- **WHEN** the LINE mock answers a message fetch with HTTP 401 for the access token in use
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `session_expired`

#### Scenario: Not authenticated
- **WHEN** the client has no authentication data and a range fetch is made
- **THEN** it resolves to `{ ok: false }` with `error.kind` `session_expired`

### Requirement: Other failures are unavailable
A network failure, an HTTP 5xx, any other non-2xx answer, a LINE business error and any other unexpected failure SHALL be classified as `unavailable`.

#### Scenario: Network failure
- **WHEN** the LINE endpoint cannot be reached (the connection is refused)
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: Server failure
- **WHEN** LINE answers a message fetch with HTTP 500
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

#### Scenario: LINE business error
- **WHEN** LINE answers with HTTP 200 and a non-zero `code` envelope
- **THEN** the range fetch resolves to `{ ok: false }` with `error.kind` `unavailable`

### Requirement: Exact range fetch
`LineApiClient.getMessagesBetween(chatMid, sinceMs, untilMs)` SHALL return every message LINE serves whose creation time is within `[sinceMs, untilMs]` inclusive, with sender names resolved, and no message outside it.

#### Scenario: Range inside a long history
- **WHEN** a range is requested whose start lies further back than one page of history
- **THEN** exactly the messages inside the range are returned

### Requirement: Range coverage is reported
The range fetch SHALL report `complete: true` only when the walk back through history reached a message older than `sinceMs`, and SHALL report `oldestReachedMs` as the creation time of the oldest message fetched, or `null` when the chat returned none.

#### Scenario: Walk passes the start of the range
- **WHEN** the chat holds messages older than `sinceMs`
- **THEN** `complete` is `true`

#### Scenario: Range reaching before the start of history
- **WHEN** the requested `sinceMs` is older than the chat's oldest message
- **THEN** the messages from the oldest message up to `untilMs` are returned, `complete` is `false` and `oldestReachedMs` is the oldest message's creation time

### Requirement: Invalid ranges are rejected
The range fetch SHALL reject with a `RangeError`, before any request to LINE, when either bound is not finite, `sinceMs` is negative, or `sinceMs` is greater than `untilMs`.

#### Scenario: Start after end
- **WHEN** `sinceMs` is greater than `untilMs`
- **THEN** the call rejects with a `RangeError` and no request is sent to LINE

### Requirement: Range fetch into the cache
`fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs })` SHALL fetch the range with `getMessagesBetween` regardless of the newest message already in the cache, SHALL store the fetched messages with `MessageCache.upsertMessages` for `(ownerMid, chatMid)`, and SHALL return the same result. On a failure it SHALL return the failure and SHALL NOT write to the cache.

#### Scenario: Older range below newer cached messages
- **WHEN** the cache for a chat already holds messages newer than the requested range and that range is fetched
- **THEN** the messages of the range are returned and are in the cache afterwards

#### Scenario: Failure leaves the cache untouched
- **WHEN** the fetch fails with `session_expired` or `unavailable`
- **THEN** the failure is returned and `upsertMessages` is not called

### Requirement: Existing reads unchanged
The existing `getMessages`, `getMessagesInRange` and `withMessageCache` behaviour SHALL remain unchanged, and the errors they throw SHALL keep their message text.

#### Scenario: Existing suites
- **WHEN** the existing unit, smoke and packed-artifact suites run
- **THEN** they pass without modification
