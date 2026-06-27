# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat.

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern.

**Next steps:** `get_transactions` — saved templates load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
