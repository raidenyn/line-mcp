# LINE read: typed errors and range fetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@raidenyn/line-client` returns LINE messages or a typed error (`session_expired` | `unavailable`) and fetches an exact time range of a chat into the message cache.

**Architecture:** An internal classifier maps today's private errors, local auth state and the read's own refresh outcome to the typed failure. `LineClient`'s backwards history walk is extracted so a new `getMessagesBetween` can reuse it with an end bound and a coverage value; the whole read is raced against an optional abort signal. A new `fetchMessageRange` module stores the range through the existing `MessageCache.upsertMessages`, never after a failure, an abort, or (on request) a truncated walk.

**Tech Stack:** TypeScript (CommonJS, `tsc -b`), vitest, the in-process LINE mock in `tests/support/mock-line-server/`.

**Spec:** `openspec/changes/line-read-typed-errors-range-fetch/design.md` and `specs/line-message-read/spec.md` (read both; design D1–D5 are authoritative for names, types and messages).

## Global Constraints

- Never edit `packages/line-client/assets/ltsm/*`. No new dependencies. No change in `packages/line-client-sqlite`.
- Existing behaviour and error message text of `getMessages`, `getMessagesInRange`, `withMessageCache`, `ensureAuthenticated`, login and token refresh stay identical; existing tests are not modified.
- Error kinds are exactly `'session_expired' | 'unavailable'`; `LineReadError.message` only ever takes the fixed texts of design D2/D4/D4b; `cause` is non-enumerable.
- Public additions are only those listed in design D4b; the classifier, `pageSize` and the error classes stay internal.
- Size: the issue targets ~450 lines (~6 files) and requires a stop at ~1.5× (~675). Task 3 Step 6 and Task 7 Step 2 are size checkpoints.
- Commits: Conventional Commits, e.g. `feat(line-client): …`, `test(line-client): …`. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TDD per task (red → green). `npm run lint` must pass (the lint-on-edit hook reports errors after each edit; fix them).

## Review Focus

1. Boundary timestamps: messages at exactly `sinceMs` and `untilMs` are included (Task 3 `includes both bounds`).
2. Failure on a later page or during contact resolution yields `{ ok: false }`, never a partial `ok: true` (Task 3 `fails whole range when a later page fails`, `fails whole range when contacts fail`).
3. Refresh outcome is attributed per read (Task 3 `overlapping reads keep their own refresh outcome`).
4. Abort wins in every stage and writes nothing (Task 3 abort tests; Task 5 `no write after abort`).
5. Inclusive pagination ends in `history_end`; a replayed full page is `truncated` (Task 3 `inclusive pagination ends in history_end`, `replayed full page is truncated`).

---

### Task 1: Typed failure and classifier

**Files:**
- Modify: `packages/line-client/src/client.ts` (types and classifier next to `LineHttpError`/`LineApiError`, ~lines 62–85; add `export` to both classes)
- Test: `packages/line-client/src/client.test.ts` (new `describe('classifyLineReadError')`)

**Interfaces:**
- Produces (from `client.ts`, none re-exported from `index.ts` in this task): the D1 types; `export function classifyLineReadError(err: unknown, context?: { refreshFailedTransiently?: boolean }): LineReadError`; `export class LineHttpError`, `export class LineApiError`, new `export class LineNotAuthenticatedError extends Error` with constructor `(message: string, options?: { cause?: unknown })`. Helper `lineReadError(kind, message, cause?)` defines `cause` with `Object.defineProperty(…, { enumerable: false })` when a cause is given.

- [ ] **Step 1: Write failing tests** — `it.each` rows asserting `kind` and exact `message` (design D2 table), and `result.cause === err`:
  - `new LineHttpError(401, '/p')` → `session_expired`, `'LINE session expired; log in again'`; with `{ refreshFailedTransiently: true }` → `'LINE unavailable: token refresh failed'`
  - `new LineHttpError(500|503|429|400|403|404, '/p')` → `'LINE unavailable: HTTP <n>'`
  - `new LineApiError(10051, '/p')` → `'LINE unavailable: LINE error 10051'`; `new LineApiError('eyJsecret' as unknown as number, '/p')` → `'LINE unavailable: LINE error'`
  - `new TypeError('fetch failed')` → `'LINE unavailable: network error'`
  - `new LineNotAuthenticatedError('Not authenticated')`, `('Login in progress')` → `session_expired`
  - `LineNotAuthenticatedError` with cause `new LineHttpError(500, '/p')` → `'LINE unavailable: HTTP 500'`; cause `new TypeError()` → `'LINE unavailable: network error'`; cause `new LineHttpError(400, '/p')` → `session_expired`
  - `new SyntaxError('x')`, `'a string'`, `undefined`, `Object.create(null)` → `'LINE unavailable: unexpected error'`
  - `new Proxy({}, { get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } })` → does not throw, `'LINE unavailable: unexpected error'`
  - `new Error('Bearer eyJsecret.token')` → `message` does not contain `eyJsecret`
  - `cause is not serialized`: for `new LineApiError('eyJsecret' as unknown as number, '/p')`, `JSON.stringify(result)` does not contain `eyJsecret` and `Object.keys(result)` does not include `cause`.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t classifyLineReadError` — Expected: FAIL (not exported).
- [ ] **Step 3:** Implement per design D2 (whole inspection inside `try`; integers only via `Number.isInteger`).
- [ ] **Step 4:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: all PASS.
- [ ] **Step 5:** Commit `feat(line-client): add typed LINE read errors and classifier`.

### Task 2: Authentication for the typed read

**Files:**
- Modify: `packages/line-client/src/client.ts` (`refreshIfExpired` ~lines 238–272; new private `authenticateForRead` next to `ensureAuthenticated` ~274, which is not changed)
- Test: `packages/line-client/src/client.test.ts`

**Interfaces:**
- Consumes: `LineNotAuthenticatedError` (Task 1).
- Produces (design D3): `private refreshOutcome(): Promise<{ failedStatus: number | null }>` (legacy `refreshIfExpired` awaits it and ignores the value; the static `refreshLocks` value becomes an internal `{ data } | { failedStatus }` union shared with concurrent waiters; a rejected refresh `fetch` still propagates); `private authenticateForRead(): Promise<{ refreshFailedStatus: number | null }>`.

Tests call the private method via `(client as unknown as { authenticateForRead(): Promise<{ refreshFailedStatus: number | null }> })`.

- [ ] **Step 1: Write failing tests**:
  - `no auth → LineNotAuthenticatedError`, fetch not called.
  - `PIN pending → throws without waiting` (inside `describe('LineClient QR login')`): `makeLoginFetch(apiErr(10051, 'rejected', { code: 2 }))` with `checkPinCodeVerified` overridden to a never-resolving promise; `login()`, `await client.waitForPin()` resolves `'123456'`; then `authenticateForRead()` rejects with `LineNotAuthenticatedError` and no `getRecentMessagesV2` call was made.
  - `login failed keeps cause`: `makeLoginFetch(httpErr(500))`; after `waitForCompletion()` rejects, `authenticateForRead()` rejects with a `LineNotAuthenticatedError` whose `cause` is a `LineHttpError` with `status` 500.
  - `refresh failure is returned to each joined caller`: one client, JWT expiring in 1 h; `tokenRefresh` answers `httpErr(500)` from a deferred promise; start two `authenticateForRead()` calls, resolve the deferred; both resolve `{ refreshFailedStatus: 500 }`; `tokenRefresh` fetched once; access token unchanged.
  - Legacy guard: the existing `LineClient — JWT expiry` and `concurrent refresh deduplication` tests pass unchanged.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3:** Implement per design D3.
- [ ] **Step 4:** Run the same command — Expected: all PASS.
- [ ] **Step 5:** Commit `feat(line-client): add non-waiting authentication for typed reads`.

### Task 3: `getMessagesBetween`

**Files:**
- Modify: `packages/line-client/src/client.ts` (`getMessagesInRange` ~664–730; `fetchRawPage`/`fetchPreviousRawPage` ~612–628; `fetchContactsV2` ~588 and `resolveContactNames` ~630 gain an optional `signal`)
- Test: `packages/line-client/src/client.test.ts` (new `describe('LineClient.getMessagesBetween')` with its own `raw(id, createdTime, from = 'u1')` helper)

**Interfaces:**
- Consumes: Task 1 classifier/types; Task 2 `authenticateForRead`.
- Produces:
  ```ts
  private walkHistory(chatMid: string, sinceMs: number, pageSize: number, opts: { signal?: AbortSignal; keepNonAdvancing: boolean }): Promise<{ raw: RawMessage[]; stop: 'reached_since' | 'history_end' | 'truncated' }>;
  async getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions, pageSize = 200): Promise<LineReadResult>;
  ```

All success stubs answer `getContactsV2` with `apiOk({ contacts: {} })` unless stated. Paging tests pass `pageSize` 2 as the fifth argument.

- [ ] **Step 1: Write failing tests**:
  - Range and coverage:
    - `returns exactly the range across pages`: recent `[m5@5000, m6@6000]`; previous from m5 → `[m3@3000, m4@4000]`; from m3 → `[m1@1000, m2@2000]`; range `(2000, 4000)` → sorted ids `['m2','m3','m4']`, `coverage: 'complete'`, `oldestReachedMs: 1000`.
    - `includes both bounds`; `empty range inside history` (1000 and 5000, range `[2000,4000]` → `[]`, `complete`).
    - `inclusive pagination ends in history_end`: recent `[m3@3000, m4@4000]`; previous from m3 → `[m2@2000, m3@3000]`; previous from m2 → `[m2@2000]`; range `[0, 5000]` → ids `m2,m3,m4`, `history_end`, `oldestReachedMs: 2000`.
    - `short recent page is history_end`; `empty chat` (`[]`, `history_end`, `oldestReachedMs: null`).
    - `replayed full page is truncated`: recent `[m3@3000, m4@4000]`, previous returns `[m3@3000, m4@4000]` → `truncated`.
    - `progress-guard stop keeps received messages`: recent `[a@3000, b@3000]`, previous → `[c@3000, d@3000]`, range `[1000, 4000]` → ids `a,b,c,d`, `truncated`, exactly one previous-page call.
    - `iteration cap is truncated`: recent `[x1@2_000_000, x2@2_000_001]`; previous always returns two fresh messages strictly older than its boundary; range `[0, 3_000_000]` → `truncated`, `messages.length === 2002`.
    - `rejects invalid arguments without a request`: `(5000, 4000)`, `(-1, 10)`, `(NaN, 10)`, `(0, Infinity)`, and `pageSize` 1 → `RangeError`, fetch not called.
  - Errors:
    - `maps 401 to session_expired`, `maps 500 to unavailable`, `maps business error to unavailable` (`apiErr(10004, 'x')`), `maps rejected fetch to unavailable`.
    - `malformed business code is not leaked`: recent → HTTP 200 body `{ code: 'eyJsecret', message: 'x', data: null }` → `unavailable`, `'LINE unavailable: LINE error'`, `JSON.stringify(result)` lacks `eyJsecret`.
    - `not authenticated is session_expired` (fetch not called); `PIN pending is session_expired` (QR-login describe as in Task 2; no `getRecentMessagesV2` call); `failed login on HTTP 500 is unavailable` (QR-login describe, `makeLoginFetch(httpErr(500))`).
    - `refresh 500 then 401 is unavailable` (JWT expiring in 1 h; `tokenRefresh` → 500; recent → 401; `'LINE unavailable: token refresh failed'`); `401 without refresh is session_expired`.
    - `overlapping reads keep their own refresh outcome`: two clients sharing the `mid` with the same expiring JWT would share the lock, so use ONE client: read A starts, joins a deferred `tokenRefresh` that resolves `httpErr(500)`; its recent call returns a deferred `httpErr(401)`; after A's refresh settled, read B starts, its `tokenRefresh` (second call) succeeds with a new far-expiry token and its recent call returns `apiOk([])`; then release A's 401. Assert A → `unavailable` / `'LINE unavailable: token refresh failed'`, B → `ok`.
    - `fails whole range when a later page fails` (previous → 500); `fails whole range when contacts fail` (`getContactsV2` → 500).
    - `resolves sender names` (named contact for `u1`).
  - Abort (each result `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } }`):
    - `already-aborted signal` → fetch not called.
    - `aborts between pages`: previous-page stub aborts and returns a full page; no further previous call.
    - `aborts while signing is blocked`: `vi.mocked(signForAccount).mockImplementationOnce(() => new Promise(() => {}))`; start the read, abort, the read settles (await it with a 1 s `Promise.race` guard).
    - `abort wins over a 401 body read`: recent → `new Response(new ReadableStream({ start() {} }), { status: 401 })` (body never ends); abort with `controller.abort(new Error('deadline'))` → aborted, not `session_expired`.
    - `aborts during contact lookup`: `getContactsV2` returns a promise rejecting when `init.signal` aborts; abort after it is called.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t getMessagesBetween` — Expected: FAIL.
- [ ] **Step 3:** Implement per design D4: move the loop of `getMessagesInRange` verbatim into `walkHistory` with the stop reasons and the `keepNonAdvancing` branch; `getMessagesInRange` uses `keepNonAdvancing: false` and keeps its output. `getMessagesBetween`: validate, check `signal.aborted`, run the work in an inner async function, race it against a promise resolved by the signal's `abort` event (remove the listener afterwards), then apply D4 steps 4–5 (abort precedence via `signal?.aborted`).
- [ ] **Step 4:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: all PASS, including the existing `LineClient.getMessagesInRange` block.
- [ ] **Step 5:** Commit `feat(line-client): add getMessagesBetween range walk with end bound`.
- [ ] **Step 6: Size checkpoint.** Run `git diff --shortstat origin/main -- packages docs ':!*.test.ts'` and `git diff --shortstat origin/main -- '*.test.ts'`. If non-test source exceeds ~300 changed lines, or the projected total (tests included, Tasks 4–7 still to come) clearly exceeds ~675, STOP and report the numbers to the controller with a split proposal; do not continue.

### Task 4: Public client surface

**Files:**
- Modify: `packages/line-client/src/index.ts`
- Modify: `packages/server/src/test-support.ts` (`fakeLineApi`)
- Test: `packages/line-client/src/client.test.ts` (near `describe('LineClient gateway base URL')`)

**Interfaces:**
- Consumes: `LineClient.getMessagesBetween` (Task 3).
- Produces: `LineApiClient.getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions): Promise<LineReadResult>`; `index.ts` exports the types `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`, `RangeCoverage`, `MessageRangeOptions`. Not exported: the classifier, `LineHttpError`, `LineApiError`, `LineNotAuthenticatedError`.

- [ ] **Step 1: Write failing test** `createLineClient exposes getMessagesBetween`: `createLineClient(baseAuth, { fetch: stub })`, recent → one message at 2000, contacts → `{ contacts: {} }`; `getMessagesBetween('g1', 1000, 3000)` → `ok`, one message.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t "exposes getMessagesBetween"` — Expected: FAIL.
- [ ] **Step 3:** Add the member, wiring (default page size) and type exports; add the design D4b stub to `fakeLineApi()`.
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
  export interface MessageRangeRequest { sinceMs: number; untilMs: number; signal?: AbortSignal; rejectTruncated?: boolean }
  export function fetchMessageRange(
    client: { getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, options?: MessageRangeOptions): Promise<LineReadResult> },
    cache: Pick<MessageCache, 'upsertMessages'>,
    ownerMid: string, chatMid: string, range: MessageRangeRequest,
  ): Promise<LineReadResult>;
  ```

- [ ] **Step 1: Write failing tests** with plain doubles:
  - `upserts the fetched range`: client resolves `ok` with 2 messages → returned result `toBe` the client's; `upsertMessages` called once with `('owner', 'chat', messages)`; client called with `('chat', 1000, 2000, { signal: undefined })`.
  - `does not write an empty range`.
  - `no write on failure` (`unavailable` and `session_expired`).
  - `no write after abort`: client resolves `ok` with messages but aborts the passed controller first → `'LINE unavailable: aborted'`, no upsert.
  - `rejectTruncated refuses a truncated walk`: `coverage: 'truncated'` with messages, `rejectTruncated: true` → `{ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: history walk truncated' } }`, no upsert; without the flag → written and returned unchanged; `history_end` with the flag → written.
  - `cache errors propagate` (`upsertMessages` throws `new Error('disk full')`).
  - `ignores the newest cached message`: a spy `latestTimestamp` on the cache double is never called.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/message-range.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** Implement per design D4b; export `fetchMessageRange` and `MessageRangeRequest` from `index.ts`.
- [ ] **Step 4:** Run the same command — Expected: PASS. Then `npm run lint` — no errors.
- [ ] **Step 5:** Commit `feat(line-client): add fetchMessageRange into the message cache`.

### Task 6: Acceptance tests against the LINE mock

**Files:**
- Test: `packages/line-client/src/message-range.mock.test.ts`

**Interfaces:**
- Consumes: `createLineClient`, `fetchMessageRange`, `Message` from `@raidenyn/line-client` (the BUILT package — design D5; do not import `./index`, do not mock the signer); `createMockLineServer` from `../../../tests/support/mock-line-server/server`; `MOCK_GROUP_MID`, `makeMockLineJwt` from `../../../tests/support/mock-line-server/fixtures`.

Setup: `beforeAll` → `mock = createMockLineServer({ port: 0, controlToken: 't' })`; `({ origin } = await mock.start())`; `mock.state.configure({ scenarioId: 'range', mode: 'seeded', epochSeconds: now, expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: { unknown_access_token: 1 } })` (after `start()`, so fixtures carry the bound origin). One shared `api = createLineClient(mock.state.fixtures.seededAuth, { lineApiBaseUrl: origin })` for both success cases (its first call refreshes and supersedes the seeded pair). `afterAll` → `mock.stop({ verify: false })`. In-memory cache double: `Map` keyed by message id; `upsertMessages`, `getMessages(owner, chat)` sorted by `Number(createdTime)`. `ownerMid` = seeded `mid`. `t(id)` = `Number(fixture.createdTime)` of that group fixture. Compare ids as sorted arrays. Read `MockReport` in `tests/support/mock-line-server/state.ts` for the exact field names (`routeCounts`, observed expected rejections).

- [ ] **Step 1: Write the tests**:
  - `fetches an older range below newer cached messages`: seed the cache with `group-debit`, `group-credit`, `group-image`; `fetchMessageRange(api, cache, owner, MOCK_GROUP_MID, { sinceMs: t('group-history-005'), untilMs: t('group-history-010') })` → `ok`, 6 ids `group-history-005`…`010`, `coverage: 'complete'`; the cache holds those 6 plus the 3 seeded; the report shows a previous-messages call.
  - `reports history_end at the start of history`: same client, range `group-history-000`…`010` → 11 ids, `coverage: 'history_end'`, `oldestReachedMs === t('group-history-000')`.
  - `reports session_expired for a token LINE rejects`: `createLineClient({ ...seededAuth, accessToken: makeMockLineJwt('unknown', now - 60, now + 86400 * 10) }, { lineApiBaseUrl: origin })` → `ok: false`, `session_expired`; cache unchanged; the report shows the expected `unknown_access_token` rejection observed once.
  - `reports unavailable when LINE cannot be reached`: start a second mock, keep its origin, stop it; client with a far-expiry token and `fetch: spy` wrapping `globalThis.fetch` → `ok: false`, `'LINE unavailable: network error'`; the spy was called with a URL starting with that origin and containing `getRecentMessagesV2`; cache unchanged.
- [ ] **Step 2:** Run `npm run build && npx vitest run packages/line-client/src/message-range.mock.test.ts` — Expected: PASS. If one fails, the defect is in an earlier task's code; fix it there, never loosen the test.
- [ ] **Step 3:** Run `npm run test:unit` — Expected: PASS.
- [ ] **Step 4:** Commit `test(line-client): prove range fetch and typed errors against the LINE mock`.

### Task 7: Docs, size and gate

**Files:**
- Modify: `docs/ARCHITECTURE.md` (line-client section)
- Modify: `packages/line-client/README.md` only if it lists exports

- [ ] **Step 1:** Add a short paragraph: `getMessagesBetween` / `fetchMessageRange`; `coverage` and how the source port uses it (design D4b hand-off: live catch-up with `rejectTruncated`, re-request keeps partial results, abort at the deadline); `LineReadError` kinds and mapping (401 and local auth → `session_expired`; refresh outage, network, 5xx, other → `unavailable`; displaced-session LINE codes unverified); `cause` is for logs only.
- [ ] **Step 2: Final size check:** `git diff --shortstat origin/main -- . ':!openspec'`. Record the numbers for the PR. If the total exceeds ~675 lines, report it to the controller with a split proposal and the criteria it would leave unmet, before opening the PR.
- [ ] **Step 3:** Run `npm run verify` — Expected: exit 0.
- [ ] **Step 4:** Run `npx vitest run tests/artifacts/line-client-pack.test.ts` — Expected: PASS.
- [ ] **Step 5:** Commit `docs(line-client): document typed read errors and range fetch`.
