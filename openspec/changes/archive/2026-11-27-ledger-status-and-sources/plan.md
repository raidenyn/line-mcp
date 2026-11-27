# Ledger status and sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner registers a LINE chat as a ledger source with a base currency and a timezone through `manage_accounts`, and `ledger_status` lists it, both as structured results with typed errors.

**Architecture:** A new `packages/bank-mcp/src/ledger/` module holds the schema steps, an owner-scoped `LedgerStore` on `bank/bank.db` (own better-sqlite3 connection) with idempotency and revisions inside each write transaction, and pure validation. Two new tool files in `packages/bank-mcp/src/tools/` translate MCP input through one envelope helper. The composed server opens and closes the store; an architecture test keeps `ledger/` free of `@raidenyn/line-client`.

**Tech Stack:** TypeScript (CommonJS, `tsc -b`), better-sqlite3 12, zod 4, `@modelcontextprotocol/sdk` 1.32.2, vitest 4, pnpm 12.

**Spec:** `openspec/changes/ledger-status-and-sources/specs/expense-ledger/spec.md` and `design.md` (same folder). Read both; the design's tables and rules are the source of every value below.

**Task map:** plan Tasks 1–4 = tasks.md 1.1–1.4; Task 5 = 2.1; Task 6 = 2.2 (incl. the minimal server wiring); Task 7 = 2.3; Task 8 = 3.1; Task 9 = 4.1; Task 10 = 4.2; Task 11 = 4.3; Task 12 = 5.1–5.2. Tick the tasks.md box when the plan task's commit lands.

## Global Constraints

- No new dependency. Node built-ins (`crypto`, `Intl`), better-sqlite3 and zod only.
- `packages/bank-mcp/src/ledger/` imports only better-sqlite3, Node built-ins and files that do not reach `@raidenyn/line-client`.
- The five existing bank tools, the legacy `categories` table, `PRAGMA user_version` and the LINE cache schema stay unchanged.
- Error codes, exactly: `setup_required`, `invalid_argument`, `not_found`, `conflict`, `internal_error`, `line_session_expired`.
- Owner key: `context.principal.subject`, read inside each handler call (never destructured at registration).
- Every field of both tools' input schemas is `z.unknown().optional().meta({ type, description })`; every rule is checked in the handler.
- Idempotency window: 24 hours (`86_400_000` ms). Default `review_from`: three calendar months back, day clamped.
- Existing tests are only extended (new names, new counts), never weakened.
- Commits: Conventional Commits, scope `bank-mcp`, `server` or `architecture`; end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After any change to `packages/bank-mcp/src`, `packages/server` tests need `pnpm run build` first (they import `dist`).

## Review Focus

1. **A second "first" source** — two `add_source` calls for a fresh owner with different base currencies, one after the other through two stores: exactly one creates settings, the other is `conflict`. Test in Task 3 (`ledger-store.test.ts`: two stores on one temp file, sequential calls, second refused).
2. **Retry after a lost answer on a later day** — `add_source` without `review_from` replayed with the same key after midnight in the source's timezone returns the stored answer, not `conflict`. Test in Task 4.
3. **Agent sends `null` for optional fields** — `review_from: null` or `base_currency: null` on `add_source` is `invalid_argument`, not a crash or a silent default. Test in Task 6.
4. **Large or odd strings** — `label` over 200 characters and `idempotency_key` over 200 characters are `invalid_argument`; a label with quotes or emoji round-trips unchanged. Test in Task 1 (label rule) and Task 6 (round-trip).
5. **Reopening an existing data root** — a server restarted on a `bank.db` that already has ledger rows keeps them and runs no step twice. Test in Task 2 (reopen case).

---

### Task 1: Errors and validation

**Files:**
- Create: `packages/bank-mcp/src/ledger/errors.ts`, `packages/bank-mcp/src/ledger/validation.ts`
- Test: `packages/bank-mcp/src/ledger/validation.test.ts`

**Interfaces:**
- Produces:
  - `type LedgerErrorCode = 'setup_required' | 'invalid_argument' | 'not_found' | 'conflict' | 'internal_error' | 'line_session_expired'`
  - `class LedgerError extends Error { constructor(code: LedgerErrorCode, message: string, opts?: { action?: string; details?: Record<string, unknown> }); readonly code; readonly action?; readonly details? }`
  - `invalidArgument(field: string, message: string): LedgerError` (sets `details.field`)
  - `normalizeCurrency(value: unknown, field: string): string`
  - `normalizeTimezone(value: unknown, field: string): string`
  - `parseReviewFrom(value: unknown, field: string): string`
  - `parseLineSourceId(value: unknown): string`
  - `optionalString(value: unknown, field: string, maxLength: number): string | undefined`
  - `optionalNullableString(value: unknown, field: string, maxLength: number): string | null | undefined` (for `label`/`timezone` on update)
  - `optionalRevision(value: unknown): number | undefined`, `optionalIdempotencyKey(value: unknown): string | undefined`
  - `defaultReviewFrom(nowMs: number, timezone: string): string`
  - `LABEL_MAX = 200`, `IDEMPOTENCY_KEY_MAX = 200`, `LINE_SOURCE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/`

- [ ] **Step 1: Write the failing tests** — `describe('validation')` with:
  - `normalizeCurrency('thb')` → `'THB'`; `'ABC'`, `'TH'`, `5`, `null` throw `LedgerError` with `code: 'invalid_argument'` and `details.field` equal to the field name.
  - `normalizeTimezone('asia/bangkok')` → `'Asia/Bangkok'`; `normalizeTimezone('Asia/Kolkata') === normalizeTimezone('Asia/Calcutta')`; `'UTC'` → `'UTC'`; `'+07:00'`, `'Mars/Base'`, `''` throw `invalid_argument`.
  - `parseReviewFrom('2026-02-28')` ok; `'2026-02-30'`, `'2026-2-1'`, `'20260101'` throw.
  - `parseLineSourceId('c0123abc_-')` ok; `'a/b'`, `''`, a 101-char id throw.
  - `optionalString('x'.repeat(201), 'label', LABEL_MAX)` throws; `undefined` → `undefined`; `null` throws.
  - `optionalNullableString(null, 'label', LABEL_MAX)` → `null`.
  - `optionalRevision(0)`, `optionalRevision(1.5)`, `optionalRevision('1')` throw; `optionalRevision(3)` → `3`.
  - `defaultReviewFrom(Date.parse('2026-05-31T12:00:00Z'), 'UTC')` → `'2026-02-28'`; `defaultReviewFrom(Date.parse('2026-01-15T20:00:00Z'), 'Asia/Bangkok')` → `'2025-10-16'` (Bangkok is already the 16th).

- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run packages/bank-mcp/src/ledger/validation.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `errors.ts` and `validation.ts` with the signatures above. Currency: uppercase, then `Intl.supportedValuesOf('currency').includes(code)`. Timezone: `new Intl.DateTimeFormat('en-US', { timeZone })` in try/catch, take `resolvedOptions().timeZone`, accept only `'UTC'` or a member of `Intl.supportedValuesOf('timeZone')`. Comparisons of a stored timezone with input (`owner_timezone` on a later `add_source`, no-op detection) compare `normalizeTimezone(stored)` with `normalizeTimezone(input)`, so link names and ICU upgrades never cause a false `conflict`. Today in a timezone: `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })` parts.

- [ ] **Step 4: Run and see it pass.** Same command — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(bank-mcp): add ledger errors and input validation`.

### Task 2: Schema steps and store lifecycle

**Files:**
- Create: `packages/bank-mcp/src/ledger/schema.ts`, `packages/bank-mcp/src/ledger/ledger-store.ts`
- Test: `packages/bank-mcp/src/ledger/ledger-store.test.ts`

**Interfaces:**
- Consumes: Task 1 errors.
- Produces:
  - `interface SchemaStep { step: number; sql: string; run?: (db: Database.Database) => void }`
  - `const LEDGER_SCHEMA_STEPS: readonly SchemaStep[]` (step 1 = `ledger_owners`, `ledger_sources`, `ledger_idempotency`; `ledger_schema_steps` belongs to the runner)
  - `applySchemaSteps(db: Database.Database, steps?: readonly SchemaStep[], nowMs?: number): number[]` (returns applied step numbers)
  - `interface LedgerStoreOptions { now?: () => number; steps?: readonly SchemaStep[] }`
  - `class LedgerStore { constructor(dbPath: string, options?: LedgerStoreOptions); close(): void }`

- [ ] **Step 1: Write the failing tests** — `describe('LedgerStore lifecycle')`, each on a temp-dir `bank.db`:
  - `creates the ledger tables on a fresh file`: after construct, `sqlite_master` has `ledger_schema_steps`, `ledger_owners`, `ledger_sources`, `ledger_idempotency`; `SELECT step FROM ledger_schema_steps` = `[1]`.
  - `leaves user_version and the legacy categories table alone`: pre-create with `new CategoryStore(path)` + one upsert + `PRAGMA user_version = 1`; after `LedgerStore` open, `user_version` is `1` and the category row is still listed.
  - `reopens without re-running steps and keeps rows`: open, insert a `ledger_owners` row with raw SQL (store methods come in Task 3), close, reopen; the row is present and steps are still `[1]` (Review Focus 5).
  - `rolls back a failing step and closes the connection`: pass `steps: [...LEDGER_SCHEMA_STEPS, { step: 2, sql: 'CREATE TABLE ledger_x (a); SELECT nope FROM missing;' }]`; constructor throws; right after the throw, a `vi.spyOn(Database.prototype, 'close')` (better-sqlite3) set up before the constructor shows exactly one call — assert and `mockRestore()` it before reopening; then reopening the file with defaults shows no `ledger_x` and steps `[1]`.
  - `close is safe to call twice`.

- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run packages/bank-mcp/src/ledger/ledger-store.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Constructor mirrors `CategoryStore` (`mkdirSync(dirname)` unless `:memory:`), sets `PRAGMA busy_timeout = 5000`, runs `applySchemaSteps` inside `db.transaction`, and on any throw closes the db and rethrows. `applySchemaSteps` creates `ledger_schema_steps` with `CREATE TABLE IF NOT EXISTS` (the runner's own table, not a step), reads `MAX(step)`, runs each later step's `sql` (`db.exec`) then `run?.(db)`, inserts `(step, applied_at)`. Step-1 SQL: tables and columns exactly as design § Data model; `ledger_sources` has `UNIQUE(owner, provider, source_id)`; add index `ledger_idempotency(owner, created_at)`.

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Commit** — `feat(bank-mcp): add ledger schema steps and store lifecycle`.

### Task 3: Settings and sources

**Files:**
- Modify: `packages/bank-mcp/src/ledger/ledger-store.ts`
- Test: `packages/bank-mcp/src/ledger/ledger-store.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (all methods take the owner first; all inputs already validated/normalized by the tool layer; the store enforces state rules):
  - `interface LedgerSettings { base_currency: string; timezone: string; revision: number }`
  - `interface LedgerSource { provider: 'line'; source_id: string; native_id: string; label: string | null; timezone: string; own_timezone: string | null; review_from: string; last_caught_up_at: number | null; last_error: { code: string; message: string; at: number } | null; revision: number; created_at: number; updated_at: number }`
  - `interface WriteKeys { idempotencyKey?: string; requestHash?: string; expectedRevision?: number }`
  - `getSettings(owner: string): LedgerSettings` (throws `setup_required`)
  - `updateSettings(owner, patch: { timezone?: string; base_currency?: string }, keys: WriteKeys): { settings: LedgerSettings }`
  - `addSource(owner, input: { provider: 'line'; source_id: string; label?: string; timezone?: string; review_from?: string; base_currency?: string; owner_timezone?: string }, keys: WriteKeys): { settings: LedgerSettings; source: LedgerSource }`
  - `getSource(owner, provider: 'line', sourceId: string): { source: LedgerSource }` (throws `setup_required` / `not_found`)
  - `listSources(owner): { settings: LedgerSettings; sources: LedgerSource[] }` (ordered by `id`; throws `setup_required`)
  - `updateSource(owner, provider, sourceId, patch: { label?: string | null; timezone?: string | null; review_from?: string }, keys: WriteKeys): { source: LedgerSource }`
  - `export const SETUP_ACTION = 'Call manage_accounts with action add_source, a base_currency and an owner_timezone.'`

- [ ] **Step 1: Write the failing tests** — `describe('LedgerStore settings and sources')` with `now` injected (`2026-05-31T12:00:00Z`):
  - `answers setup_required before the first source` for `getSettings`, `listSources`, `getSource`, `updateSource`, `updateSettings` (each error has `action === SETUP_ACTION`).
  - `first addSource requires base_currency and owner_timezone`: missing either → `invalid_argument`.
  - `first addSource creates settings and the source`: settings `{ base_currency: 'THB', timezone: 'Asia/Bangkok', revision: 1 }`; source `native_id === source_id`, `own_timezone: null`, `timezone: 'Asia/Bangkok'`, `review_from: '2026-02-28'`, `revision: 1`, `last_caught_up_at: null`, `last_error: null`.
  - `refuses another base currency on addSource and updateSettings`: `conflict`, `details.current === 'THB'`; same value accepted.
  - `refuses another owner_timezone on a later addSource`: `conflict` whose `action` mentions `update_settings`.
  - `refuses a duplicate source`: `conflict`, `details.source.source_id`.
  - `inherits the owner timezone until the source sets its own`: `updateSettings({ timezone: 'Europe/Berlin' })` → source `timezone: 'Europe/Berlin'`, `own_timezone: null`; `updateSource({ timezone: 'Asia/Tokyo' })` → own; `updateSource({ timezone: null })` → inherited again.
  - `clears a label with null`.
  - `no-op update keeps the revision; a change raises it by 1`.
  - `expected_revision`: stale on `updateSource` → `conflict`, `details.current_revision: 2`, row unchanged; on `addSource` before settings with `expectedRevision: 1` → `conflict`, `details.current_revision: null`; on `updateSettings` stale → `conflict`.
  - `scopes everything by owner`: owner `b` gets `not_found` for `a`'s source after `b` has its own; same `source_id` for both owners with different labels coexists.
  - Review Focus 1: `two stores on one file: a second first-source after another, with another currency, is conflict` (sequential is enough: better-sqlite3 is synchronous and AGENTS.md forbids two servers on one data root, so the transaction's own check is what must hold).
  - `a given timezone pins the source`: on a source with `own_timezone: null`, `updateSource({ timezone: <owner's zone> })` sets `own_timezone` (compared with the stored own value, not the effective one); a later owner change leaves the source on the pinned zone.

- [ ] **Step 2: Run and see it fail.**

- [ ] **Step 3: Implement** each method as one `db.transaction(...)` (prepared statements), raising `LedgerError` per design § `manage_accounts` Rules. Effective timezone = `COALESCE(s.timezone, o.timezone)` via a join on read. Default `review_from` = `defaultReviewFrom(now(), effectiveTimezone)`.

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Commit** — `feat(bank-mcp): add owner-scoped ledger settings and sources`.

### Task 4: Idempotency

**Files:**
- Modify: `packages/bank-mcp/src/ledger/ledger-store.ts`; Create: `packages/bank-mcp/src/ledger/request-hash.ts`
- Test: `packages/bank-mcp/src/ledger/ledger-store.test.ts`, `packages/bank-mcp/src/ledger/request-hash.test.ts`

**Interfaces:**
- Consumes: Task 3 write methods and `WriteKeys`.
- Produces: `requestHash(args: Record<string, unknown>): string` — SHA-256 hex of canonical JSON (keys sorted recursively), with `idempotency_key` removed; `IDEMPOTENCY_TTL_MS = 86_400_000`. Write methods take `tool: string` implicitly as `'manage_accounts'` (constant `MANAGE_ACCOUNTS_TOOL`).

- [ ] **Step 1: Write the failing tests**:
  - `request-hash.test.ts`: key order does not change the hash; `idempotency_key` does not change it; a changed value does.
  - `ledger-store.test.ts` `describe('idempotency')`:
    - `replays update_source once`: two calls with key `k`, same hash → deep-equal results; stored `revision` is 2 (from 1); `updated_at` equals the first call's even though `now` advanced.
    - `replays a retried add_source instead of conflict`.
    - `refuses the same key with another request hash`: `conflict`, nothing changed.
    - `does not record a refused write`: a `conflict` with key `k`, then a corrected write with `k` succeeds.
    - `expires keys after 24 hours`: advance `now` by `IDEMPOTENCY_TTL_MS + 1`; same key with another hash is applied.
    - `keys are per owner`.
    - Review Focus 2 (store level): `add_source replay across midnight`: first call at `2026-05-31T16:59:00Z` (`Asia/Bangkok` 23:59), replay at `17:01Z` → identical answer.

- [ ] **Step 2: Run and see it fail.**

- [ ] **Step 3: Implement.** In each write transaction, before any other check: `DELETE FROM ledger_idempotency WHERE owner = ? AND created_at < ?` (now − TTL); if `idempotencyKey` set, select the row; hash equal → `return JSON.parse(response)`; differs → `conflict` (`details.reason: 'idempotency_key_reused'`). After a successful write, insert `(owner, tool, key, request_hash, response, created_at)`.

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Commit** — `feat(bank-mcp): make ledger writes idempotent`.

### Task 5: Envelope helper

**Files:**
- Create: `packages/bank-mcp/src/tools/envelope.ts`
- Test: `packages/bank-mcp/src/tools/envelope.test.ts`

**Interfaces:**
- Consumes: `LedgerError`, `LedgerErrorCode` (Task 1).
- Produces:
  - `export type { LedgerErrorCode as ToolErrorCode }`
  - `interface ToolError { code: ToolErrorCode; message: string; action?: string; details?: Record<string, unknown> }`
  - `okResult(result: Record<string, unknown>): CallToolResult` — `{ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }`
  - `errorResult(error: ToolError): CallToolResult` — `isError: true`, `structuredContent: { error }`, same text
  - `runTool(fn: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult>` — maps `LedgerError` → its fields, anything else → `{ code: 'internal_error', message: 'Internal error in the ledger.' }` and writes the original error to `process.stderr` (the answer never contains it)
  - `INTERNAL_ERROR_MESSAGE = 'Internal error in the ledger.'`

- [ ] **Step 1: Write the failing tests**: success shape and text equals `JSON.stringify(structuredContent)`; `LedgerError('conflict', 'm', { details: { a: 1 } })` → `isError`, `structuredContent.error` `{ code: 'conflict', message: 'm', details: { a: 1 } }` with no `action` key; a thrown `new Error('SQLITE secret')` → `internal_error`, text does not contain `SQLITE`, and a `process.stderr.write` spy saw `SQLITE secret`.
- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run packages/bank-mcp/src/tools/envelope.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(bank-mcp): add the bank tool envelope helper`.

### Task 6: `ledger_status` and `manage_accounts` tools

**Files:**
- Create: `packages/bank-mcp/src/tools/ledger-status.ts`, `packages/bank-mcp/src/tools/manage-accounts.ts`
- Modify: `packages/bank-mcp/src/tools/deps.ts`, `packages/bank-mcp/src/tools/index.ts`, `packages/bank-mcp/src/index.ts`, `packages/bank-mcp/src/register-tools.test.ts`, and — so `tsc -b` and the turn-end gate stay green, because `ledger` is a required field of `BankToolDeps` — `packages/server/src/server.ts` (open `LedgerStore(active.bankDbPath)` right after `CategoryStore`, assign `let ledgerStore` at once, pass it in `bankToolDeps`, close it in `stop()` next to `categoryStore?.close()`), `packages/server/src/test-support.ts` (build `new LedgerStore(path.join(dataRoot, 'bank', 'bank.db'))`, expose as `ComposedFixture.ledger`, close in `cleanup()` before `categories.close()`), `packages/server/src/composition.test.ts` (twelve tools incl. `ledger_status`, `manage_accounts`; resources stay eleven until Task 7)
- Test: `packages/bank-mcp/src/tools/ledger-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `BankToolDeps<P>` gains `ledger: LedgerStore`.
  - `registerLedgerStatus<P>(server, context, deps): void`, `registerManageAccounts<P>(server, context, deps): void`, called by `registerBankTools` after the five existing tools.
  - `src/index.ts` exports `LedgerStore`, `LEDGER_SCHEMA_STEPS`, type `LedgerSource`, `LedgerSettings`.
  - Tool inputs (all `z.unknown().optional().meta(...)`): `ledger_status`: none (no `inputSchema`; any argument is stripped by the SDK and ignored). `manage_accounts`: `action` (string, enum in description), `provider`, `source_id`, `label`, `timezone`, `review_from`, `base_currency`, `owner_timezone` (strings), `idempotency_key` (string), `expected_revision` (integer).
  - Per-action allowed fields (anything else present → `invalid_argument` with `details.field`): `add_source`: provider, source_id, label, timezone, review_from, base_currency, owner_timezone, write keys. `get_source`: provider, source_id. `list_sources`, `get_settings`: none. `update_source`: provider, source_id, label, timezone, review_from, write keys. `update_settings`: timezone, base_currency, write keys.

- [ ] **Step 1: Write the failing tests** in `ledger-tools.test.ts`, over a real `McpServer` connected to a `Client` with `InMemoryTransport.createLinkedPair()`, `LedgerStore(':memory:', { now })`, a context whose `principal` getter returns a mutable principal:
  - AC1 `ledger_status before setup is setup_required with an action`.
  - AC2 `add_source then ledger_status lists the source`; `update_settings with another base_currency is conflict`.
  - AC4 `same idempotency_key on update_source is applied once`; `stale expected_revision is conflict`.
  - `validation stays inside the envelope`: each of `{ action: 'add_source', provider: 'x', … }`, `provider: 5`, `label: null` on add, `expected_revision: 0`, `{}` (no action), `action: 'nope'`, `owner_timezone: 'Mars/Base'`, `owner_timezone: '+07:00'`, `base_currency: 'ABC'`, `source_id: 'a/b'`, `idempotency_key` on `list_sources`, `idempotency_key` on `list_sources` before setup (→ `invalid_argument`, not `setup_required`: argument checks run first), `base_currency` on `update_source`, Review Focus 3 `review_from: null` and `base_currency: null` on add, and an `idempotency_key` of 201 chars → `isError` and `structuredContent.error.code === 'invalid_argument'`.
  - Review Focus 2 (tool level, where the hash is computed): `add_source` without `review_from` at `2026-05-31T16:59:00Z` with key `k` and `owner_timezone: 'Asia/Bangkok'`, replayed at `17:01Z` → identical answer, not `conflict`.
  - `accepts thb as THB`; `label: null on update_source clears it`; Review Focus 4 `label with quotes and emoji round-trips`.
  - Timezone cases of design § Tests (inherit, own, reset, `owner_timezone` conflict, default `review_from` in the source's effective timezone).
  - `tools/list advertises types and the required action`: `manage_accounts.inputSchema.properties.provider.type === 'string'`, `expected_revision.type === 'integer'`, description matches `/action.*required/i`.
  - `register-tools.test.ts`: tool list adds `ledger_status`, `manage_accounts` (seven); both `makeDeps` helpers (`makeDeps`, `makeTimeoutDeps`) gain `ledger: new LedgerStore(':memory:')`, pushed into a module-level `ledgers: LedgerStore[]` that `afterEach` closes and clears (helpers are called more than once per test).

- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run packages/bank-mcp/src/tools/ledger-tools.test.ts packages/bank-mcp/src/register-tools.test.ts`
- [ ] **Step 3: Implement** both tools with `runTool`. The handler computes `requestHash(args)` from the received arguments before any normalization, validates per action with Task 1 helpers, then calls the store with `context.principal.subject`. Update the `BankToolDeps` comment (ledger is owner-scoped, unlike the shared stores) and the `registerBankTools` doc comment (seven tools).
- [ ] **Step 4: Run and see it pass.** Run: `pnpm exec vitest run packages/bank-mcp/src/tools/ledger-tools.test.ts packages/bank-mcp/src/register-tools.test.ts && pnpm run build && pnpm exec vitest run packages/server`
- [ ] **Step 5: Commit** — `feat(bank-mcp): add ledger_status and manage_accounts tools`.
- [ ] **Step 6: Size checkpoint.** Run: `git diff --shortstat origin/main...HEAD -- . ':!pnpm-lock.yaml' ':!openspec'` and compare with the size the owner accepted (proposal § Size). If the total is already past it, stop and report to the owner (task rule "If it does not fit") before Task 7.

### Task 7: Guides

**Files:**
- Create: `packages/bank-mcp/docs/guide/tools/ledger_status.md`, `packages/bank-mcp/docs/guide/tools/manage_accounts.md`
- Modify: `packages/bank-mcp/src/resources.ts` (`TOOL_GUIDES`, doc comment), `packages/bank-mcp/docs/guide/overview.md`, `packages/bank-mcp/src/register-tools.test.ts` (resource counts: `server.resources.size` 6 → 8 at line 466 with the overview, the guide URIs 5 → 7 at line 474), `packages/server/src/composition.test.ts` (thirteen resources incl. both guide URIs; test title at line 82 "eleven resources … ten tool guides" → thirteen / twelve)

- [ ] **Step 1: Extend the resource test** (and `BANK_TOOLS` in `tests/support/smoke-helpers.ts` with both tool names, so the smoke suite's exact surface check is green from this task on) to expect `line://guide/tools/ledger_status` and `line://guide/tools/manage_accounts`, and that each reads without "Guide file not found". `FakeServer.registerResource` (line 28) currently drops the reader: extend it to keep the reader per URI (an extension; no existing assertion changes) and call it in the new test.
- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run packages/bank-mcp/src/register-tools.test.ts`
- [ ] **Step 3: Write the guides** — when to use, each action with required/optional fields, write keys and their semantics (24 h, per owner), every error code with its typical cause, setup flow (first `add_source` with `base_currency` + `owner_timezone`; base currency can never change), `review_from` default and on-boarding override, timezone inheritance, wrong-JSON-type arguments answered as `invalid_argument`. Add both to `TOOL_GUIDES` and the bank overview.
- [ ] **Step 4: Run and see it pass.** Run: `pnpm exec vitest run packages/bank-mcp/src/register-tools.test.ts && pnpm run build && pnpm exec vitest run packages/server/src/composition.test.ts`
- [ ] **Step 5: Commit** — `docs(bank-mcp): add ledger tool guides`.

### Task 8: Ledger import boundary

**Files:**
- Modify: `tests/architecture/import-boundaries.test.ts`

**Interfaces:**
- Produces (test-local): `ledgerBoundaryViolations(dir: string): Array<{ file: string; chain: string[] }>`.

- [ ] **Step 1: Write the failing tests** — `describe('bank-mcp ledger import boundary')`:
  - `the ledger directory exists and has no line-client import`: `packages/bank-mcp/src/ledger` exists, has ≥ 1 `.ts`, `ledgerBoundaryViolations(...)` → `[]`.
  - Fixture cases (each in `fs.mkdtempSync`, a `checked/` subdir): `import { x } from '@raidenyn/line-client'`; `import type { M } from '@raidenyn/line-client'`; `export { y } from '@raidenyn/line-client'`; `import '@raidenyn/line-client/dist/client'`; `checked/a.ts` importing `'../outside'` where `outside.ts` imports `@raidenyn/line-client` → each reports one violation; the indirect case's `chain` ends with the `outside.ts` path.
- [ ] **Step 2: Run and see it fail.** Run: `pnpm exec vitest run tests/architecture/import-boundaries.test.ts`
- [ ] **Step 3: Implement** with the specifier regex `/['"]([^'"\n]+)['"]/g` restricted to import contexts by matching `from\s*['"]`, `import\s*['"]`, `import\(\s*['"]`, `require\(\s*['"]`; resolve relative specifiers to `<p>.ts` or `<p>/index.ts`; visited set; flag `^@raidenyn/line-client(/|$)`.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `test(architecture): keep the bank ledger free of line-client`.

### Task 9: Composed server lifecycle

**Files:**
- Modify: `packages/server/src/server.ts`, `packages/server/src/startup.test.ts`

**Interfaces:**
- Consumes: `LedgerStore` export (Task 6).

- [ ] **Step 1: Write the failing tests** in `startup.test.ts`:
  - Mock `bankMcpModule.LedgerStore` like `CategoryStore` (push `'open-ledger-store'`); the exact boot-order list becomes `[…, 'open-bank-store', 'open-ledger-store', 'create-regex-executor', …]`.
  - In `closes database stores when executor shutdown rejects`: spy `LedgerStore.prototype.close`, expect 1 call and the executor error rethrown.
  - `stop() is idempotent` still passes with the real store.
  - `a failing store close does not leave the others open`: mock `LedgerStore.prototype.close` once to call the real close and then throw; `stop()` rejects with that error, `CategoryStore.prototype.close` and `SqliteMessageCache.prototype.close` were each called once; then set `server = undefined`.
- [ ] **Step 2: Run and see it fail.** Run: `pnpm run build && pnpm exec vitest run packages/server/src/startup.test.ts` — Expected: only the failing-close case fails (Task 6 already opens and closes the store, so the boot-order and executor-failure cases may already pass).
- [ ] **Step 3: Implement.** In `stop()`, close `ledgerStore`, `categoryStore`, `cache` each in its own try, remember the first error, rethrow the executor failure first, then the first close error. (The store itself was wired in Task 6.)
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** — `feat(server): close every store on stop even when one fails`.

### Task 10: Two-owner isolation

**Files:**
- Create: `packages/server/src/ledger-isolation.test.ts`

- [ ] **Step 1: Write the test** modelled on `trusted-tenant.test.ts` (`buildComposedFixture`, `seedTestToken('token-alice', { …, mid: 'u-alice' })` and `token-bob`/`u-bob`, HTTP clients):
  - `beforeAll`: Alice `add_source` `c-alice-chat` (THB, Asia/Bangkok); Bob `add_source` `c-bob-chat` (USD, UTC).
  - `another owner's source is not_found and never listed` (AC3): Bob `get_source` / `update_source` (`label: 'x'`) on `c-alice-chat` → `not_found`; Alice `get_source` shows `revision: 1`, no label; Bob `list_sources` and `ledger_status` are non-empty, contain `c-bob-chat` and do not contain `c-alice-chat` (no exact list, so the result does not depend on test order).
  - `both owners can register the same chat`: both add `c-shared` with labels `A`/`B`; each `get_source` shows own label.
  - `idempotency keys are per owner`: Alice `update_source` with key `same-key`; Bob `update_source` on his own source with `same-key` and other arguments → applied (not `conflict`).
- [ ] **Step 2: Run it.** Run: `pnpm run build && pnpm exec vitest run packages/server/src/ledger-isolation.test.ts` — Expected: PASS (behaviour from Tasks 3–9). If it fails, fix the store, not the test.
- [ ] **Step 3: Commit** — `test(server): prove ledger owner isolation over HTTP`.

### Task 11: Tool-surface lists and smoke

**Files:**
- Modify: `packages/server/src/registrations.ts` and `packages/server/src/data-layout.ts` (comments: twelve tools, thirteen resources), `tests/support/smoke-helpers.ts`, `tests/docker/docker-smoke.test.ts`, `tests/e2e.test.ts`

- [ ] **Step 1: Extend the lists** (`BANK_TOOLS` was done in Task 7): Docker smoke composed list gains both (title line 159 → "twelve composed tools"). e2e resource list gains both guide URIs (title line 277 → "all 13 guide URIs"). In `runComposedBankAssertions`, before the template steps: `ledger_status` → `isError` and `structuredContent.error.code === 'setup_required'`; `manage_accounts` `add_source` for `MOCK_GROUP_MID` (`base_currency: 'THB'`, `owner_timezone: 'UTC'`) → no `isError`; `ledger_status` → `structuredContent.sources[0].source_id === MOCK_GROUP_MID`.
- [ ] **Step 2: Run.** Run: `pnpm run build && pnpm run test:smoke` — Expected: PASS (mock LINE request counts unchanged: the ledger tools make no LINE call).
- [ ] **Step 3: Commit** — `test(server): extend the composed tool surface to twelve tools`.

### Task 12: Docs and gate

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`, `AGENTS.md`, `packages/server/docs/guide/overview.md`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` (comments only), `openspec/changes/ledger-status-and-sources/handoff.md`

- [ ] **Step 1: Update docs** per tasks.md 5.1: ARCHITECTURE package row (seven bank tools, ledger), a `ledger/` paragraph (schema steps in `ledger_schema_steps`, owner-scoped `LedgerStore`, envelope helper, import boundary), `bank.db` tables, server start/stop order, resources table (both guides), test sections ("twelve tools", `ledger-isolation.test.ts`); README tool table, "five bank/transaction tools" (line 7), "the five transaction tools" (line 20) and the four "ten tools"; ARCHITECTURE Images line 148 and smoke line 173 ("ten tools"); ARCHITECTURE "five bank guides" (lines 70, 85); AGENTS "ten tools" → "twelve tools"; composed overview twelve-tool map; the comments `Dockerfile:6` ("ten tools, eleven resources" → twelve, thirteen), `Dockerfile:89`, `docker-compose.yml:1` and `.github/workflows/ci.yml:171`; `composition.test.ts:103` test title "(ten-tool) overview" is already done in Task 6. Touching `Dockerfile`/`docker-compose.yml` makes `verify:all` the required gate (AGENTS.md). Finish with `grep -rn "ten tools\|ten-tool\|ten tool\|ten composed\|five bank\|five transaction\|eleven\|11 guide" README.md AGENTS.md docs/ARCHITECTURE.md Dockerfile docker-compose.yml .github packages/*/docs packages/*/src tests` — Expected: no stale hit (`docs/superpowers/` is a frozen archive: never searched, never edited).
- [ ] **Step 2: Run the gate.** Run: `pnpm run verify:all` — Expected: PASS. It always rebuilds both images, so the twelve-tool Docker assertion runs against the new code (a bare `vitest run tests/docker/docker-smoke.test.ts` reuses an existing `:test` image). It fails without a Docker daemon: then run `pnpm run verify`, record that the Docker rung did not run, and say so in the PR.
- [ ] **Step 3: Record** results, change size (`git diff --stat origin/main...HEAD -- . ':!pnpm-lock.yaml' ':!openspec'`) against the task's ~850 lines / ~14 files, and remaining steps in `handoff.md`.
- [ ] **Step 4: Commit** — `docs: describe the ledger and the twelve-tool composed server`.
