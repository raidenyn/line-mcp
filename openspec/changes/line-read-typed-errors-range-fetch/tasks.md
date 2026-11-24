## 1. Typed failures

- [ ] 1.1 Add the exported types `LineReadErrorKind`, `LineReadError`, `MessageRange`, `LineReadResult`, `MessageRangeOptions` and the pure, non-throwing `classifyLineReadError(err, context?)` with fixed messages in `packages/line-client/src/client.ts` (design D1, D2); unit tests cover every row of the D2 table, a token-bearing error and an unstringifiable value. Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 1.2 Make `ensureAuthenticated` throw a private `LineNotAuthenticatedError extends Error` with unchanged message text (the "Login failed" site carries `pendingLoginError` as `cause`) and record a failed token-refresh status for the refreshing caller and concurrent waiters, without changing legacy behaviour; existing `client.test.ts` cases pass unchanged. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 2. Range walk with an end bound

- [ ] 2.1 Extract the backwards walk of `LineClient.getMessagesInRange` into a private `walkHistory(chatMid, sinceMs, pageSize, signal?)` returning `{ raw, reachedSince }`, keeping `getMessagesInRange` behaviour identical (design D3). Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 2.2 Add `LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, options?)` returning `LineReadResult` (inclusive bounds, `complete`, `oldestReachedMs`, `RangeError` on invalid range, whole-call failure on any page or contact failure, abort, auth classification incl. refresh-outage and failed-login paths); stubbed-`fetch` unit tests per plan Task 3. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 3. Public surface and cache fetch

- [ ] 3.1 Add `getMessagesBetween` to `LineApiClient` and wire it in `createLineClient`; add the stub from design D4 to `fakeLineApi()` in `packages/server/src/test-support.ts`. Verify: `npm run build && npx vitest run packages/line-client packages/server`
- [ ] 3.2 Create `packages/line-client/src/message-range.ts` with `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal? })` (design D4) and export it, `classifyLineReadError` and the new types from `index.ts`; unit tests with doubles: upserts on success, no write on failure or abort, cache-write errors propagate, `latestTimestamp` never read. Verify: `npx vitest run packages/line-client/src/message-range.test.ts`

## 4. Acceptance tests against the LINE mock

- [ ] 4.1 Add `packages/line-client/src/message-range.mock.test.ts` driving the built `@raidenyn/line-client` against the in-process mock (design D5): an older range below newer cached messages is returned and cached (`complete: true` for `005`…`010`, `complete: false` for `000`…`010`); an unknown access token gives `session_expired`; a stopped mock gives `unavailable`. Verify: `npm run build && npx vitest run packages/line-client/src/message-range.mock.test.ts`

## 5. Docs and gate

- [ ] 5.1 Add the new line-client read surface (typed failures, `getMessagesBetween`, `fetchMessageRange`, cancellation hand-off) to `docs/ARCHITECTURE.md` and the `packages/line-client` README if it lists exports. Verify: `npm run lint`
- [ ] 5.2 Run the pre-PR gate and the packed-artifact check. Verify: `npm run verify && npx vitest run tests/artifacts/line-client-pack.test.ts`
