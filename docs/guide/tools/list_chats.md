# list_chats

**When to use:** At the start of any session to discover available chats and retrieve their MIDs.

**Prerequisites:** None.

**Next steps:** Pass a MID to `get_messages` to read that chat's messages, or to `sample_messages` / `get_transactions` for transaction parsing.

**Avoid:** Don't hardcode MIDs across sessions — chat MIDs are stable but calling `list_chats` first is cheap and confirms the chat still exists.
