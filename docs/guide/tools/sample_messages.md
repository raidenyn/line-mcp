# sample_messages

**When to use:** Before writing a regex template — to inspect the raw text format of bank notification messages in a chat.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** If the response includes a `preset_suggestions` field with entries, call `manage_templates` with `action: apply_preset, preset_name: <name>` to bootstrap from a built-in preset. Otherwise, write patterns manually with `manage_templates` (action: upsert).

**Key parameters:**
- `since` / `until` (ISO 8601 date strings) — critical for reaching older messages if a bank changed its format months ago. Without `since`, only the latest messages are returned.
- Results are sorted oldest-first and filtered to text-only messages.

**Response format:**
- `content[0].text`: human-readable list of messages, with an appended note when preset suggestions exist.
- `content[1].text`: JSON object `{ "preset_suggestions": [...] }` — always present. Each entry is `{ preset_name, matched_count, description }`. Empty array means no gaps were detected.

**Preset suggestion logic:** A preset is suggested when at least one returned message matches a preset pattern but is not matched by any existing saved template for this chat. This detects coverage gaps — messages that look like bank notifications but have no template yet.

**Avoid:** Don't skip this step before writing templates — message formats vary significantly between banks and change over time. Use `since` whenever you need to capture historical format variations.
