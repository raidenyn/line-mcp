## 1. Typed failures

- [ ] 1.1 Add the exported types `LineReadErrorKind`, `LineReadError`, `MessageRange`, `LineReadResult` and the pure `classifyLineReadError(err)` in `packages/line-client/src/client.ts` (design D1, D2); unit tests with constructed `LineHttpError`/`LineApiError`/`TypeError`/plain errors cover every row of the D2 table. Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 1.2 Make `ensureAuthenticated` throw a private `LineNotAuthenticatedError extends Error` with unchanged message text for "Not authenticated…", "Login failed…" and "PIN required…", and classify it as `session_expired`; existing `client.test.ts` cases pass unchanged. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 2. Range walk with an end bound

- [ ] 2.1 Extract the backwards walk of `LineClient.getMessagesInRange` into a private `walkHistory(chatMid, sinceMs, pageSize)` returning `{ raw, reachedSince }`, keeping `getMessagesInRange` behaviour identical (design D3). Verify: `npx vitest run packages/line-client/src/client.test.ts`
- [ ] 2.2 Add `LineClient.getMessagesBetween(chatMid, sinceMs, untilMs, pageSize = 200)` returning `LineReadResult` (inclusive bounds, `complete`, `oldestReachedMs`, `RangeError` on invalid range, failures classified); stubbed-`fetch` unit tests for multi-page range, start-of-history (`complete: false`), invalid range (no request sent), HTTP 401, HTTP 500, business-error envelope and rejected `fetch`. Verify: `npx vitest run packages/line-client/src/client.test.ts`

## 3. Public surface and cache fetch

- [ ] 3.1 Add `getMessagesBetween` to `LineApiClient` and wire it in `createLineClient`; add a stub returning an empty complete range to `fakeLineApi()` in `packages/server/src/test-support.ts`. Verify: `npm run build`
- [ ] 3.2 Create `packages/line-client/src/message-range.ts` with `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs })` (design D4) and export it, `classifyLineReadError` and the new types from `index.ts`; unit tests with doubles: upserts on success, no write on failure, cache-write errors propagate. Verify: `npx vitest run packages/line-client/src/message-range.test.ts`

## 4. Acceptance tests against the LINE mock

- [ ] 4.1 Add `packages/line-client/src/message-range.mock.test.ts` driving `createLineClient` against the in-process mock (design D5): an older range below newer cached messages is returned and cached (`complete: true`); an unknown access token gives `session_expired`; a stopped mock gives `unavailable`. Verify: `npx vitest run packages/line-client/src/message-range.mock.test.ts`

## 5. Docs and gate

- [ ] 5.1 Add the new line-client read surface (typed failures, `getMessagesBetween`, `fetchMessageRange`) to `docs/ARCHITECTURE.md` and `packages/line-client` README if it lists exports. Verify: `npm run lint`
- [ ] 5.2 Run the pre-PR gate and the packed-artifact check. Verify: `npm run verify && npx vitest run tests/artifacts/line-client-pack.test.ts`
