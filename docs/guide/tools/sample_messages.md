# sample_messages

**When to use:** Before writing a regex template — to inspect the raw text format of bank notification messages in a chat.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** `manage_templates` (action: upsert) to save a pattern based on what you observe.

**Key parameters:**
- `since` / `until` (ISO 8601 date strings) — critical for reaching older messages if a bank changed its format months ago. Without `since`, only the latest messages are returned.
- Results are sorted oldest-first and filtered to text-only messages.

**Avoid:** Don't skip this step before writing templates — message formats vary significantly between banks and change over time. Use `since` whenever you need to capture historical format variations.
