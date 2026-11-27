## Why

The expense ledger (RFC, M1) needs a per-owner home in `bank/bank.db` before any transaction can be stored. Today the bank tools are stateless text tools with no owner scoping and no typed errors. This change is the thinnest path through all of M1: an owner registers a LINE chat as a source with a base currency and a timezone, and the server reports it. Every later bank task builds on the envelope and the schema steps it introduces.

## What Changes

- New bank tool `manage_accounts` (composed server): add, get, list and update sources (`provider` `line`, `source_id` = chat MID, optional label, own timezone, `review_from`); get and update the owner's settings (base currency set once with the first source, owner timezone).
- New bank tool `ledger_status`: the owner's settings and sources, or `setup_required` with an `action` before the first source exists.
- New envelope helper in `@raidenyn/bank-mcp`: structured results and typed errors `{ code, message, action?, details? }` with the six contract codes; `idempotency_key` and `expected_revision` on writes. All validation runs inside it, so no answer of the new tools leaves the envelope.
- New ledger module `packages/bank-mcp/src/ledger/`: `LedgerStore` (owner-scoped, own connection to `bank/bank.db`), ordered additive schema steps recorded in `ledger_schema_steps`, first tables `ledger_owners`, `ledger_sources`, `ledger_idempotency`.
- Composed server opens and closes the `LedgerStore`; two tool guides; composed tool count ten → twelve.
- New architecture check: nothing reachable from `packages/bank-mcp/src/ledger/` imports `@raidenyn/line-client`.
- Non-breaking: the five existing bank tools, the legacy `categories` table and the LINE cache schema are unchanged; the standalone server is unchanged. No new dependency.

## Capabilities

### New Capabilities
- `expense-ledger`: the per-owner expense ledger of the bank tools — this change adds the tool envelope, ledger schema steps, sources and owner settings, `manage_accounts` and `ledger_status`, and the ledger import boundary.

### Modified Capabilities
(none)

## Impact

- New: `packages/bank-mcp/src/ledger/` (`schema.ts`, `ledger-store.ts`, `validation.ts`, `errors.ts` and tests), `packages/bank-mcp/src/ledger/request-hash.ts` and its test, `packages/bank-mcp/src/tools/{envelope,ledger-status,manage-accounts}.ts` and tests, `packages/bank-mcp/docs/guide/tools/{ledger_status,manage_accounts}.md`, `packages/server/src/ledger-isolation.test.ts`.
- Changed: `packages/bank-mcp/src/{index.ts,resources.ts,tools/index.ts,tools/deps.ts,register-tools.test.ts}`, `packages/bank-mcp/docs/guide/overview.md`, `packages/server/src/{server.ts,registrations.ts,test-support.ts,startup.test.ts,composition.test.ts}`, `packages/server/docs/guide/overview.md`, `tests/architecture/import-boundaries.test.ts`, `tests/support/smoke-helpers.ts`, `tests/docker/docker-smoke.test.ts`, `tests/e2e.test.ts`, `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `packages/server/src/data-layout.ts` (comment), and the "ten tools" comments in `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`.
- Data: new `ledger_` tables in `bank/bank.db`, created on first open; rollback leaves them unused.
- Untouched: `packages/line-client*`, `packages/line-mcp`, `packages/line-client/assets/ltsm/`, the LINE cache, the five existing bank tools.

## Size

The task estimates ~850 lines and ~14 files. Planning estimate: ~800 lines of production code (ledger module ~450, tools and envelope ~300, server wiring ~50), ~900 lines of tests (the acceptance criteria and review rounds asked for many validation and isolation cases), ~250 lines of guides and docs, ~37 files of which ~20 are one-line list or count updates. That is ~1,950 lines in total, about 2.3× the estimate and past the task's 1.5× stop rule ("If it does not fit"); production code alone (~800) is within it. **Owner decision needed before apply:** accept this size for one pull request, or name a split. There is no clean split point: the tools need the server wiring to be reachable, and acceptance criterion 3 needs the server. The decision is recorded here and in `handoff.md`; the size checkpoint at the end of tasks.md 2.2 compares against the accepted size.

## Design constraints

- **RFC:** [openspec/archived/design/expense-ledger/rfc-expense-ledger.md](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md) · **Milestone:** M1 Ledger
- **Task:** https://github.com/raidenyn/line-mcp/issues/132
- **Decisions this task implements:** Tool envelope, Ledger data model, Source port, Database placement, Import boundary, Review start, Product rules ([Decisions to approve](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#decisions-to-approve))
- **Contracts:** [Tool envelope](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#tool-envelope) (frozen), produced. [Ledger data model](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#ledger-data-model) (frozen once M1 ships), produced in part. [Source port](https://github.com/raidenyn/line-mcp/blob/main/openspec/archived/design/expense-ledger/rfc-expense-ledger.md#source-port) (identity frozen), source identity used.
- **Conditions:**
  - Single release: no release is dispatched (`.github/workflows/release.yml`, manual only) between the first M1 merge and the end of M4.
  - Repo process (`AGENTS.md`): a `feat/<topic>` branch from `origin/main`, the full OpenSpec flow, this block copied into the change's proposal, an independent review before human review. OpenSpec capability: `expense-ledger` for every bank task, created by the task with key `expense-ledger/m1-ledger/2`; `line-message-read` for the LINE read task. No task picks another name.
  - `docs/ARCHITECTURE.md` is updated in the same pull request (`AGENTS.md`, structural change).
- **Rule:** Follow the frozen contracts and agreed decisions as written. If one turns out wrong, stop and propose an RFC amendment. Do not diverge in this change's own design.

## Facts filled in at reconcile (2026-11-27, `d6baecb`)

- No task blocks this one. Task #131 (LINE read) merged as #163; nothing from it is consumed here.
- Owner: `LinePrincipal.subject === mid`, enforced in `packages/line-mcp/src/auth/line-auth-provider.ts`; bank tools read `context.principal.subject` per request.
- Bank tools are registered in `packages/bank-mcp/src/tools/index.ts` (`registerBankTools`), deps in `tools/deps.ts`, guides in `resources.ts` (`TOOL_GUIDES`); the composed server builds and closes stores in `packages/server/src/server.ts` and registers through `registrations.ts`; test fixture `packages/server/src/test-support.ts`.
- `bank/bank.db` is at `active.bankDbPath`; `stageBankCategories` (`category-migration.ts`) sets `PRAGMA user_version = 1` on it.
- Chat-MID rule for templates: `SAFE_MID_RE = /^[a-zA-Z0-9_-]+$/` in `template-store.ts`.
- MCP SDK 1.32.2 validates input against the zod schema before the handler and answers failures as plain text; with no `outputSchema` it passes `structuredContent`/`isError` through.
- The workspace uses pnpm (#162): the task's `npx vitest run …` and `npm run verify` are `pnpm exec vitest run …` and `pnpm run verify`.
- Tests that enumerate the tool surface and are extended (not weakened): `packages/bank-mcp/src/register-tools.test.ts`, `packages/server/src/composition.test.ts`, `tests/support/smoke-helpers.ts`, `tests/docker/docker-smoke.test.ts`, `tests/e2e.test.ts`.
