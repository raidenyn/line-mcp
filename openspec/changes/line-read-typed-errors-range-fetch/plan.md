# LINE read: typed errors and range fetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@raidenyn/line-client` returns LINE messages or a typed error (`session_expired` | `unavailable`) and fetches an exact time range of a chat into the message cache.

**Architecture:** A pure classifier maps today's private errors, local auth state and refresh outcome to the typed failure. `LineClient`'s backwards history walk is extracted so a new `getMessagesBetween` can reuse it with an end bound, a coverage flag and an abort signal, returning a result value. A new `fetchMessageRange` module stores that range through the existing `MessageCache.upsertMessages`, never writing after a failure or an abort.

**Tech Stack:** TypeScript (CommonJS, `tsc -b`), vitest, the in-process LINE mock in `tests/support/mock-line-server/`.

**Spec:** `openspec/changes/line-read-typed-errors-range-fetch/design.md` and `specs/line-message-read/spec.md` (read both; design D1–D5 are referenced below and are authoritative for names, types and messages).

## Global Constraints

- Never edit `packages/line-client/assets/ltsm/*`. No new dependencies. No change in `packages/line-client-sqlite`.
- Existing behaviour and error message text of `getMessages`, `getMessagesInRange`, `withMessageCache`, login and token refresh stay identical; existing tests are not modified.
- Error kinds are exactly `'session_expired' | 'unavailable'`; `LineReadError.message` only ever takes the fixed texts of design D2.
- Commits: Conventional Commits, e.g. `feat(line-client): …`, `test(line-client): …`. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Size: the issue targets ~450 lines (~6 files) and requires a stop at ~1.5×; Task 3 ends with a size checkpoint.
- TDD per task (red → green). `npm run lint` must pass (the lint-on-edit hook reports errors after each edit; fix them).

## Review Focus

1. Boundary timestamps: messages at exactly `sinceMs` and `untilMs` are included (Task 3 `includes both bounds`).
2. Failure on a later page or during contact resolution yields `{ ok: false }`, never a partial `ok: true` (Task 3 `fails whole range when a later page fails`, `fails whole range when contacts fail`).
3. A refresh outage followed by a 401 is `unavailable`, attributed per read even with overlapping reads (Task 2 `refresh failure is returned to each overlapping caller`, Task 3 `refresh 500 then 401 is unavailable`).
4. A deadline abort after LINE answered writes nothing (Task 5 `no write after abort`).
5. Safety stops keep received messages and report `truncated`; normal end of history reports `history_end` (Task 3 `progress-guard stop keeps received messages`, `iteration cap is truncated`, `boundary-only previous page is history_end`).

---

### Task 1: Typed failure and classifier

**Files:**
- Modify: `packages/line-client/src/client.ts` (types and classifier next to `LineHttpError`/`LineApiError`, ~lines 62–85; add `export` to both classes for tests)
- Test: `packages/line-client/src/client.test.ts` (new `describe('classifyLineReadError')`)

**Interfaces:**
- Produces (from `client.ts`): the D1 types; `export function classifyLineReadError(err: unknown, context?: { refreshFailedTransiently?: boolean }): LineReadError`; `export class LineHttpError`, `export class LineApiError`, and a new `export class LineNotAuthenticatedError extends Error` with constructor `(message: string, options?: { cause?: unknown })` (all three exported from `client.ts` for tests only, never from `index.ts`).

- [ ] **Step 1: Write failing tests** — `it.each` rows asserting `kind`, exact `message`, and `cause === err` (design D2 table):
  - `new LineHttpError(401, '/p')` → `session_expired`, `'LINE session expired; log in again'`; with `{ refreshFailedTransiently: true }` → `unavailable`, `'LINE unavailable: token refresh failed'`
  - `new LineHttpError(500|503|429|400|403|404, '/p')` → `'LINE unavailable: HTTP <n>'`
  - `new LineApiError(10051, '/p')` → `'LINE unavailable: LINE error 10051'`; `new LineApiError('eyJsecret' as unknown as number, '/p')` → `'LINE unavailable: LINE error'`
  - `new TypeError('fetch failed')` → `'LINE unavailable: network error'`; `new DOMException('aborted', 'AbortError')` → `'LINE unavailable: aborted'`
  - `new LineNotAuthenticatedError('Not authenticated')`, `new LineNotAuthenticatedError('Login in progress')` → `session_expired`
  - `LineNotAuthenticatedError` with cause `new LineHttpError(500, '/p')` → `'LINE unavailable: HTTP 500'`; with cause `new TypeError()` → `'LINE unavailable: network error'`; with cause `new LineHttpError(400, '/p')` → `session_expired`
  - `new SyntaxError('x')`, `'a string'`, `undefined`, `Object.create(null)` → `'LINE unavailable: unexpected error'`
  - `new Proxy({}, { get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } })` → does not throw, `'LINE unavailable: unexpected error'`
  - `new Error('Bearer eyJsecret.token')` → `message` does not contain `eyJsecret`
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t classifyLineReadError` — Expected: FAIL (not exported).
- [ ] **Step 3:** Implement per design D2 (whole inspection inside `try`; integers only via `Number.isInteger`).
- [ ] **Step 4:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: all PASS.
- [ ] **Step 5:** Commit `feat(line-client): add typed LINE read errors and classifier`.

### Task 2: Authentication for the typed read

**Files:**
- Modify: `packages/line-client/src/client.ts` (`refreshIfExpired` ~lines 238–272; new private `authenticateForRead` next to `ensureAuthenticated` ~274)
- Test: `packages/line-client/src/client.test.ts`

**Interfaces:**
- Consumes: `LineNotAuthenticatedError` (Task 1).
- Produces (design D3): `private refreshOutcome(): Promise<{ failedStatus: number | null }>` (legacy `refreshIfExpired` awaits it and ignores the value; the static `refreshLocks` value becomes an internal `{ data } | { failedStatus }` union shared with concurrent waiters; a rejected refresh `fetch` still propagates); `private authenticateForRead(signal?: AbortSignal): Promise<{ refreshFailedStatus: number | null }>`. `ensureAuthenticated` is NOT changed.

Tests call the private method via `(client as unknown as { authenticateForRead(s?: AbortSignal): Promise<{ refreshFailedStatus: number | null }> })`.

- [ ] **Step 1: Write failing tests**:
  - `no auth → LineNotAuthenticatedError('Not authenticated')`, fetch not called.
  - `login in progress → throws without waiting`: inside `describe('LineClient QR login')`, `makeLoginFetch(apiOk({}))` with `checkQrCodeVerified` overridden to a never-resolving promise; after `login()`, `authenticateForRead()` rejects with `LineNotAuthenticatedError` within the test timeout and no message route was called.
  - `login failed keeps cause`: `makeLoginFetch(httpErr(500))`; after `waitForCompletion()` rejects, `authenticateForRead()` rejects with a `LineNotAuthenticatedError` whose `cause` is a `LineHttpError` with `status` 500.
  - `refresh failure is returned to each overlapping caller`: one client, JWT expiring in 1 h; `tokenRefresh` answers `httpErr(500)` from a deferred promise; start two `authenticateForRead()` calls, then resolve the deferred; both resolve `{ refreshFailedStatus: 500 }`; `tokenRefresh` fetched once; access token unchanged.
  - `abort abandons the refresh wait`: deferred `tokenRefresh`; `authenticateForRead(controller.signal)`, abort, it rejects with an `AbortError` before the deferred is resolved; resolving later still applies the refreshed token for other callers (`refreshOutcome` result seen by a second call).
  - Legacy guard: the existing `LineClient — JWT expiry` and `concurrent refresh deduplication` tests pass unchanged.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3:** Implement per design D3.
- [ ] **Step 4:** Run the same command — Expected: all PASS.
- [ ] **Step 5:** Commit `feat(line-client): add non-waiting authentication for typed reads`.

### Task 3: `getMessagesBetween`

**Files:**
- Modify: `packages/line-client/src/client.ts` (`getMessagesInRange` ~664–730; `fetchRawPage`/`fetchPreviousRawPage` ~612–628; `fetchContactsV2` ~588, `resolveContactNames` ~630 gain optional `signal`)
- Test: `packages/line-client/src/client.test.ts` (new `describe('LineClient.getMessagesBetween')` with its own `raw(id, createdTime, from = 'u1')` helper)

**Interfaces:**
- Consumes: Task 1 classifier/types; Task 2 `authenticateForRead`.
- Produces:
  ```ts
  private walkHistory(chatMid: string, sinceMs: number, pageSize: number, opts: { signal?: AbortSignal; keepNonAdvancing: boolean }): Promise<{ raw: RawMessage[]; stop: 'reached_since' | 'history_end' | 'truncated' }>;
  async getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions): Promise<LineReadResult>;
  ```

All success stubs answer `getContactsV2` with `apiOk({ contacts: {} })` unless stated.

- [ ] **Step 1: Write failing tests** (`pageSize` 2 where paging is needed):
  - `returns exactly the range across pages`: recent `[m5@5000, m6@6000]`; previous from m5 → `[m3@3000, m4@4000]`; from m3 → `[m1@1000, m2@2000]`; `(2000, 4000, { pageSize: 2 })` → sorted ids `['m2','m3','m4']`, `coverage: 'complete'`, `oldestReachedMs: 1000`.
  - `includes both bounds` (messages at exactly 2000 and 4000 returned); `empty range inside history` (1000 and 5000, range `[2000,4000]` → `[]`, `complete`).
  - `short recent page is history_end`: recent `[m1@3000]`, `[1000, 4000]` → `['m1']`, `history_end`, `oldestReachedMs: 3000`.
  - `boundary-only previous page is history_end`: recent `[m3@3000, m4@4000]`, previous returns `[m3@3000]` → `history_end`.
  - `empty chat`: recent `[]` → `[]`, `history_end`, `oldestReachedMs: null`.
  - `progress-guard stop keeps received messages`: recent `[a@3000, b@3000]`, previous → `[c@3000, d@3000]`, range `[1000, 4000]` → ids `a,b,c,d`, `truncated`, exactly one previous-page call.
  - `iteration cap is truncated`: `pageSize: 1`, recent `[x@1_000_000]`; previous always returns one fresh message 1 ms older than its boundary; range `[0, 2_000_000]` → `truncated`, `messages.length === 1001`.
  - `rejects invalid range without a request`: `(5000, 4000)`, `(-1, 10)`, `(NaN, 10)`, `(0, Infinity)` → `RangeError`, fetch not called.
  - `maps 401 to session_expired`, `maps 500 to unavailable`, `maps business error to unavailable` (`apiErr(10004, 'x')`), `maps rejected fetch to unavailable`.
  - `not authenticated is session_expired` (fetch not called); `login in progress is session_expired` (QR-login describe, pending `checkQrCodeVerified`; no `getRecentMessagesV2` call); `failed login on HTTP 500 is unavailable` (QR-login describe, `makeLoginFetch(httpErr(500))`).
  - `refresh 500 then 401 is unavailable` (JWT expiring in 1 h; `tokenRefresh` → 500; recent → 401; message `'LINE unavailable: token refresh failed'`); `401 without refresh is session_expired`.
  - `fails whole range when a later page fails` (previous → 500 → `unavailable`); `fails whole range when contacts fail` (`getContactsV2` → 500).
  - `resolves sender names` (named contact for `u1`).
  - `aborts between pages` (previous-page stub aborts and returns a full page → `'LINE unavailable: aborted'`, no second previous call); `aborts during the final short page` (recent stub aborts the controller and resolves a short page → `aborted`); `aborts during contact lookup` (`getContactsV2` stub returns a promise that rejects when `init.signal` aborts; abort after it is called → `aborted`).
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t getMessagesBetween` — Expected: FAIL.
- [ ] **Step 3:** Implement per design D4: move the loop of `getMessagesInRange` verbatim into `walkHistory`, adding the stop reason and the `keepNonAdvancing` branch; `getMessagesInRange` uses `keepNonAdvancing: false` and keeps its output. `getMessagesBetween`: validate first, then one `try` around `authenticateForRead(signal)` + walk + filter + `resolveContactNames(mids, signal)` + map + final `signal?.throwIfAborted()`; `catch` → `{ ok: false, error: classifyLineReadError(err, { refreshFailedTransiently }) }` with `refreshFailedTransiently` from the local `refreshFailedStatus` (≥ 500 or 429).
- [ ] **Step 4:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: all PASS, including the existing `LineClient.getMessagesInRange` block.
- [ ] **Step 5:** Commit `feat(line-client): add getMessagesBetween range walk with end bound`.
- [ ] **Step 6: Size checkpoint.** Run `git diff --stat origin/main -- packages docs ':!*.test.ts'` and `git diff --stat origin/main -- '*.test.ts'`. If non-test source already exceeds ~300 changed lines, or the projected total (tests included) clearly exceeds ~675 lines (1.5× the issue's ~450), STOP: report the numbers to the controller with a split proposal (e.g. cancellation and the refresh-outcome work as a follow-up task) instead of continuing.

### Task 4: Public client surface

**Files:**
- Modify: `packages/line-client/src/index.ts`
- Modify: `packages/server/src/test-support.ts` (`fakeLineApi`)
- Test: `packages/line-client/src/client.test.ts` (near `describe('LineClient gateway base URL')`)

**Interfaces:**
- Consumes: `LineClient.getMessagesBetween` (Task 3).
- Produces: `LineApiClient.getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions): Promise<LineReadResult>`; `index.ts` exports `classifyLineReadError` and types `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`, `RangeCoverage`, `MessageRangeOptions`. Not exported: `LineHttpError`, `LineApiError`, `LineNotAuthenticatedError`.

- [ ] **Step 1: Write failing test** `createLineClient exposes getMessagesBetween`: `createLineClient(baseAuth, { fetch: stub })`, recent → one message at 2000, contacts → `{ contacts: {} }`; `getMessagesBetween('g1', 1000, 3000)` → `ok`, one message.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t "exposes getMessagesBetween"` — Expected: FAIL.
- [ ] **Step 3:** Add the member, wiring and exports; add the design D4b stub to `fakeLineApi()`.
- [ ] **Step 4:** Run `npm run build && npx vitest run packages/line-client packages/server` — Expected: build exit 0, tests PASS.
- [ ] **Step 5:** Commit `feat(line-client): expose getMessagesBetween and typed read errors`.

### Task 5: `fetchMessageRange` into the cache

**Files:**
- Create: `packages/line-client/src/message-range.ts`
- Modify: `packages/line-client/src/index.ts` (export)
- Test: `packages/line-client/src/message-range.test.ts`

**Interfaces:**
- Consumes: `LineReadResult`, `MessageRangeOptions` (from `./client`), `MessageCache` (from `./cached-message-reader`).
- Produces:
  ```ts
  export interface MessageRangeRequest { sinceMs: number; untilMs: number; signal?: AbortSignal }
  export function fetchMessageRange(
    client: { getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions): Promise<LineReadResult> },
    cache: Pick<MessageCache, 'upsertMessages'>,
    ownerMid: string, chatMid: string, range: MessageRangeRequest,
  ): Promise<LineReadResult>;
  ```
  (Structural client type avoids importing `index.ts` and a cycle.)

- [ ] **Step 1: Write failing tests** with plain doubles:
  - `upserts the fetched range`: client resolves `ok` with 2 messages → returned result `toBe` the client's; `upsertMessages` called once with `('owner', 'chat', messages)`; client called with `('chat', 1000, 2000, { signal: undefined })`.
  - `does not write an empty range`: `messages: []` → no upsert.
  - `no write on failure`: `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: HTTP 500' } }` → returned, no upsert; same for `session_expired`.
  - `no write after abort`: client resolves `ok` with messages but aborts the passed controller before resolving → result `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } }`, no upsert.
  - `cache errors propagate`: `upsertMessages` throws `new Error('disk full')` → `rejects.toThrow('disk full')`.
  - `ignores the newest cached message`: the cache double also has a spy `latestTimestamp` → never called.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/message-range.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** Implement per design D4b; export `fetchMessageRange` and `MessageRangeRequest` from `index.ts`.
- [ ] **Step 4:** Run the same command — Expected: PASS. Then `npm run lint` — no errors.
- [ ] **Step 5:** Commit `feat(line-client): add fetchMessageRange into the message cache`.

### Task 6: Acceptance tests against the LINE mock

**Files:**
- Test: `packages/line-client/src/message-range.mock.test.ts`

**Interfaces:**
- Consumes: `createLineClient`, `fetchMessageRange`, `Message` from `@raidenyn/line-client` (the BUILT package — design D5; do not import `./index` and do not mock the signer); `createMockLineServer` from `../../../tests/support/mock-line-server/server`; `MOCK_GROUP_MID`, `makeMockLineJwt` from `../../../tests/support/mock-line-server/fixtures`.

Setup: `beforeAll` → `mock = createMockLineServer({ port: 0, controlToken: 't' })`; `({ origin } = await mock.start())`; `mock.state.configure({ scenarioId: 'range', mode: 'seeded', epochSeconds: now, expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {} })` (after `start()`, so fixtures carry the bound origin). One shared `api = createLineClient(mock.state.fixtures.seededAuth, { lineApiBaseUrl: origin })` for both success cases (its first call refreshes and supersedes the seeded pair). `afterAll` → `mock.stop({ verify: false })`. In-memory cache double: `Map` keyed by message id; `upsertMessages`, `getMessages(owner, chat)` sorted by `Number(createdTime)`. `ownerMid` = seeded `mid`. `t(id)` = `Number(fixture.createdTime)` of the group fixture with that id. Compare ids as sorted arrays.

- [ ] **Step 1: Write the tests**:
  - `fetches an older range below newer cached messages`: seed the cache with `group-debit`, `group-credit`, `group-image` (fixture objects mapped to `Message` fields); `fetchMessageRange(api, cache, owner, MOCK_GROUP_MID, { sinceMs: t('group-history-005'), untilMs: t('group-history-010') })` → `ok`, ids `group-history-005`…`010` (6), `coverage: 'complete'`; cache now holds those 6 plus the 3 seeded; `mock.state.report().routeCounts` shows at least one previous-messages call.
  - `reports history_end at the start of history`: same client, range `group-history-000`…`010` → 11 ids, `coverage: 'history_end'`, `oldestReachedMs === t('group-history-000')`.
  - `reports session_expired for a token LINE rejects`: `createLineClient({ ...seededAuth, accessToken: makeMockLineJwt('unknown', now - 60, now + 86400 * 10) }, { lineApiBaseUrl: origin })` → `ok: false`, `session_expired`; cache unchanged; `mock.state.report()` shows an `unknown_access_token` rejection.
  - `reports unavailable when LINE cannot be reached`: start a second mock, keep its origin, stop it; client with a far-expiry token (as above) against that origin → `ok: false`, `unavailable`, `message === 'LINE unavailable: network error'` (proves the request was attempted, not a signer failure); cache unchanged.
  (Check `MockReport` fields in `tests/support/mock-line-server/state.ts` for the exact names of route counts and rejections.)
- [ ] **Step 2:** Run `npm run build && npx vitest run packages/line-client/src/message-range.mock.test.ts` — Expected: PASS. If one fails, the defect is in an earlier task's code; fix it there, never loosen the test.
- [ ] **Step 3:** Run `npm run test:unit` — Expected: PASS.
- [ ] **Step 4:** Commit `test(line-client): prove range fetch and typed errors against the LINE mock`.

### Task 7: Docs and gate

**Files:**
- Modify: `docs/ARCHITECTURE.md` (line-client section)
- Modify: `packages/line-client/README.md` only if it lists exports

- [ ] **Step 1:** Add a short paragraph: `getMessagesBetween` / `fetchMessageRange`, `coverage` semantics and how the source port should use `history_end` vs `truncated` (design D4), `LineReadError` kinds and mapping (401 and local auth → `session_expired`; refresh outage, network, 5xx, other → `unavailable`; displaced-session LINE codes unverified), and the cancellation hand-off (abort at the deadline; no write after abort).
- [ ] **Step 2:** Run `npm run verify` — Expected: exit 0.
- [ ] **Step 3:** Run `npx vitest run tests/artifacts/line-client-pack.test.ts` — Expected: PASS.
- [ ] **Step 4:** Commit `docs(line-client): document typed read errors and range fetch`.
