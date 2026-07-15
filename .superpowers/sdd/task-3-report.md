# Task 3: OAuth Account Selection and Durable Completion

## Status

Implemented OAuth account enumeration and opaque selection, including durable
completion ordering.

Commit: `3ef8b4c fix: select saved LINE accounts before OAuth login`

## RED Evidence

1. `npx vitest run src/oauth.test.ts -t "first-time QR|only saved certificate"`
   failed as expected: `login()` received no explicit `undefined` argument and
   a saved certificate was not selected.
2. `npx vitest run src/oauth.test.ts -t "multiple accounts|selected account|unknown selection session|tampered choice|selected record"`
   failed as expected: multiple accounts still started QR login, selector HTML
   was absent, and `POST /authorize/select` returned 404.
3. `npx vitest run src/oauth.test.ts -t "OAuth completion persistence"`
   failed as expected: completion was published before persistence and profile
   display names were not written.

## GREEN Evidence

1. Zero/one account focused tests: 2 passed.
2. Selector tests: 18 passed, including opaque choices, replay/tamper/deletion,
   expiry, duplicate names, legacy labels, and base-path submission.
3. Completion persistence tests: 3 passed.
4. `npx vitest run src/oauth.test.ts`: 55 passed.
5. `npm run test:unit`: 15 files and 301 tests passed.
6. `npm run build`: passed (`tsc` and distribution asset copies).

## Files Changed

- `src/oauth.ts`
  - Adds validated authorization requests, an opaque ten-minute selection
    session map, escaped selector HTML, and `POST <basePath>/authorize/select`.
  - Selects the saved certificate automatically for one account, and requires
    explicit opaque selection for multiple accounts.
  - Persists profile-enriched credentials before updating memory, publishing an
    authorization code, or marking login complete.
- `src/oauth.test.ts`
  - Adds isolated auth storage, constructed-client inspection, selector route
    tests, and persistence-order/profile fallback coverage.

## Self-Review

- Selector HTML is passed only labels and opaque random identifiers; MIDs and
  credentials remain in server-side maps and storage.
- Submission consumes its selection session before validating the opaque choice
  and reloading the selected record.
- Persistence failures set a credential-free failed state, emit no code, and do
  not update `latestAuthData`.
- `BASE_PATH` is used by the selector action and tested under `/line-mcp`.
- Scope is limited to Task 3 source/tests. `specs/proposals/` was pre-existing
  and left untouched.

## Concerns

- The requested subagent-dispatch workflow could not be performed because this
  environment exposes no subagent dispatch tool. The implementation received a
  direct source/test self-review and full unit/build verification instead.

## Review Findings Follow-up

### RED Evidence

1. `npx vitest run src/oauth.test.ts -t "startup errors|different completed account"`
   failed as expected: both QR-start routes returned the mocked secret-like
   exception text, and a selected account name was persisted to a different
   completed MID after profile lookup failed.

### GREEN Evidence

1. The same focused command passed: 3 tests passed. Both QR-start routes now
   return exactly `Failed to start LINE login; please try again.` and log only
   a fixed operational message. The selected display name is used only when
   its MID matches the completed account.
2. `npx vitest run src/oauth.test.ts`: 58 tests passed.
3. `npm run test:unit`: 15 files and 304 tests passed.
4. `npm run build`: passed (`tsc` and distribution asset copies).
