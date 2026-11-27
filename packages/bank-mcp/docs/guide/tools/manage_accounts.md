# manage_accounts

**When to use:** To set up the expense ledger for the signed-in LINE account and to manage its sources (chats). A source is a chat whose bank messages will feed the ledger. The first call registers the base currency and the owner timezone; later calls add more chats or change a source's label, own timezone and review start. Also use it to read or change the owner settings.

Every answer is structured: a success carries the result as `structuredContent` (also as text JSON); a failure is `isError` with `structuredContent.error = { code, message, action?, details? }`.

**Prerequisites:** None for `add_source`; sign in through the same LINE account that owns the chats.

**Next steps:** `ledger_status` to confirm the setup and list the sources.

## Actions

`action` is **required**. The tool schema cannot mark it required (validation runs inside the tool so every wrong value still gets a structured error), so always send it.

| Action | Required fields | Optional fields | Result |
|---|---|---|---|
| `add_source` | `provider: "line"`, `source_id`; on the first source also `base_currency` and `owner_timezone` | `label`, `timezone`, `review_from`, `idempotency_key`, `expected_revision` | `{ settings, source }` |
| `get_source` | `provider`, `source_id` | — | `{ source }` |
| `list_sources` | — | — | `{ settings, sources }` |
| `update_source` | `provider`, `source_id`, and at least one of `label`, `timezone`, `review_from` | `idempotency_key`, `expected_revision` | `{ source }` |
| `get_settings` | — | — | `{ settings }` |
| `update_settings` | at least one of `timezone`, `base_currency` | `idempotency_key`, `expected_revision` | `{ settings }` |

Read actions (`get_source`, `list_sources`, `get_settings`) refuse `idempotency_key` and `expected_revision`. `update_source` refuses `base_currency`.

## Setup flow

1. Call `add_source` with `provider: "line"`, `source_id` (the chat MID), `base_currency` (an ISO 4217 code such as `THB`) and `owner_timezone` (an IANA name such as `Asia/Bangkok`). This creates the owner settings and the first source together.
2. Call `ledger_status` to confirm. Before the first source it answers `setup_required` with an `action`.

**The base currency is set once.** A later `add_source` or `update_settings` with another value is refused with `conflict`; repeating the same value is accepted. Changing it would silently rewrite the meaning of every stored amount.

**The owner timezone changes only through `update_settings`.** A later `add_source` that passes a different `owner_timezone` is refused with `conflict` and an `action` naming `update_settings`.

## Sources

`source_id` is the LINE chat MID, matching `^[a-zA-Z0-9_-]{1,100}$`. It is immutable, like `provider`; the `native_id` is the same value. Adding the same `(provider, source_id)` twice is `conflict`. Two LINE accounts on one server may register the same chat, and each sees only their own row.

Optional `label` is free text up to 200 characters. On `update_source`, `label: null` clears it.

**Timezone inheritance.** A source may have its own `timezone`; without one it follows the owner timezone, including later `update_settings` changes. Results show `timezone` (effective) and `own_timezone` (`null` when inherited). On `update_source`, `timezone: null` returns the source to the owner timezone, and passing the owner's own zone pins the source to it (it stops following changes).

**Review start.** `review_from` is the first date the ledger reviews, written `YYYY-MM-DD`; it can be set and changed. Without a value it defaults to today in the source's effective timezone minus three calendar months, with the day clamped to the month's end (31 May → 28 or 29 February). When an imported history is shorter, pass an explicit date.

**Freshness fields.** `last_caught_up_at` and `last_error` are always `null` for now; later ingestion fills them.

## Write keys

- `idempotency_key` (1–200 characters) makes a write safe to retry. A repeat with the same arguments within 24 hours returns the stored answer without writing again; the same key with other arguments is `conflict`. Keys are per account, so two owners may use the same key. Only successful writes are remembered, so a refused write can be retried with the same key after fixing the cause.
- `expected_revision` refuses the write with `conflict` and `details.current_revision` when it does not match the current row revision: the source's revision for `update_source`, the settings' revision for `update_settings` and `add_source`. Before any settings exist, any `expected_revision` is refused with `current_revision: null`.
- An update whose values all equal the stored ones is a no-op: the revision does not rise.

## Errors

| Code | Typical cause |
|---|---|
| `setup_required` | Any action except `add_source` before the first source exists. The `action` field says how to set up. |
| `invalid_argument` | A wrong JSON type, a missing or unknown `action`, a bad currency (`ABC`), a fixed-offset timezone (`+07:00`), a malformed `YYYY-MM-DD`, a `source_id` containing `/`, an unknown field for the action, or a refused write key on a read action. `details.field` names the argument. |
| `not_found` | The source does not exist for this account (another account's source looks identical). |
| `conflict` | A duplicate source, a base-currency change, an `owner_timezone` change through `add_source`, a stale `expected_revision`, or an idempotency key reused with other arguments. |
| `internal_error` | An unexpected failure; the message is fixed and carries no internals. |
| `line_session_expired` | Reserved for message ingestion; never returned by this tool today. |

JSON types are checked inside the tool, not by the transport: sending `provider: 5` or `label: null` on `add_source` returns `invalid_argument`, not a transport-level failure.
