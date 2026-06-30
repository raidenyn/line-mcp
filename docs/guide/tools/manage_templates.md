# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat. Also to manage currency aliases that normalise captured currency strings (e.g. `"บาท"` → `"THB"`).

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern.

**Next steps:** `get_transactions` — saved templates and aliases load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list` | `upsert_alias` | `delete_alias` | `list_aliases`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones
- `alias`: the raw currency string captured by the regex (required for `upsert_alias` and `delete_alias`)
- `canonical`: the normalised currency code to map to, e.g. `"THB"` (required for `upsert_alias`)

**Currency aliases:** When a template captures a non-standard currency string (e.g. Thai `"บาท"` or abbreviated `"บ"`), use `upsert_alias` to map it to a standard code. Aliases are applied at parse time so `get_transactions` and `summarize_transactions` always return the canonical code.

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
