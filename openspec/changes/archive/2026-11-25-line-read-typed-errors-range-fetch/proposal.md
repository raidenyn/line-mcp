## Why

The expense-ledger source port (`catchUp`, `fetchRange`) must get either LINE messages or a typed error (`session_expired`, `unavailable`), and must re-fetch an exact stretch of history. Today `@raidenyn/line-client` only throws private error classes, and `withMessageCache` always fetches from the newest cached message, so an older range never reaches LINE. This shared package lands first and alone so the later M1 tasks can build on it.

## What Changes

- New exported typed failure for LINE message fetches: `LineReadError` with `kind` `session_expired` or `unavailable` and a fixed, secret-free message, produced internally from the private `LineHttpError`, `LineApiError`, local authentication state, token-refresh outcome and network failures.
- New `LineReadClient` (extends the unchanged `LineApiClient`, returned by `createLineClient`) with `getMessagesBetween(chatMid, sinceMs, untilMs, { signal? })` returning a result value `LineReadResult`: the messages of `[sinceMs, untilMs]`, a `coverage` of `complete`, `history_end` or `truncated`, and the oldest timestamp reached — or the typed error. Aborting the signal settles the call promptly and no further request is issued.
- New exported `fetchMessageRange(client, cache, ownerMid, chatMid, { sinceMs, untilMs, signal?, rejectTruncated? })` that stores the fetched range in the message cache whatever the newest cached message is, and writes nothing after a failure, an abort, or (on request) a truncated walk.
- Internal: a non-waiting authentication step and a per-caller token-refresh outcome for the typed read; `ensureAuthenticated` and the legacy refresh behaviour are unchanged.
- Non-breaking. `getMessages`, `getMessagesInRange`, `withMessageCache`, login, the messenger tools, OAuth and `line-mcp` sync behave as before. No cache schema change, no new dependencies.

## Capabilities

### New Capabilities
- `line-message-read`: reading a LINE chat's message history through `@raidenyn/line-client` — typed fetch failures and exact range fetch into the message cache.

### Modified Capabilities
(none)

## Impact

- `packages/line-client/src/client.ts` (walk refactor, `getMessagesBetween`, internal classifier, non-waiting auth and refresh outcome), new `packages/line-client/src/message-range.ts`, `packages/line-client/src/index.ts` exports, new unit tests in `packages/line-client/src/`.
- `docs/ARCHITECTURE.md`: one line on the new line-client surface.
- Untouched: `packages/line-client-sqlite`, `packages/line-client/assets/ltsm/`, all servers' behaviour.

## Design constraints

- **RFC:** [openspec/archived/design/expense-ledger/rfc-expense-ledger.md](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md) · **Milestone:** M1 Ledger
- **Task:** https://github.com/raidenyn/line-mcp/issues/131
- **Decisions this task implements:** Transaction-level consistency, Cache-untouched, Source port ([Decisions to approve](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#decisions-to-approve))
- **Contracts:** [Source port](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#source-port) (identity frozen, further members provisional), enabled, not produced here.
- **Conditions:**
  - Single release: no release is dispatched (`.github/workflows/release.yml`, manual only) between the first M1 merge and the end of M4.
  - Repo process (`AGENTS.md`): a `feat/<topic>` branch from `origin/main`, the full OpenSpec flow, this block copied into the change's proposal, an independent review before human review. OpenSpec capability: `expense-ledger` for every bank task, created by the task with key `expense-ledger/m1-ledger/2`; `line-message-read` for the LINE read task. No task picks another name.
  - `AGENTS.md`: a change to line-client packaging, vendoring or `assets` needs `npm run verify:all`. This task changes code only.
- **Rule:** Follow the frozen contracts and agreed decisions as written. If one turns out wrong, stop and propose an RFC amendment. Do not diverge in this change's own design.

## Facts filled in at reconcile (2026-11-24, `a56f130`)

- No task blocks this one; nothing to resolve from earlier tasks.
- Private errors: `LineHttpError`, `LineApiError` in `packages/line-client/src/client.ts`; range walk: `LineClient.getMessagesInRange` (same file); cache wrapper: `withMessageCache` in `packages/line-client/src/cached-message-reader.ts`.
- LINE mock: `tests/support/mock-line-server/` (`createMockLineServer`, seeded mode), answers unknown/expired/superseded access tokens with HTTP 401; it has no 5xx injection.
