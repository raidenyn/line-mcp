# ledger_status

**When to use:** As the first call of a ledger session, to learn whether the expense ledger is set up and which sources (chats) it covers. It reports the owner settings and every source with its label, effective timezone, review start and revision.

**Prerequisites:** None. Before setup it answers `setup_required`, which is the signal to call `manage_accounts` with `action: "add_source"`.

**Next steps:** `manage_accounts` (`add_source` or `update_source`) to add a chat or change a source; later ledger tasks use the listed sources.

**Arguments:** None. This is a read tool; its schema advertises no write keys.

**Result:**

```json
{
  "settings": { "base_currency": "THB", "timezone": "Asia/Bangkok", "revision": 1 },
  "sources": [
    {
      "provider": "line",
      "source_id": "C0123456789abcdef",
      "native_id": "C0123456789abcdef",
      "label": "Card",
      "timezone": "Asia/Bangkok",
      "own_timezone": null,
      "review_from": "2026-02-28",
      "last_caught_up_at": null,
      "last_error": null,
      "revision": 1,
      "created_at": 1770000000000,
      "updated_at": 1770000000000
    }
  ]
}
```

- `timezone` is the effective zone; `own_timezone` is `null` when the source follows the owner timezone.
- `last_caught_up_at` and `last_error` are `null` until ingestion exists.
- Sources are ordered by insertion.

**Before setup:** the answer is `isError` with `structuredContent.error = { code: "setup_required", message, action }`. The `action` names `manage_accounts`, `add_source`, `base_currency` and `owner_timezone`. Do not guess a base currency: it can never be changed afterwards.

**Errors:** `setup_required` before the first source, `internal_error` for an unexpected failure. The answer is always structured, with the same JSON in the text content.
