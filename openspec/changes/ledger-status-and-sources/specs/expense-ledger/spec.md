## ADDED Requirements

### Requirement: Bank tool envelope
Every answer of a ledger bank tool (`ledger_status`, `manage_accounts`) SHALL be built by one envelope helper in `@raidenyn/bank-mcp`. A success SHALL carry the result as `structuredContent` and the same JSON as text. An error SHALL set `isError: true` and carry `{ error: { code, message, action?, details? } }` as `structuredContent` and text, with one of the six contract codes (`setup_required`, `invalid_argument`, `not_found`, `conflict`, `internal_error`, `line_session_expired`).

#### Scenario: Success is structured
- **WHEN** a ledger tool call succeeds
- **THEN** the answer has `structuredContent` equal to the JSON in its text content and no `isError`

#### Scenario: Error is structured
- **WHEN** a ledger tool call fails with a ledger error
- **THEN** the answer is `isError: true` and its `structuredContent.error` has a contract `code` and a `message`

### Requirement: Unexpected failures
An exception that is not a ledger error SHALL be answered as `internal_error` with a fixed message that contains no stack trace, SQL or original error text.

#### Scenario: Unexpected failure
- **WHEN** the ledger store throws an error that is not a ledger error
- **THEN** the answer is `isError: true` with `code: internal_error` and a message that does not contain the original error text

### Requirement: Validation inside the envelope
The ledger tools SHALL check every argument rule — JSON type, allowed values, formats, required fields per action, and fields an action does not use — in the handler and answer a violation with `invalid_argument`, so that no argument value produces an answer outside the envelope. The tools' input schemas SHALL still advertise each field's JSON type in `tools/list`, and the tool description SHALL state that `action` is required.

#### Scenario: Wrong type
- **WHEN** `manage_accounts` is called with `provider: 5` or `label: null` on `add_source`
- **THEN** the answer is a structured `invalid_argument`

#### Scenario: Missing or unknown action
- **WHEN** `manage_accounts` is called without `action`, or with an unknown `action`
- **THEN** the answer is a structured `invalid_argument`

#### Scenario: Field the action does not use
- **WHEN** a read action (`get_source`, `list_sources`, `get_settings`) receives `idempotency_key` or `expected_revision`, also before setup
- **THEN** the answer is a structured `invalid_argument` (argument checks run before `setup_required`)

#### Scenario: Types stay advertised
- **WHEN** a client lists tools
- **THEN** `manage_accounts`'s input schema shows `provider` with type `string` and `expected_revision` with type `integer`, and its description says `action` is required

### Requirement: Owner-scoped ledger
Every ledger row and lookup SHALL be scoped to the calling owner, identified by the principal's `subject`. Another owner's source SHALL be answered exactly like an unknown source (`not_found`) and SHALL NOT appear in any list. Two owners MAY register the same chat; each SHALL see only their own row.

#### Scenario: Another owner's source
- **WHEN** owner B, who has their own settings and a source, calls `get_source` or `update_source` for a chat only owner A registered
- **THEN** the answer is `not_found`, owner A's source is unchanged, and neither B's `list_sources` nor B's `ledger_status` contains A's chat

#### Scenario: Same chat, two owners
- **WHEN** owners A and B both register the same chat MID with different labels
- **THEN** each owner's `get_source` shows only their own label

#### Scenario: Idempotency keys are per owner
- **WHEN** owner B sends a write with the same `idempotency_key` that owner A used
- **THEN** B's write is applied as a new write

### Requirement: Setup required before the first source
Before an owner has a source, `ledger_status` and every `manage_accounts` action except `add_source` SHALL answer `setup_required` with an `action` that names `manage_accounts` `add_source`, `base_currency` and `owner_timezone`.

#### Scenario: Status before setup
- **WHEN** a signed-in owner with no source calls `ledger_status`
- **THEN** the answer is `setup_required` with a non-empty `action`

### Requirement: Sources
`manage_accounts` SHALL add, get, list and update an owner's sources. A source SHALL be identified by immutable `provider` (only `line`), `native_id` and `source_id`; for LINE both ids are the chat MID, which SHALL match `^[a-zA-Z0-9_-]{1,100}$`. Adding a source that this owner already has SHALL be refused with `conflict`.

#### Scenario: Add and list
- **WHEN** an owner adds a chat as a source with a base currency and an owner timezone, then calls `ledger_status`
- **THEN** the result lists that source with `provider: line`, `source_id` and `native_id` equal to the chat MID, `revision: 1`, and the owner's settings

#### Scenario: Duplicate source
- **WHEN** an owner adds a chat they already registered, without an idempotency key
- **THEN** the answer is `conflict` and nothing changes

### Requirement: Source attributes
A source SHALL have an optional label, an optional own IANA timezone (when absent it follows the owner's timezone, also after that changes), a `review_from` date, `last_caught_up_at` and `last_error` (`{ code, message, at }`; both `null` until ingest exists), and an integer `revision` that starts at 1 and rises by 1 on each change.

#### Scenario: Inherited timezone
- **WHEN** a source was added without its own timezone and the owner later changes their timezone with `update_settings`
- **THEN** the source's effective `timezone` is the new owner timezone and its `own_timezone` is `null`

#### Scenario: Clear label and own timezone
- **WHEN** `update_source` is called with `label: null` and `timezone: null`
- **THEN** the source has no label and follows the owner's timezone

#### Scenario: Bad source id
- **WHEN** `add_source` is called with a `source_id` containing `/`
- **THEN** the answer is `invalid_argument`

### Requirement: Review start per source
Each source SHALL have a `review_from` date that the owner can set and change. When none is given at `add_source`, it SHALL default to today in the source's effective timezone minus three calendar months, with the day clamped to the end of that month. Any real calendar date `YYYY-MM-DD` SHALL be accepted.

#### Scenario: Default review start
- **WHEN** a source is added without `review_from` on 2026-05-31 in its timezone
- **THEN** its `review_from` is `2026-02-28`

#### Scenario: Change review start
- **WHEN** `update_source` sets `review_from` to `2026-01-01`
- **THEN** the source's `review_from` is `2026-01-01` and its `revision` rose by 1

### Requirement: Base currency set once
The first `add_source` of an owner SHALL create the owner's settings from `base_currency` and `owner_timezone`, both required then. The base currency SHALL be an ISO 4217 code known to the runtime (`Intl.supportedValuesOf('currency')`), stored uppercase, and SHALL NOT change afterwards: a later `add_source` or `update_settings` with another base currency SHALL be refused with `conflict` and write nothing; the same value SHALL be accepted.

#### Scenario: Base currency set again to another value
- **WHEN** an owner whose base currency is `THB` calls `update_settings` with `base_currency: USD`
- **THEN** the answer is `conflict` and the base currency stays `THB`

#### Scenario: Same base currency
- **WHEN** an owner whose base currency is `THB` adds another source with `base_currency: thb`
- **THEN** the source is added and the base currency stays `THB`

#### Scenario: Non-ISO currency
- **WHEN** the first `add_source` passes `base_currency: ABC`
- **THEN** the answer is `invalid_argument` and no settings exist

### Requirement: Owner timezone
The owner timezone SHALL be an IANA name, stored in its canonical form; fixed offsets SHALL be refused. It SHALL be changed only through `update_settings`; a later `add_source` with another `owner_timezone` SHALL be refused with `conflict`.

#### Scenario: Fixed-offset timezone
- **WHEN** a timezone `+07:00` is passed
- **THEN** the answer is `invalid_argument`

#### Scenario: Canonical name
- **WHEN** the first `add_source` passes `owner_timezone: asia/bangkok`
- **THEN** the settings' timezone is `Asia/Bangkok`

#### Scenario: Equal zones under different names
- **WHEN** the owner timezone was stored from `Asia/Kolkata` and a later `add_source` passes `owner_timezone: Asia/Calcutta`
- **THEN** the source is added (no `conflict`)

#### Scenario: Owner timezone changed through add_source
- **WHEN** an owner with timezone `Asia/Bangkok` adds a source with `owner_timezone: Europe/Berlin`
- **THEN** the answer is `conflict` and the owner timezone stays `Asia/Bangkok`

### Requirement: Idempotent writes
A `manage_accounts` write that carries an `idempotency_key` SHALL be applied at most once per owner, tool and key within 24 hours. A repeat with the same arguments SHALL return the stored answer of the first write without writing; a repeat with other arguments SHALL be refused with `conflict`. Only successful writes SHALL be recorded. The key lookup SHALL come before the duplicate-source check, so a retried `add_source` returns its stored success.

#### Scenario: Replay applied once
- **WHEN** `update_source` is sent twice with the same `idempotency_key` and arguments
- **THEN** both answers are identical, the source's `revision` rose by exactly 1, and its `updated_at` did not change on the second call

#### Scenario: Retried add
- **WHEN** `add_source` is sent twice with the same `idempotency_key` and arguments
- **THEN** the second answer equals the first, not `conflict`

#### Scenario: Key reused with other arguments
- **WHEN** a write reuses an `idempotency_key` with different arguments
- **THEN** the answer is `conflict` and nothing changes

#### Scenario: Expired key
- **WHEN** a write reuses an `idempotency_key` more than 24 hours after it was recorded
- **THEN** it is applied as a new write

### Requirement: Optimistic revisions
A write that carries `expected_revision` SHALL be refused with `conflict` and `details.current_revision`, writing nothing, when the value differs from the current revision: the source's revision for `update_source`, the settings' revision for `update_settings` and `add_source`. On an `add_source` before any settings exist, any `expected_revision` SHALL be refused with `details.current_revision: null`. An update whose given values all equal the current ones SHALL leave the revision unchanged.

#### Scenario: Stale revision
- **WHEN** `update_source` is sent with `expected_revision: 1` after the source reached revision 2
- **THEN** the answer is `conflict` with `details.current_revision: 2` and the source is unchanged

#### Scenario: No-op update
- **WHEN** `update_source` sets a label equal to the current one
- **THEN** the answer is the current source and its revision is unchanged

### Requirement: Ledger schema steps
The `ledger_` tables in `bank/bank.db` SHALL be created and extended only by ordered, additive schema steps defined in one module of `@raidenyn/bank-mcp`. Opening the ledger SHALL apply, in one transaction, every step above the highest one recorded in `ledger_schema_steps` and record it. The steps SHALL NOT use `PRAGMA user_version` and SHALL NOT change the legacy `categories` table or the LINE cache.

#### Scenario: Fresh database
- **WHEN** the ledger is opened on a `bank.db` without ledger tables
- **THEN** step 1 creates `ledger_owners`, `ledger_sources` and `ledger_idempotency`, `ledger_schema_steps` records step 1, and `PRAGMA user_version` is unchanged

#### Scenario: Reopen
- **WHEN** the ledger is opened a second time on the same file
- **THEN** no step runs again and the stored rows are unchanged

#### Scenario: Failed step
- **WHEN** a schema step fails while the ledger opens
- **THEN** no part of that step is kept and the ledger's connection is closed

### Requirement: Ledger lifecycle in the composed server
The composed server SHALL open the ledger on the active generation's `bank/bank.db` after persistence bootstrap and close it on stop, also when the regex executor fails to close; closing SHALL be safe to repeat. The standalone messenger server SHALL NOT expose the ledger tools.

#### Scenario: Stop after executor failure
- **WHEN** `stop()` runs and the regex executor's close rejects
- **THEN** the ledger store is still closed and the executor error is rethrown

#### Scenario: Composed tool surface
- **WHEN** a client lists the composed server's tools
- **THEN** there are twelve, including `ledger_status` and `manage_accounts`

### Requirement: Ledger import boundary
No file under `packages/bank-mcp/src/ledger/`, nor any file it reaches through relative imports, SHALL import `@raidenyn/line-client` or any of its subpaths, in any import form. The architecture suite SHALL fail when this rule is broken.

#### Scenario: Direct, type-only, re-export or subpath import
- **WHEN** a checked file imports `@raidenyn/line-client` directly, with `import type`, with `export … from`, or through a subpath
- **THEN** the architecture check reports the file

#### Scenario: Indirect import
- **WHEN** a checked file imports a relative module outside the directory that imports `@raidenyn/line-client`
- **THEN** the architecture check reports the chain that reaches it

#### Scenario: Current tree
- **WHEN** the architecture suite runs on the repository
- **THEN** `packages/bank-mcp/src/ledger/` exists, contains at least one `.ts` file, and has no violation
