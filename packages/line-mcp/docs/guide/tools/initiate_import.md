# initiate_import

**When to use:** To import a LINE chat export file (.txt) to backfill historical messages beyond LINE's ~2-week API window.

**Prerequisites:** The user must have exported a chat from the LINE mobile app (Chat menu → Export chat history).

**Next steps:** After receiving the `upload_url`, upload the `.txt` file:
```
curl -X POST --data-binary @/path/to/file.txt -H "Content-Type: text/plain" "<upload_url>"
```
The curl response contains a `file_ref_id`. Pass that to `complete_import`.

**Key parameters:** None — the tool generates a one-time upload URL valid for 15 minutes.

**Avoid:** Don't use for recent messages — the message cache handles incremental fetches automatically. If the upload URL expires, call `initiate_import` again to get a new one.
