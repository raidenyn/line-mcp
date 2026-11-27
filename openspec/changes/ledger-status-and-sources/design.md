## Context

Task [#132](https://github.com/raidenyn/line-mcp/issues/132) is the first bank
task of M1 in the [expense-ledger RFC](../../archived/design/expense-ledger/rfc-expense-ledger.md).
It is the thinnest path through everything M1 touches: the composed server, a
new tool, the first `ledger_` tables in `bank/bank.db`, and the tool envelope.
Every later bank task builds on what it produces:

- **Envelope helper** — one module that builds every structured result and
  typed error of a bank tool (contract Tool envelope, frozen).
- **Ledger schema steps** — the ordered, additive steps that create and extend
  the `ledger_` tables, in one place; each later task appends one.
- The first tables of the Ledger data model (frozen once M1 ships).

Current state (`d6baecb`):

- `@raidenyn/bank-mcp` registers five text-only tools through
  `registerBankTools(server, context, deps)`; `BankToolDeps` carries the
  shared stores. `CategoryStore` opens `bank/bank.db` itself and is closed by
  `createServer().stop()`.
- The owner is the LINE account: `LinePrincipal.subject === mid` is enforced
  by `LineAuthProvider`. Bank tools are generic over `Principal`, so they use
  `context.principal.subject`, read inside each handler.
- `tests/architecture/import-boundaries.test.ts` checks imports per package
  only.
- No dependency is added.

## Goals / Non-Goals

**Goals:**

- `manage_accounts` adds, reads, lists and updates sources, and reads and
  updates the owner's settings (base currency, timezone).
- `ledger_status` lists the owner's sources or answers `setup_required`.
- Every answer of the two tools goes through the envelope helper.
- Writes honour `idempotency_key` and `expected_revision`.
- Every ledger row and lookup is owner-scoped; another owner's source is
  `not_found`.
- Architecture check: nothing under `packages/bank-mcp/src/ledger/` imports
  `@raidenyn/line-client`, proved by a test case that feeds the checker a
  violating file.
- Guides for both tools; composed overview, README and `docs/ARCHITECTURE.md`
  updated.

**Non-Goals:**

- Accounts and cards, message fetch and ingest, re-request of a time range
  (later M1 tasks add them as further `manage_accounts` actions and tables).
- Any change to the five existing bank tools, the legacy `categories` table or
  the LINE cache schema.
- The list cursor (comes with "List transactions by filter").
- Counts of transactions that need review in `ledger_status` (no transactions
  exist yet; the field is added with them — additive).
- Checking with LINE that a chat MID exists.

## Decisions

### Module layout

```
packages/bank-mcp/src/
  tools/envelope.ts          envelope helper (results, typed errors, LedgerError → error)
  tools/ledger-status.ts     tool registration
  tools/manage-accounts.ts   tool registration
  ledger/schema.ts           ordered schema steps + runner
  ledger/ledger-store.ts     LedgerStore: owner-scoped reads/writes, idempotency, revisions
  ledger/validation.ts       currency, IANA timezone, date, default review_from
  ledger/errors.ts           LedgerError { code, message, action?, details? }
  ledger/request-hash.ts     requestHash(args): SHA-256 of canonical JSON without idempotency_key
docs/guide/tools/ledger_status.md, manage_accounts.md
```

`ledger/` imports only `better-sqlite3`, Node built-ins and its own files. The
envelope helper sits in `tools/` because it is MCP-facing; `ledger/` throws
`LedgerError` with a code from the contract, and the helper maps it. The
error-code union is defined in `ledger/errors.ts` (so `ledger/` never imports
from `tools/`) and re-exported by the envelope helper. Any other
exception becomes `internal_error` with a fixed message (no stack or SQL in the
answer).

Alternatives (see `brainstorm.md`): sharing `CategoryStore`'s connection
(touches legacy code), idempotency in the tool layer (not atomic).

### Envelope

- Success: `{ content: [{ type: 'text', text: JSON }], structuredContent: result }`.
  The text is the same JSON, so clients that ignore `structuredContent` still
  read it.
- Error: `isError: true`, `structuredContent: { error: { code, message, action?, details? } }`,
  text the same JSON.
- Codes: the six of the contract, as a TypeScript union exported from the
  helper. This task produces `setup_required`, `invalid_argument`,
  `not_found`, `conflict`, `internal_error`; `line_session_expired` is
  defined but unused until ingest.
- No `outputSchema` is declared in this task: one schema would have to cover
  success and error, and adding it later is additive. With no `outputSchema`
  the SDK passes `structuredContent` and `isError` through unchanged.
- Write inputs: `idempotency_key?: string` (1–200 chars) and
  `expected_revision?: integer ≥ 1`. Both optional; when absent, no check.
- **Input validation stays inside the envelope.** The SDK checks arguments
  against the tool's zod `inputSchema` before the handler runs and answers a
  failure as plain text without `structuredContent`. So **every field is
  `z.unknown().optional()`**, with its JSON type and allowed values advertised
  through zod 4 `.meta({ type, description })` (checked against SDK 1.32.2:
  `tools/list` shows `{"type":"string","description":…}`, and `{ provider: 5 }`
  or `label: null` reach the handler unchanged). Every rule — JSON types,
  the `action` and `provider` enums, lengths, ranges, formats, required fields
  per action — is checked in `ledger/validation.ts` and answered with
  `invalid_argument`, so no answer of the two tools leaves the envelope.
  A test asserts that `tools/list` still shows the declared types.
- Because no field is marked required in `tools/list`, the tool description
  and the guide state that `action` is required and list each action's
  required fields; a `tools/list` assertion checks that the description says
  so.
- **Fields an action does not use are `invalid_argument`**: write keys on a
  read action (`get_source`, `list_sources`, `get_settings`), or
  `base_currency` on `update_source`. Argument checks run before state checks,
  so a bad argument is `invalid_argument` even before setup. `ledger_status`
  declares no input fields: it is a read tool and its `tools/list` schema must
  not advertise write keys. Keys no schema declares are stripped by the SDK
  and ignored.

### Data model (schema step 1)

All in `bank/bank.db`, every row keyed by `owner` (= principal subject).

| Table | Columns |
|---|---|
| `ledger_schema_steps` | `step INTEGER PRIMARY KEY`, `applied_at INTEGER` — owned by the step runner, created if absent before any step; step 1 creates the three tables below |
| `ledger_owners` | `owner TEXT PRIMARY KEY`, `base_currency TEXT NOT NULL`, `timezone TEXT NOT NULL`, `revision INTEGER NOT NULL`, `created_at`, `updated_at` |
| `ledger_sources` | `id INTEGER PRIMARY KEY`, `owner`, `provider`, `native_id`, `source_id`, `label TEXT NULL`, `timezone TEXT NULL` (`NULL` = the owner's), `review_from TEXT` (`YYYY-MM-DD`), `last_caught_up_at INTEGER NULL`, `last_error TEXT NULL` (JSON `{ code, message, at }`, the shape #135 needs), `revision`, `created_at`, `updated_at`; `UNIQUE(owner, provider, source_id)` |
| `ledger_idempotency` | `owner`, `tool`, `key`, `request_hash`, `response TEXT`, `created_at`; `PRIMARY KEY(owner, tool, key)` |

Times are epoch milliseconds. `provider`, `native_id` and `source_id` are
immutable; for LINE both ids are the chat MID (Source port). Two owners may
register the same chat: the unique key includes the owner.

**Schema steps.** `ledger/schema.ts` exports an ordered array of
`{ step, sql, run? }` — SQL, plus an optional `run(db)` for a later step that
needs a computed backfill; both run inside the same transaction. On open, the store runs in one transaction every step greater
than the highest recorded one, then records it. Steps are never edited after
merge; each later task appends one. A ledger-owned table is used instead of
`PRAGMA user_version` because the migration's `stageBankCategories` already
sets `user_version = 1` on `bank.db` (`category-migration.ts`); the ledger's
version stays independent of it. If opening or a step fails, the
`LedgerStore` constructor closes its own connection before rethrowing.
`close()` is safe to call twice (the existing double-`stop()` test calls it
twice).

### `manage_accounts`

`action` is one of:

| Action | Input | Result |
|---|---|---|
| `add_source` | `provider: 'line'`, `source_id`, `label?`, `timezone?` (the source's own), `review_from?`, `base_currency` and `owner_timezone` (both required for the first source, optional after), plus write keys | `{ settings, source }` |
| `get_source` | `provider`, `source_id` | `{ source }` |
| `list_sources` | — | `{ settings, sources }` |
| `update_source` | `provider`, `source_id`, `label?` (`null` clears it), `timezone?` (`null` returns to the owner's), `review_from?`, write keys | `{ source }` |
| `get_settings` | — | `{ settings }` |
| `update_settings` | `timezone?`, `base_currency?`, write keys | `{ settings }` |

Rules:

- The first `add_source` creates the settings row from `base_currency` and
  `owner_timezone` (both required then). `timezone` on `add_source` is always
  the source's own value, never the owner's; without it the source has
  `own_timezone: null`, also on the first source. On a later `add_source`,
  `base_currency` and `owner_timezone` may be repeated with the current value;
  another value is `conflict` (for `owner_timezone`, with an `action` naming
  `update_settings`, the one way to change the owner's timezone).
- Before the first source exists, every action except `add_source` answers
  `setup_required` (with the same `action` hint as `ledger_status`).
- A source's `timezone` column is `NULL` unless the owner set one for that
  source; `NULL` means "the owner's timezone", resolved on read, so a later
  `update_settings` timezone fix reaches every source that has no own value.
  A source in a result shows `timezone` (effective) and `own_timezone`
  (`null` when inherited). `update_source` with `timezone: null` returns the
  source to the owner's timezone.
- On an update, at least one field must be given. A given value equal to the
  current one is a no-op: if nothing changes, the answer is the current row
  and the `revision` stays; otherwise the `revision` rises by 1.
- `review_from` may be any real date, also in the future (the owner may want
  the list to start later).
- `base_currency` passed again with the same value is accepted; with another
  value, on `add_source` or `update_settings`, the whole write is refused with
  `conflict` (details: current value).
- `add_source` for an existing `(provider, source_id)` of this owner is
  `conflict` (details: the existing source).
- An unknown source of this owner, or any other owner's source, is
  `not_found` — the two are indistinguishable.
- `review_from` defaults to today in the source's timezone minus three calendar
  months (day clamped to the month's end). The agent passes an explicit date
  when the imported history is shorter.
- Validation (`invalid_argument`):
  - currency: uppercased, then a member of `Intl.supportedValuesOf('currency')`
    (ISO 4217, built into Node, no dependency); `thb` is stored and compared as
    `THB`. The base currency can never change and later tasks need its minor
    unit and FX rates, so `^[A-Z]{3}$` alone (which accepts `ABC`) is not
    enough;
  - timezone: an IANA name — accepted by `Intl.DateTimeFormat`, stored as its
    `resolvedOptions().timeZone` (`asia/bangkok` → `Asia/Bangkok`), and that
    canonical name must be `UTC` or in `Intl.supportedValuesOf('timeZone')`;
    fixed offsets such as `+07:00` are refused. The stored name is the
    runtime's canonical one (it may be a link name such as `Asia/Calcutta`),
    so every comparison normalises both sides first; an ICU upgrade never
    turns an equal zone into a `conflict`;
  - `review_from`: a real calendar date `YYYY-MM-DD`;
  - `source_id` for `line`: matches `^[a-zA-Z0-9_-]{1,100}$`, the same rule
    `TemplateStore` enforces on chat MIDs (`template-store.ts`, `SAFE_MID_RE`),
    written as a local constant so `ledger/` imports nothing outside itself. A
    source whose id no template can use would otherwise be stored for good,
    since identity is immutable and there is no remove action;
  - on update, at least one field given.
- `expected_revision` on `update_source` compares the source's `revision`, on
  `update_settings` and `add_source` the settings' `revision`. On an
  `add_source` before any settings exist, only an absent value passes (any
  value is `conflict`, `details.current_revision: null`). Two racing "first"
  sources are kept consistent by the in-transaction comparison of
  `base_currency` and `owner_timezone`, not by this check. A
  mismatch is `conflict` with `details.current_revision`; nothing is written.
  Adding a source does not change the settings' `revision`; the unique
  `(owner, provider, source_id)` key refuses a duplicate source.
- `provider` is an enum with the single value `line`.

### Idempotency

Inside the write's SQLite transaction: first delete this owner's records older
than 24 hours, then look up `(owner, tool, key)`, so an expired key is free
again and its new record never hits the primary key. If found
and `request_hash` matches, return the stored response without writing. If it differs,
`conflict`. Otherwise apply the write and store its response. Only successful
writes are recorded, so a refused write can be retried with the same key after
fixing the cause. `request_hash` is the SHA-256 of the canonical JSON (keys
sorted) of the arguments as the handler receives them from the SDK (zod-parsed,
unknown keys stripped), without `idempotency_key`, and before any server-side
default or normalisation is applied — so a
retry of an `add_source` without `review_from` still matches on the next
calendar day.

### `ledger_status`

No input. Result:
`{ settings: { base_currency, timezone, revision }, sources: [{ provider, source_id, native_id, label, timezone, own_timezone, review_from, last_caught_up_at, last_error, revision, created_at, updated_at }] }`;
the same source shape is used in every `manage_accounts` result,
sources ordered by `id` (insertion order). `last_caught_up_at` and `last_error` are `null`
until ingest exists. Before the first source: `setup_required` with
`action: "Call manage_accounts with action add_source, a base_currency and an owner_timezone."`

### Wiring

- `BankToolDeps` gains `ledger: LedgerStore`; `registerBankTools` registers
  the two new tools after the five existing ones.
- `LedgerStore` is exported from `packages/bank-mcp/src/index.ts`.
- `createServer().start()` opens `LedgerStore(active.bankDbPath)` right after
  `CategoryStore` and assigns it to its closure variable at once (as
  `categoryStore` is), so a later failure in `start()` still gets it closed by
  `stop()`; `stop()` closes it with the other stores, also on the
  executor-failure path (proved in `startup.test.ts` next to the existing
  `CategoryStore.prototype.close` spy; the same file asserts that the
  `LedgerStore` is constructed after `bootstrapPersistence`, next to the
  existing `CategoryStore` constructor-order check). `test-support.ts` builds it the same
  way and `cleanup()` closes it.
- `stop()` closes each store in its own `try`, so one failing close never
  leaves the others open; the first error is rethrown after all have run
  (the executor failure keeps precedence).
- `startup.test.ts`'s exact boot-order event list gains `open-ledger-store`
  right after the category store's event, so a wrong position fails.
- `registerBankResources` adds the two guides; the composed overview lists
  twelve tools.

### Architecture check

`tests/architecture/import-boundaries.test.ts` gains a ledger checker,
`ledgerBoundaryViolations(dir)`, that reads every `.ts` file under `dir` and
follows every relative import transitively (into files outside `dir` too,
resolving `.ts` and `/index.ts`), and reports each file reached that has a
module specifier `@raidenyn/line-client` or `@raidenyn/line-client/…` in any
form — `import … from`, `import type … from`, side-effect `import '…'`,
`export … from`, `require('…')` and `import('…')`; the scan matches the quoted
specifier in those import positions (`from '…'`, `import '…'`, `import('…')`, `require('…')`) —
(subpaths included; the existing package-level `IMPORT_RE` misses them), with
the import chain that reached it. This enforces exactly the agreed decision
("`ledger/` never imports `line-client`") without forbidding `ledger/` from
using legacy modules that are free of it, such as `fx-rates.ts`, which later
M1 tasks (#133, #137) may need.

Test cases:

1. `packages/bank-mcp/src/ledger/` exists, has at least one `.ts` file, and
   the checker reports nothing.
2. Cases on a temporary directory, each with one violation — a direct
   import, an `import type`, an `export … from`, a subpath import, and a
   relative import of a file (outside the checked directory) that imports
   `line-client` — each asserting the checker reports it, so the rule cannot
   pass vacuously.

### Tests (by acceptance criterion)

| Criterion | Test |
|---|---|
| `setup_required` with `action` | `packages/bank-mcp/src/tools/ledger-tools.test.ts` (in-memory store, real `McpServer` + client) |
| Source listed; base currency change refused with `conflict` | same file |
| Two owners: `not_found`, no list shows it | `packages/server/src/ledger-isolation.test.ts`, two principals over HTTP, modelled on `trusted-tenant.test.ts`. Both owners are set up, each with a different source. Bob's `list_sources` and `ledger_status` are non-empty and do not contain Alice's MID; Bob's `get_source` and `update_source` on Alice's MID are `not_found`, and Alice's revision is unchanged. A second case: both register the same MID with different labels, and each sees only their own label. One owner's `idempotency_key` reused by the other is applied as a new write |
| Idempotent replay applied once; stale `expected_revision` refused | `ledger-tools.test.ts` plus `ledger/ledger-store.test.ts`. Proved on `update_source`: the replay returns the identical stored response, the source's `revision` rose by exactly 1 and `updated_at` is unchanged; the same key with other arguments is `conflict`; an expired key (injected clock) is applied as a new write. Also on `add_source`, the usual retry after a lost answer: a replay with the same key and arguments returns the identical stored `{ settings, source }`, not the duplicate-source `conflict` (the key lookup runs before the duplicate check). Stale `expected_revision` on `update_source` and `update_settings` is `conflict` with `details.current_revision`, and nothing changed |
| Ledger import boundary | `tests/architecture/import-boundaries.test.ts` |
| Standard checks | `pnpm run verify` |

Input-validation cases in `ledger-tools.test.ts` prove the envelope holds for
bad values: `provider: 'x'`, `provider: 5`, `label: null` on `add_source`,
`expected_revision: 0`, an unknown `action`, a missing `action`, a bad
timezone, a fixed offset `+07:00`, a non-ISO currency (`ABC`), a `source_id`
with `/`, and a write key on a read action each give a structured
`invalid_argument`; `thb` is accepted as `THB`; `label: null` on
`update_source` clears the label.

Timezone cases: the first `add_source` with `owner_timezone` only gives the
source `own_timezone: null` and `timezone` equal to the owner's; a later
`update_settings` timezone change is seen by that source; a later
`add_source` with its own `timezone` keeps it; a later `add_source` with a
different `owner_timezone` is `conflict`; the default `review_from` follows
the source's effective timezone.

The composed smoke (`runComposedBankAssertions` in
`tests/support/smoke-helpers.ts`) calls `ledger_status` (expects
`setup_required`), `manage_accounts add_source`, then `ledger_status` (expects
the source), so the compiled CLI's real wiring on the generation's
`bankDbPath` is exercised.

Existing tests and docs that list the tool surface gain the two new names or
the new count; nothing is removed from them:

- `packages/bank-mcp/src/register-tools.test.ts` ("registers exactly the five
  bank tools" becomes seven; resources 6 → 8 with the overview, guide URIs
  5 → 7; its `makeDeps`
  helpers gain `ledger`).
- `packages/bank-mcp/docs/guide/overview.md` (the package's own overview).
- The `BankToolDeps` comment in `tools/deps.ts`, which says every store is
  shared across principals: `ledger` is the owner-scoped exception.
- `tests/docker/docker-smoke.test.ts` is not run by `pnpm run verify`, and run
  alone it reuses an existing `:test` image. The comments in `Dockerfile`,
  `docker-compose.yml` and `.github/workflows/ci.yml` also say "ten tools";
  updating them makes `pnpm run verify:all` (which rebuilds both images) the
  pre-PR gate.
- `packages/server/src/composition.test.ts` (twelve tools, thirteen
  resources), `tests/support/smoke-helpers.ts` (`BANK_TOOLS`),
  `tests/docker/docker-smoke.test.ts`, `tests/e2e.test.ts` (manual suite,
  resource list only).
- "ten tools" → "twelve tools" in `AGENTS.md`, `README.md` (four places, plus
  the tool table), `docs/ARCHITECTURE.md` (package table, resources table,
  Docker and test sections), `packages/server/docs/guide/overview.md`, and the
  comments in `registrations.ts`, `data-layout.ts`, `tools/index.ts`,
  `tools/deps.ts`, `resources.ts`; "five bank/transaction tools" in `README.md`
  and "five bank guides" in `docs/ARCHITECTURE.md`.

### Calls made (for the owner to check)

1. **Timezone in two places**: an owner default in `ledger_owners` (needed for
   the owner's weeks and periods later) and an optional per-source
   `timezone` (Appendix D lists it on `sources`); a source without its own
   follows the owner's, also after the owner's changes. Both can be changed.
2. `ledger_owners` is a new table not named in Appendix D; it holds the base
   currency.
3. Schema steps in `ledger_schema_steps`, not `PRAGMA user_version`.
4. Per-row integer `revision`; write keys optional; `expected_revision` on
   `add_source` compares the settings' revision.
5. Idempotency records kept 24 hours; only successful writes recorded.
6. No LINE call on `add_source`; a well-formed but mistyped MID is stored
   as given.
7. No `outputSchema` yet.
8. No needs-review counts in `ledger_status` until transactions exist.
9. The owner column holds `principal.subject` alone, not provider plus
   subject: the product rule is "data per LINE account" and the composed
   server has one auth provider. A second provider would need a step that
   widens the key.

## Risks / Trade-offs

- [Frozen data model gets a wrong column] → only columns the RFC names or this
  task needs; everything else is added by later steps.
- [Appendix D's "template revision last applied" on `sources` is not in step 1]
  → added by a later M1 step, most likely by #140 "Read messages again when a
  template changes"; named under "Effects on later tasks" in the PR report.
- [Second connection to `bank.db`] → better-sqlite3 is synchronous and the
  process is single-threaded for DB work; set `busy_timeout` anyway.
- [Mistyped chat MID registered] → visible in `ledger_status`; ingest (later
  task) will report the error on the source.
- [Tool-surface lists in tests drift] → each list is extended in this change.

## Migration Plan

New tables only, created on first open. Rolling back to the previous release
leaves the `ledger_` tables unused and untouched; the legacy tools work as
before. Single-release condition: no release is dispatched until M4 ends.

## Open Questions

- Call 1 (timezone placement) — flagged to the owner; to be confirmed at PR
  review. The other calls are left to the implementer by the task.
