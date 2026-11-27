## Design Summary

Input: task [#132](https://github.com/raidenyn/line-mcp/issues/132) (expense-ledger RFC, M1 Ledger, task 2, key `expense-ledger/m1-ledger/2`).

The composed server gains two bank tools on a new per-owner ledger in
`bank/bank.db`:

- `manage_accounts` registers a LINE chat as a source, sets the owner's base
  currency once (with the first source) and the timezone, and sets or changes
  each source's `review_from`.
- `ledger_status` lists the owner's sources, or answers `setup_required`
  before the first one exists.

Both answer through one envelope helper (structured result, typed error
`{ code, message, action?, details? }`), and both write tools accept
`idempotency_key` and `expected_revision`. The ledger's tables are created by
ordered, additive schema steps in one module. A new architecture check keeps
`packages/bank-mcp/src/ledger/` free of `@raidenyn/line-client`.

The full design is in `design.md`.

Findings from the code as merged (`d6baecb`):

- Owner identity: `LinePrincipal.subject` is always the LINE account MID
  (`line-auth-provider.ts`, "a LINE principal's subject IS its MID"). The bank
  tools are generic over `Principal`, so the owner key is
  `context.principal.subject`, read per request.
- `bank/bank.db` is opened by `CategoryStore` (`active.bankDbPath`) and by the
  migration's `stageBankCategories`, which sets `PRAGMA user_version = 1`
  (`category-migration.ts`), so the ledger cannot use `user_version` for its
  own steps.
- No bank tool returns `structuredContent` today; all return text.
- Six existing tests and helpers enumerate the composed tool and resource
  surface (`composition.test.ts`, `tests/support/smoke-helpers.ts`,
  `tests/docker/docker-smoke.test.ts`, `tests/e2e.test.ts`). Adding two tools
  extends those lists; no assertion is weakened.
- The workspace moved to pnpm (#162): the task's `npx vitest` / `npm run verify`
  are `pnpm exec vitest` / `pnpm run verify` here.
- Task #131 (the LINE read) merged as #163; this task consumes nothing from it.

## Alternatives Considered

### Alternative A: One `LedgerStore` class over the ledger tables, tools call it (chosen)
- **Approach**: `packages/bank-mcp/src/ledger/` holds the schema steps, a
  `LedgerStore` (own better-sqlite3 connection to `bank/bank.db`, like
  `CategoryStore`) whose every method takes the owner, and pure validation.
  The tool files in `src/tools/` translate between MCP input, the store and the
  envelope. Idempotency and revision checks live in the store, inside one
  SQLite transaction per write.
- **Pros**: matches the existing store pattern and the server's open/close
  wiring; owner scoping is enforced in one place; the write and its
  idempotency record commit together.
- **Cons**: a second connection to `bank.db` in the process (harmless:
  better-sqlite3 is synchronous, so writes never interleave).

### Alternative B: Share `CategoryStore`'s connection
- **Approach**: open one `Database` for `bank.db` and hand it to both stores.
- **Pros**: one connection.
- **Cons**: changes `CategoryStore`'s constructor and the migration path that
  the task puts out of scope ("the five existing bank tools … stay as they
  are"); couples the legacy table's lifetime to the ledger's.
- **Why not chosen**: touches legacy code for no behavioural gain.

### Alternative C: Idempotency and revisions in the tool layer
- **Approach**: tools keep a response cache keyed by `idempotency_key` and
  compare revisions before calling plain store writes.
- **Pros**: the store stays simple.
- **Cons**: the check and the write are not atomic; every later write tool
  re-implements it; a crash between write and record re-applies the write.
- **Why not chosen**: the envelope contract is frozen and shared by every later
  write tool, so the guarantee belongs below the tools.

## Agreed Approach

Alternative A — the implementer's call: the task lists the storage mechanism,
names, revision semantics and idempotency retention as open choices left to
the implementer. On 2026-11-27 the owner directed: review the design with
Opus (medium effort) up to five times, then fast-forward to the plan. Five
independent review rounds ran; every finding was folded into `design.md`.

## Key Decisions

All are the implementer's calls under the task's "Open choices"; each is
listed in `design.md` § Calls made for the owner to check.

- Schema steps recorded in a ledger-owned table `ledger_schema_steps`, not
  `PRAGMA user_version` (the migration already sets it on `bank.db`).
- Zod input fields are `z.unknown().optional()` with the JSON type advertised
  through `.meta()`; all checks run in the handler, so every answer, even for
  a wrong type, is a structured `invalid_argument`.
- Currencies must be ISO 4217 codes known to `Intl.supportedValuesOf('currency')`;
  timezones are stored in their canonical IANA form.
- The ledger import check follows relative imports transitively and also
  catches subpath imports of `line-client`.
- Base currency and a default timezone live in a per-owner settings row
  `ledger_owners`; each source may have its own `timezone` (Appendix D);
  `NULL` means it follows the owner's, also after the owner changes it.
- `expected_revision` compares a per-row integer `revision` (settings row or
  source row), starting at 1 and incremented on each change.
- `idempotency_key` is remembered per owner and tool for 24 hours; reusing it
  with different arguments is `conflict`.
- `add_source` does not call LINE to check that the chat exists; `source_id`
  must match the chat-MID rule `TemplateStore` enforces.

## Open Questions

- Timezone placement (owner default plus an optional per-source value) —
  flagged to the owner; to be confirmed at PR review.
