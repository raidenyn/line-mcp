# LINE read: typed errors and range fetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@raidenyn/line-client` returns LINE messages or a typed error (`session_expired` | `unavailable`) and fetches an exact time range of a chat into the message cache.

**Architecture:** A pure classifier maps today's private errors to the typed failure. `LineClient`'s backwards history walk is extracted so a new `getMessagesBetween` can reuse it with an end bound and a "reached the start" flag, returning a result value. A new `fetchMessageRange` module stores that range through the existing `MessageCache.upsertMessages`.

**Tech Stack:** TypeScript (CommonJS, `tsc -b`), vitest, the in-process LINE mock in `tests/support/mock-line-server/`.

**Spec:** `openspec/changes/line-read-typed-errors-range-fetch/design.md` and `specs/line-message-read/spec.md` (read both; design D1–D5 are referenced below).

## Global Constraints

- Never edit `packages/line-client/assets/ltsm/*`. No new dependencies. No change in `packages/line-client-sqlite`.
- Existing behaviour and error message text of `getMessages`, `getMessagesInRange`, `withMessageCache` stay identical; existing tests are not modified.
- Error kinds are exactly `'session_expired' | 'unavailable'`.
- Commits: Conventional Commits, e.g. `feat(line-client): …`, `test(line-client): …`. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TDD per task (red → green). `npm run lint` must pass (the lint-on-edit hook reports errors after each edit; fix them).

## Review Focus

1. Boundary timestamps: a message with `createdTime === sinceMs` or `=== untilMs` is included (Task 3 test `includes both bounds`).
2. Failure on a later page (first page OK, previous-page call fails) yields `{ ok: false }`, never a partial `ok: true` (Task 3 test `fails whole range when a later page fails`).
3. Empty result inside a populated chat: range between two messages returns `[]` with `complete: true` (Task 3 test `empty range inside history`).
4. A login waiting for its PIN or a failed login maps to `session_expired`, and the message text is unchanged (Task 2 tests).
5. `fetchMessageRange` failure never calls `upsertMessages`, including a failure after messages were already received on earlier pages (Task 5 test `no write on failure`).

---

### Task 1: Typed failure and classifier

**Files:**
- Modify: `packages/line-client/src/client.ts` (types near the error classes, lines ~62–85)
- Test: `packages/line-client/src/client.test.ts` (append a `describe('classifyLineReadError')`)

**Interfaces:**
- Produces (exported from `client.ts`):
  ```ts
  export type LineReadErrorKind = 'session_expired' | 'unavailable';
  export interface LineReadError { kind: LineReadErrorKind; message: string; cause?: unknown }
  export interface MessageRange { messages: Message[]; complete: boolean; oldestReachedMs: number | null }
  export type LineReadResult = { ok: true; value: MessageRange } | { ok: false; error: LineReadError };
  export function classifyLineReadError(err: unknown): LineReadError;
  ```
  Also export (for tests only, not from `index.ts`) the two existing classes `LineHttpError`, `LineApiError` by adding `export` to their declarations.

- [ ] **Step 1: Write failing tests** — `it.each` rows, each asserting `classifyLineReadError(err).kind` and `.cause === err`:
  - `new LineHttpError(401, '/p')` → `session_expired`
  - `new LineHttpError(500, '/p')`, `new LineHttpError(503, '/p')`, `new LineHttpError(400, '/p')`, `new LineHttpError(403, '/p')`, `new LineHttpError(404, '/p')` → `unavailable`
  - `new LineApiError(10051, '/p')` → `unavailable`
  - `new TypeError('fetch failed')` → `unavailable`
  - `new DOMException('aborted', 'AbortError')` → `unavailable`
  - `new SyntaxError('Unexpected token')` → `unavailable`
  - `'a string'` → `unavailable`, and `message` is a non-empty string
  - `message` never contains the access token: for `new LineHttpError(401, '/p')` assert `message` equals `'LINE session expired; log in again'`; for unavailable, `message` starts with `'LINE unavailable: '`.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t classifyLineReadError` — Expected: FAIL (not exported).
- [ ] **Step 3:** Implement the types and `classifyLineReadError` in `client.ts`. Messages: `session_expired` → `'LINE session expired; log in again'`; `unavailable` → `'LINE unavailable: ' + (err instanceof Error ? err.message : String(err))`.
- [ ] **Step 4:** Run the same command — Expected: PASS; then `npx vitest run packages/line-client/src/client.test.ts` all PASS.
- [ ] **Step 5:** Commit `feat(line-client): add typed LINE read errors and classifier`.

### Task 2: Classifiable authentication failures

**Files:**
- Modify: `packages/line-client/src/client.ts` (`ensureAuthenticated`, ~line 274; `classifyLineReadError`)
- Test: `packages/line-client/src/client.test.ts`

**Interfaces:**
- Consumes: `classifyLineReadError` (Task 1).
- Produces: private `class LineNotAuthenticatedError extends Error` (exported from `client.ts` for tests only); `classifyLineReadError` maps it to `session_expired`.

- [ ] **Step 1: Write failing tests**:
  - `ensureAuthenticated` without auth: `await new LineClient(null, fetch).getMessages('c').catch(e => e)` → `e instanceof LineNotAuthenticatedError`, `e.message === 'Not authenticated. Call the login tool first and scan the QR code.'`, `classifyLineReadError(e).kind === 'session_expired'`.
  - `classifyLineReadError(new LineNotAuthenticatedError('Login failed: x')).kind === 'session_expired'`.
  - PIN pending: reuse the QR-login test setup in this file (describe `LineClient QR login`) to reach the `PIN required: …` throw; assert it is a `LineNotAuthenticatedError` and its message still starts with `'PIN required: Enter "'`.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: the new tests FAIL.
- [ ] **Step 3:** Throw `LineNotAuthenticatedError` (same message strings) at the three `throw new Error(...)` sites in `ensureAuthenticated`; add the classifier branch.
- [ ] **Step 4:** Run the same command — Expected: all PASS (existing tests unchanged).
- [ ] **Step 5:** Commit `feat(line-client): classify authentication failures as session_expired`.

### Task 3: Range walk with an end bound

**Files:**
- Modify: `packages/line-client/src/client.ts` (`getMessagesInRange`, ~lines 664–730)
- Test: `packages/line-client/src/client.test.ts` (new `describe('LineClient.getMessagesBetween')`, reuse `rawMsg`, `apiOk`, `apiErr`, `httpErr` helpers)

**Interfaces:**
- Consumes: `LineReadResult`, `classifyLineReadError` (Task 1).
- Produces:
  ```ts
  private walkHistory(chatMid: string, sinceMs: number, pageSize: number): Promise<{ raw: RawMessage[]; reachedSince: boolean }>;
  async getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, pageSize = 200): Promise<LineReadResult>;
  ```
  `reachedSince` is true iff some fetched message has `createdTime < sinceMs`. `getMessagesInRange` becomes `walkHistory` + its existing filter/name resolution/mapping, unchanged in behaviour.

- [ ] **Step 1: Write failing tests** (stubbed fetch, `pageSize` 2 where paging is needed):
  - `returns exactly the range across pages`: recent page `[m5@5000, m6@6000]`, previous page for boundary m5 `[m3@3000, m4@4000]`, previous for m3 `[m1@1000, m2@2000]`; `getMessagesBetween('g1', 2000, 4000, 2)` → `ok: true`, ids `['m2','m3','m4']`, `complete: true`, `oldestReachedMs: 1000`.
  - `includes both bounds`: messages at exactly `sinceMs` and `untilMs` are returned.
  - `empty range inside history`: messages at 1000 and 5000, range `[2000, 4000]` → `messages: []`, `complete: true`.
  - `reports start of history`: recent page `[m1@3000]` (short page), range `[1000, 4000]` → ids `['m1']`, `complete: false`, `oldestReachedMs: 3000`.
  - `empty chat`: recent `[]` → `messages: []`, `complete: false`, `oldestReachedMs: null`.
  - `rejects invalid range without a request`: each of `(5000, 4000)`, `(-1, 10)`, `(NaN, 10)`, `(0, Infinity)` → `rejects.toBeInstanceOf(RangeError)` and `mockFetch` not called (both bounds must be finite, `0 <= sinceMs <= untilMs`).
  - `maps 401 to session_expired`: recent route → `httpErr(401)` → `{ ok: false, error: { kind: 'session_expired' } }`.
  - `maps 500 to unavailable`, `maps business error to unavailable` (`apiErr(10004, 'x')`), `maps rejected fetch to unavailable` (`mockRejectedValue(new TypeError('fetch failed'))`).
  - `fails whole range when a later page fails`: recent full page OK, previous route → `httpErr(500)` → `ok: false`, kind `unavailable`.
  - `resolves sender names`: one `getContactsV2` stub as in the existing `resolves contact names once across all pages` test; `messages[0].senderName` is set.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t getMessagesBetween` — Expected: FAIL.
- [ ] **Step 3:** Extract `walkHistory` from `getMessagesInRange` (move the loop verbatim, track `reachedSince` where the existing `if (oldestTime < sinceMs) break;` fires and also when any page contains a message older than `sinceMs`); implement `getMessagesBetween`: validate (throw `RangeError` before `ensureAuthenticated`), then inside `try` `ensureAuthenticated` + walk + filter `sinceMs <= t <= untilMs` + `resolveContactNames` + `mapRawMessages`; `oldestReachedMs` = min `createdTime` of all fetched raw messages or `null`; `catch (err)` → `{ ok: false, error: classifyLineReadError(err) }`. Note: `resolveContactNames` already swallows its own failures (existing test `leaves senderName undefined when contact resolution fails`).
- [ ] **Step 4:** Run `npx vitest run packages/line-client/src/client.test.ts` — Expected: all PASS, including the existing `LineClient.getMessagesInRange` block.
- [ ] **Step 5:** Commit `feat(line-client): add getMessagesBetween range walk with end bound`.

### Task 4: Public client surface

**Files:**
- Modify: `packages/line-client/src/index.ts` (`LineApiClient`, `createLineClient`, exports)
- Modify: `packages/server/src/test-support.ts` (`fakeLineApi`)
- Test: `packages/line-client/src/client.test.ts` (in the existing `createLineClient` / gateway area)

**Interfaces:**
- Consumes: `LineClient.getMessagesBetween` (Task 3).
- Produces: `LineApiClient.getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number, pageSize?: number): Promise<LineReadResult>`; `index.ts` exports `classifyLineReadError` and types `LineReadError`, `LineReadErrorKind`, `LineReadResult`, `MessageRange`. `LineHttpError`, `LineApiError`, `LineNotAuthenticatedError` are NOT exported from `index.ts`.

- [ ] **Step 1: Write failing test** `createLineClient exposes getMessagesBetween`: `createLineClient(baseAuth, { fetch: stub })` where recent returns one message at 2000; `await api.getMessagesBetween('g1', 1000, 3000)` → `ok: true`, one message.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/client.test.ts -t getMessagesBetween` — Expected: FAIL (type/member missing).
- [ ] **Step 3:** Add the member and wiring; add exports; in `fakeLineApi()` add `getMessagesBetween: () => Promise.resolve({ ok: true, value: { messages: [], complete: true, oldestReachedMs: null } })`.
- [ ] **Step 4:** Run `npm run build` — Expected: exit 0; then `npx vitest run packages/line-client packages/server` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(line-client): expose getMessagesBetween and typed read errors`.

### Task 5: `fetchMessageRange` into the cache

**Files:**
- Create: `packages/line-client/src/message-range.ts`
- Modify: `packages/line-client/src/index.ts` (export)
- Test: `packages/line-client/src/message-range.test.ts`

**Interfaces:**
- Consumes: `LineApiClient['getMessagesBetween']`, `MessageCache` (`cached-message-reader.ts`), `LineReadResult`.
- Produces:
  ```ts
  export interface MessageRangeRequest { sinceMs: number; untilMs: number }
  export function fetchMessageRange(
    client: Pick<LineApiClient, 'getMessagesBetween'>,
    cache: Pick<MessageCache, 'upsertMessages'>,
    ownerMid: string, chatMid: string, range: MessageRangeRequest,
  ): Promise<LineReadResult>;
  ```
  Import `LineApiClient` as a type only (`import type`) to avoid a runtime cycle with `index.ts`; if that still creates a cycle in lint, define the client parameter as `{ getMessagesBetween(chatMid: string, sinceMs: number, untilMs: number): Promise<LineReadResult> }`.

- [ ] **Step 1: Write failing tests** with plain doubles:
  - `upserts the fetched range`: client resolves `ok: true` with 2 messages → result returned as-is (`toBe` same object), `upsertMessages` called once with `('owner', 'chat', messages)`; client called with `('chat', 1000, 2000)`.
  - `does not write an empty range`: `ok: true`, `messages: []` → `upsertMessages` not called.
  - `no write on failure`: client resolves `{ ok: false, error: { kind: 'unavailable', … } }` → returned, `upsertMessages` not called; same for `session_expired`.
  - `cache errors propagate`: `upsertMessages` throws `new Error('disk full')` → `rejects.toThrow('disk full')`.
  - `ignores the newest cached message`: the cache double also has `latestTimestamp` returning `9999`; assert it is never called and the client still receives `sinceMs: 1000`.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/message-range.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `message-range.ts`; export `fetchMessageRange` and `MessageRangeRequest` from `index.ts`.
- [ ] **Step 4:** Run the same command — Expected: PASS. Then `npm run lint` — Expected: no errors.
- [ ] **Step 5:** Commit `feat(line-client): add fetchMessageRange into the message cache`.

### Task 6: Acceptance tests against the LINE mock

**Files:**
- Test: `packages/line-client/src/message-range.mock.test.ts`

**Interfaces:**
- Consumes: `createLineClient`, `fetchMessageRange` (from `./index`); `createMockLineServer` from `../../../tests/support/mock-line-server/server`; `MOCK_GROUP_MID`, `makeMockLineJwt` from `../../../tests/support/mock-line-server/fixtures`. Signer is NOT mocked (the mock verifies HMACs).

Setup: `beforeAll` → `mock = createMockLineServer({ port: 0, controlToken: 't' })`, `{ origin } = await mock.start()`, `mock.state.configure({ scenarioId: 'range', mode: 'seeded', epochSeconds: Math.floor(Date.now()/1000), expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {} })`. (Configure after `start()`: `start()` calls `state.setOrigin(origin)`, and `configure` rebuilds fixtures from that origin and registers the seeded tokens. The seeded access token expires in 1 h, so the client's first call performs one token refresh against the mock — expected.) `afterAll` → `mock.stop({ verify: false })`. In-memory cache double: `Map<string, Message>` keyed by id implementing `upsertMessages`, `getMessages(owner, chat, since?, until?)` sorted by `createdTime`, `latestTimestamp`. `ownerMid` = `mock.state.fixtures.seededAuth.mid`.

- [ ] **Step 1: Write the tests**:
  - `fetches an older range below newer cached messages`: seed the cache with the three newest group fixture messages (`group-debit`, `group-credit`, `group-image` from `mock.state.fixtures.messagesByChat[MOCK_GROUP_MID]`); range = `createdTime` of `group-history-000` … `group-history-010`; `fetchMessageRange(api, cache, owner, MOCK_GROUP_MID, range)` → `ok: true`, ids `group-history-000`…`group-history-010` (11), `complete: false` (000 is the oldest history message, nothing older exists) and the cache now holds those 11 plus the 3 seeded. Add a second case with range `group-history-005`…`group-history-010` → `complete: true`.
  - `reports session_expired for a token LINE rejects`: `createLineClient({ ...seededAuth, accessToken: makeMockLineJwt('unknown', now - 60, now + 86400 * 10) }, { lineApiBaseUrl: origin })` → `ok: false`, kind `session_expired`; cache untouched.
  - `reports unavailable when LINE cannot be reached`: start a second mock, take its origin, stop it, then fetch against that origin → `ok: false`, kind `unavailable`.
- [ ] **Step 2:** Run `npx vitest run packages/line-client/src/message-range.mock.test.ts` — Expected: PASS (behaviour already built in Tasks 1–5; if a test fails, the defect is in the earlier task's code — fix there, not by loosening the test).
- [ ] **Step 3:** Run `npm run test:unit` — Expected: PASS (confirms the new test runs inside the unit suite and the relative import works outside `tsc -b`).
- [ ] **Step 4:** Commit `test(line-client): prove range fetch and typed errors against the LINE mock`.

### Task 7: Docs and gate

**Files:**
- Modify: `docs/ARCHITECTURE.md` (line-client section)
- Modify: `packages/line-client/README.md` only if it lists exports

- [ ] **Step 1:** Add 3–5 lines describing `getMessagesBetween`, `fetchMessageRange`, `LineReadError` kinds and the classifier mapping (401/auth → `session_expired`; else `unavailable`; real LINE displaced-session codes unverified).
- [ ] **Step 2:** Run `npm run verify` — Expected: exit 0.
- [ ] **Step 3:** Run `npx vitest run tests/artifacts/line-client-pack.test.ts` — Expected: PASS.
- [ ] **Step 4:** Commit `docs(line-client): document typed read errors and range fetch`.
