# complete_import

**When to use:** To finalize a chat history import after uploading the export file via `initiate_import`.

**Prerequisites:** `initiate_import` must have run and the export file must have been uploaded to the returned `upload_url`.

**Next steps:** Imported messages are now in the cache. Call `sample_messages` or `get_transactions` — they will include the imported history.

**Key parameters:**
- `file_ref_id`: from the curl response after uploading the export file
- `timezone`: IANA timezone name (e.g. `"Asia/Bangkok"`). **Always ask the user explicitly** — LINE exports use local time with no timezone marker, so an incorrect timezone shifts all timestamps.
- `chat_mid`: optional; used to override auto-detection when the tool returns candidate MIDs

**Avoid:** Don't guess the timezone — ask the user explicitly before calling. If `complete_import` returns `status: "needs_info"`, read its `message` field and ask the user for the missing information before retrying.
