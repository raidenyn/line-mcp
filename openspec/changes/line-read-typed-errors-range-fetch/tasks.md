## 1. Typed failures

- [x] 1.1 Add the exported types `LineReadErrorKind`, `LineReadError`, `MessageRange`, `RangeCoverage`, `LineReadResult`, `MessageRangeOptions` and the internal, non-throwing `classifyLineReadError(err, context?)` with fixed messages and a non-enumerable `cause` in `packages/line-client/src/client.ts` (design D1, D2); unit tests cover every row of the D2 table, a token-bearing error, a malformed business code and a value that throws on inspection. Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [x] 1.2 Add the non-waiting `authenticateForRead()` and the per-caller `refreshOutcome()` (design D3) without changing `ensureAuthenticated` or legacy refresh behaviour; existing `client.test.ts` cases pass unchanged. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 2. Range walk with an end bound

- [x] 2.1 Extract the backwards walk of `LineClient.getMessagesInRange` into a private `walkHistory(chatMid, sinceMs, pageSize, { signal?, keepNonAdvancing })` returning `{ raw, stop }`, keeping `getMessagesInRange` behaviour identical (design D4). Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [x] 2.2 Add `LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)` returning `LineReadResult` (inclusive bounds, `coverage`, `oldestReachedMs`, `RangeError` on invalid range, whole-call failure on any page or contact failure, abort raced against the whole read with precedence and cancellation checkpoints (after auth, before each page/contact lookup, after signing before `fetch`), private `rangePageSize` test seam, stop reasons decided from the last page, auth classification incl. login-in-progress, refresh-outage and failed-login paths); stubbed-`fetch` unit tests per plan Task 3; then the size checkpoint of plan Task 3 Step 6. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 3. Public surface and cache fetch

- [x] 3.1 Add the exported `LineReadClient extends LineApiClient` with `getMessagesBetween`, return it from `createLineClient`, leave `LineApiClient` and `packages/server/src/test-support.ts` unchanged (design D4b). Verify: `npm run build && npx vitest run packages/line-client packages/server packages/line-mcp`
- [x] 3.2 Create `packages/line-client/src/message-range.ts` with `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal?, rejectTruncated? })` (design D4b) and export it and the new types from `index.ts` (not the classifier); unit tests with doubles: upserts on success, no write on failure, abort or refused truncation, cache-write errors propagate, `latestTimestamp` never read. Verify: `npx vitest run packages/line-client/src/message-range.test.ts`

## 4. Acceptance tests against the LINE mock

- [x] 4.1 Add `packages/line-client/src/message-range.mock.test.ts` driving the built `@raidenyn/line-client` against the in-process mock (design D5): an older range below newer cached messages is returned and cached (`coverage: 'complete'` for `005`…`010`, `'history_end'` for `000`…`010`); an unknown access token gives `session_expired`; a stopped mock gives `unavailable` with the network-error message and a recorded `fetch` to its recent-messages route. Verify: `npm run build && npx vitest run packages/line-client/src/message-range.mock.test.ts`

## 5. Docs and gate

- [x] 5.1 Add the new line-client read surface (typed failures, `getMessagesBetween`, `fetchMessageRange`, cancellation hand-off) to `docs/ARCHITECTURE.md` and the `packages/line-client` README if it lists exports. Verify: `npm run lint`
- [x] 5.2 Run the final size check (plan Task 7 Step 2), the pre-PR gate and the packed-artifact check. Verify: `npm run verify && npx vitest run tests/artifacts/line-client-pack.test.ts`
