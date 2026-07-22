# Export Import Message Reconciliation Design

**Issue:** [#53](https://github.com/raidenyn/line-mcp/issues/53)

## Problem

LINE chat exports provide minute-level timestamps, sender names, and text, but
no message IDs. The export parser currently hashes those fields without
framing or an occurrence index. Two identical lines in the same minute receive
the same synthetic ID, and ambiguous field boundaries can also produce the
same hash input. SQLite then replaces one row with the other while
`complete_import` reports every parsed row as imported.

The cache also deduplicates all same-text, same-minute messages when reading.
That hides legitimate duplicate API messages and duplicate export messages.
LINE API messages already have unique IDs; content-based deduplication belongs
at the import/API reconciliation boundary, not on reads.

## Goals

- Give every occurrence in an export a deterministic, unambiguous synthetic
  ID.
- Preserve multiple export messages with identical text and timestamps.
- Keep reimporting the same or overlapping export idempotent.
- Match exports to existing API messages using exact text and UTC minute.
- Replace a synthetic row with the corresponding real API row when LINE later
  returns that message.
- Preserve message multiplicity through one-for-one reconciliation.
- Report parsed rows separately from newly stored imported rows.
- Continue recognizing synthetic rows created by older releases.

## Non-Goals

- Matching by sender identity. Export and API sender metadata may differ or be
  absent.
- Deduplicating two messages that both have real LINE IDs.
- Recovering a real LINE ID without receiving the message from LINE.
- Changing the SQLite schema or rewriting existing synthetic IDs eagerly.

## Architecture

Reconciliation is a transactional responsibility of the message cache. The
`MessageCache` port in `@raidenyn/line-client` gains an explicit import method:

```ts
interface ImportMessagesResult {
  imported: number;
}

interface MessageCache {
  upsertMessages(ownerMid: string, chatMid: string, messages: Message[]): void;
  importMessages(
    ownerMid: string,
    chatMid: string,
    messages: Message[],
  ): ImportMessagesResult;
  // Existing read methods remain unchanged.
}
```

The two write paths have distinct semantics:

- `importMessages` compares synthetic messages with all existing messages and
  inserts only unmatched occurrences.
- `upsertMessages` stores messages fetched from LINE. Each newly observed real
  ID replaces at most one matching synthetic row before insertion.

`SqliteMessageCache.getMessages` becomes a plain ordered read. It does not
deduplicate by message content.

No schema migration is required. Reconciliation derives text from `raw_json`,
uses the existing `created_time` column, and recognizes synthetic rows by the
existing `export-` ID prefix.

## Synthetic IDs

The parser maintains a zero-based occurrence counter for each distinct tuple
of:

```ts
[chatMid, dateStr, timeStr, senderName, text]
```

When a message is flushed, its ID input is:

```ts
JSON.stringify([
  chatMid,
  dateStr,
  timeStr,
  senderName,
  text,
  occurrence,
])
```

The parser hashes this framed string with SHA-256 and retains the current
external format:

```text
export-<first 24 lowercase hexadecimal characters>
```

JSON array framing prevents sender/text and other field-boundary ambiguity.
Scoping the occurrence counter to the preceding fields means unrelated lines
do not shift IDs. Parsing the same file again therefore produces the same IDs,
while repeated identical lines produce distinct IDs.

## Reconciliation Key

Export/API equivalence uses:

```ts
`${Math.floor(createdTimeMs / 60_000)}:${text}`
```

The conceptual key is the pair `(UTC minute, exact text)`; implementations
must frame the values rather than rely on ambiguous string concatenation.
Matching is owner- and chat-scoped. Sender identity is deliberately ignored.

Only messages with an `export-` ID are synthetic. Every other ID is treated as
a real LINE ID. Real messages are never content-deduplicated against other real
messages.

## Import Reconciliation

`importMessages` runs one SQLite transaction for the complete batch:

1. Group parsed messages by reconciliation key while preserving parser order
   within each group.
2. Load existing rows for the same owner and chat that can match the imported
   minute range, parse their `raw_json`, and count them by reconciliation key.
3. For each group, consume existing rows one-for-one from the start of the
   parsed group.
4. Insert the remaining parsed occurrences using their deterministic IDs.
5. Return the number of newly inserted rows after the transaction commits.

Both existing real rows and existing synthetic rows consume occurrences. This
provides these multiplicity rules:

| Existing matching rows | Parsed matching rows | Newly inserted |
|---:|---:|---:|
| 0 | 2 | 2 |
| 1 | 2 | 1 |
| 2 | 2 | 0 |
| 3 | 2 | 0 |

Because separate exports contain no identity capable of distinguishing two
otherwise identical occurrences, repeated and overlapping imports retain the
maximum observed multiplicity for a reconciliation key rather than summing
the multiplicity of every uploaded file.

Rows created by the legacy ID algorithm participate in the existing-row
count. Reimporting historical files after upgrading therefore does not add a
second set merely because the new parser generates different IDs.

If a deterministic ID already exists but its stored payload differs, the
operation may refresh that row without counting it as newly imported. This
retains normal upsert behavior without overstating storage growth.

## API Reconciliation

`upsertMessages` also runs one SQLite transaction. For each incoming API
message:

1. Check whether its real message ID already exists for the owner and chat.
2. If the real ID is new, find at most one synthetic row with the same
   reconciliation key and delete it.
3. Insert or update the real message row with its API metadata and real ID.

An already-known real ID does not remove another synthetic row. This matters
when two identical export occurrences exist but LINE has so far returned only
one of their real IDs. Re-fetching that one API message must not consume the
remaining synthetic occurrence.

Within one batch, each new real ID and each synthetic row can participate in
at most one replacement. Two new real IDs sharing a key can replace two
synthetic rows. A real message never replaces another real message based on
content.

## Import Service Response

After parsing, `ImportService.complete` calls `cache.importMessages`. A success
response contains both counts:

```json
{
  "kind": "success",
  "parsed": 312,
  "imported": 47,
  "chat_mid": "u123abc",
  "chat_name": "SCB Connect",
  "date_range": {
    "from": "2025-06-12T04:24:00.000Z",
    "to": "2026-06-21T10:11:00.000Z"
  }
}
```

- `parsed` is the number of valid messages produced by the parser.
- `imported` is the number of newly stored synthetic rows.
- `date_range` continues to describe all parsed messages, including matches.

The MCP tool's human-readable success content must explain both counts rather
than describing `parsed` as newly imported.

## Errors And Atomicity

Existing upload, timezone, chat-resolution, and parser error behavior remains
unchanged. A cache failure produces the existing `import_failed` outcome.

Import and API reconciliation transactions are atomic. Any query, JSON parse,
delete, or insert failure rolls back the entire batch. `imported` is returned
only after commit, so the response cannot claim rows from a partial write.

## Components Changed

- `packages/line-client/src/export-parser.ts`: framed occurrence-aware IDs.
- `packages/line-client/src/export-parser.test.ts`: identity regressions.
- `packages/line-client/src/cached-message-reader.ts`: expanded cache port.
- `packages/line-client/src/cached-message-reader.test.ts`: test cache support
  for the expanded port.
- `packages/line-client-sqlite/src/sqlite-message-cache.ts`: transactional
  import and API reconciliation; remove read-time deduplication.
- `packages/line-client-sqlite/src/sqlite-message-cache.test.ts`: persistence
  and multiplicity regressions.
- `packages/line-mcp/src/import-service.ts`: explicit import operation and
  parsed/imported counts.
- `packages/line-mcp/src/import-service.test.ts`: response contract tests.
- `packages/line-mcp/src/tools/import-tools.ts`: success output for both counts.
- `docs/ARCHITECTURE.md`: document the cache's reconciliation behavior.

## Testing

Parser tests verify:

- identical same-minute lines have distinct synthetic IDs;
- IDs remain deterministic across repeated parses;
- sender/text boundary-collision inputs have distinct IDs;
- inserting unrelated messages does not change occurrence IDs for another
  identity tuple.

SQLite cache tests verify:

- importing two identical rows stores and returns both;
- reimporting the same batch stores no additional rows;
- an existing real row consumes one imported occurrence;
- an existing legacy synthetic row consumes one imported occurrence;
- a partial-overlap import adds only the excess multiplicity;
- a new real ID replaces one matching synthetic row;
- refetching an existing real ID does not remove another synthetic row;
- two new real IDs replace two matching synthetic rows;
- real messages with distinct IDs are both retained even when their keys
  match;
- same-text messages in different minutes do not reconcile;
- read methods preserve identical rows rather than deduplicating them;
- a failed batch rolls back all reconciliation changes.

Import-service and tool tests verify:

- `parsed` reflects parser output length;
- `imported` reflects the cache's committed result;
- success text distinguishes parsed and newly stored rows;
- existing failure outcomes remain unchanged.

The implementation must pass the repository's standard lint, build, unit, and
smoke gates.
