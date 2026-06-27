# get_messages

**When to use:** To read recent messages from a known chat — browsing conversation content, checking for images, or reviewing what was said.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** `get_image` if any message has a `previewUrl`; `sample_messages` if you need to inspect raw text for pattern-writing.

**Key parameters:**
- `count` (default 50, max 200) — for history older than 200 messages, use `sample_messages` with `since` instead.

**Avoid:** Don't use for transaction parsing — use `get_transactions` which applies saved templates automatically. Don't set `count` above 200 (validation rejects it).
