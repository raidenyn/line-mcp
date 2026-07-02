# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat. Also to manage currency aliases that normalise captured currency strings (e.g. `"บาท"` → `"THB"`). Use `list_presets` / `apply_preset` to bootstrap from a built-in bank preset instead of writing patterns from scratch.

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern. If `sample_messages` returns a `preset_suggestions` field, use `apply_preset` before writing custom patterns.

**Next steps:** `get_transactions` — saved templates and aliases load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list` | `upsert_alias` | `delete_alias` | `list_aliases` | `list_presets` | `apply_preset`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones
- `alias`: the raw currency string captured by the regex (required for `upsert_alias` and `delete_alias`)
- `canonical`: the normalised currency code to map to, e.g. `"THB"` (required for `upsert_alias`)
- `preset_name`: name of a built-in preset (required for `apply_preset`); use `list_presets` first to see available names

**Preset workflow:**
1. Call `list_presets` to see available built-in bank presets.
2. Call `apply_preset` with `preset_name` and `chatMid` to copy all templates and currency aliases into the chat's template file.
3. Call `get_transactions` — templates are now loaded automatically.
4. Add or override individual templates with `upsert` if the preset doesn't cover all message formats in this chat.

**Currency aliases:** When a template captures a non-standard currency string (e.g. Thai `"บาท"` or abbreviated `"บ"`), use `upsert_alias` to map it to a standard code. Aliases are applied at parse time so `get_transactions` and `summarize_transactions` always return the canonical code. Presets include aliases — `apply_preset` loads them automatically.

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
