## 1. Typed failures

- [ ] 1.1 Add the exported types `LineReadErrorKind`, `LineReadError`, `MessageRange`, `RangeCoverage`, `LineReadResult`, `MessageRangeOptions` and the pure, non-throwing `classifyLineReadError(err, context?)` with fixed messages in `packages/line-client/src/client.ts` (design D1, D2); unit tests cover every row of the D2 table, a token-bearing error, a malformed business code and a value that throws on inspection. Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 1.2 Add the non-waiting `authenticateForRead(signal?)` and the per-caller `refreshOutcome()` (design D3) without changing `ensureAuthenticated` or legacy refresh behaviour; existing `client.test.ts` cases pass unchanged. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 2. Range walk with an end bound

- [ ] 2.1 Extract the backwards walk of `LineClient.getMessagesInRange` into a private `walkHistory(chatMid, sinceMs, pageSize, { signal?, keepNonAdvancing })` returning `{ raw, stop }`, keeping `getMessagesInRange` behaviour identical (design D4). Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 2.2 Add `LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)` returning `LineReadResult` (inclusive bounds, `coverage`, `oldestReachedMs`, `RangeError` on invalid range, whole-call failure on any page or contact failure, abort at every stage, auth classification incl. login-in-progress, refresh-outage and failed-login paths); stubbed-`fetch` unit tests per plan Task 3; then the size checkpoint of plan Task 3 Step 6. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 3. Public surface and cache fetch

- [ ] 3.1 Add `getMessagesBetween` to `LineApiClient` and wire it in `createLineClient`; add the stub from design D4b to `fakeLineApi()` in `packages/server/src/test-support.ts`. Verify: `npm run build && npx vitest run packages/line-client packages/server`
- [ ] 3.2 Create `packages/line-client/src/message-range.ts` with `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal? })` (design D4b) and export it, `classifyLineReadError` and the new types from `index.ts`; unit tests with doubles: upserts on success, no write on failure or abort, cache-write errors propagate, `latestTimestamp` never read. Verify: `npx vitest run packages/line-client/src/message-range.test.ts`

## 4. Acceptance tests against the LINE mock

- [ ] 4.1 Add `packages/line-client/src/message-range.mock.test.ts` driving the built `@raidenyn/line-client` against the in-process mock (design D5): an older range below newer cached messages is returned and cached (`coverage: 'complete'` for `005`…`010`, `'history_end'` for `000`…`010`); an unknown access token gives `session_expired`; a stopped mock gives `unavailable` with the network-error message. Verify: `npm run build && npx vitest run packages/line-client/src/message-range.mock.test.ts`

## 5. Docs and gate

- [ ] 5.1 Add the new line-client read surface (typed failures, `getMessagesBetween`, `fetchMessageRange`, cancellation hand-off) to `docs/ARCHITECTURE.md` and the `packages/line-client` README if it lists exports. Verify: `npm run lint`
- [ ] 5.2 Run the pre-PR gate and the packed-artifact check. Verify: `npm run verify && npx vitest run tests/artifacts/line-client-pack.test.ts`
