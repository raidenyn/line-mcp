# CRLF Export Import Design

**Issue:** [#59](https://github.com/raidenyn/line-mcp/issues/59)

## Goal

Import LINE chat exports consistently regardless of whether they use LF, CRLF,
or legacy CR line endings, and prevent an accepted non-empty export from being
silently consumed when parsing produces no messages.

## Current Failure

`parseExportHeader` and `parseExportFile` split input on LF without removing
carriage returns. For CRLF input, the header and day lines retain a trailing
CR, so their anchored regular expressions do not match. Depending on the call
path, the upload is either rejected as an invalid export or parsing returns an
empty message array. `ImportService.complete` currently treats that empty array
as a successful import and deletes the pending file.

## Design

### Input Normalization

Add one module-private preprocessing function in `export-parser.ts`. It removes
an optional leading UTF-8 BOM and canonicalizes CRLF and lone CR line endings to
LF. Both `parseExportHeader` and `parseExportFile` preprocess their input before
splitting it into lines.

The parser's public API and remaining behavior stay unchanged. In particular,
continuation lines are joined with LF, and equivalent files with different line
endings produce identical `Message[]` values and deterministic synthetic IDs.

### Empty-Parse Protection

After `ImportService.complete` calls `parseExportFile`, it checks the message
array before calling `cache.importMessages`. When the array is empty, completion
returns the existing `import_failed` outcome with the explicit diagnostic:

```text
No messages were found in the LINE chat export.
```

The service does not call the cache or delete the pending file in this case.
The caller can retry completion with corrected inputs while the existing file
reference remains valid. No new outcome type or tool response contract is
introduced.

## Data Flow

1. The upload route decodes the raw body as UTF-8.
2. `parseExportHeader` normalizes the text and validates the first line.
3. `complete_import` resolves the target chat and timezone as it does today.
4. `parseExportFile` normalizes the stored text and produces messages.
5. An empty result returns `import_failed` without writing or consuming the
   pending file.
6. A non-empty result is imported, summarized, and consumes the pending file as
   it does today.

## Error Handling

- CRLF and lone-CR inputs are accepted when their normalized content is valid.
- Invalid LINE export headers retain the existing error response.
- A zero-message parse is an explicit import failure, not a successful
  zero-count import.
- Parser exceptions and cache failures continue to use `import_failed` and
  retain the pending file.

## Testing

Parser tests will verify that LF, CRLF, and lone-CR forms produce the same chat
header and complete message arrays, including synthetic IDs. A multiline case
will confirm that normalized message text uses LF.

Import-service tests will inject a parser that returns an empty array and verify
that completion returns `import_failed`, does not call `cache.importMessages`,
and leaves the same file reference available for a subsequent retry. Existing
parser and import-service tests must continue to pass.

## Scope

This change does not alter package boundaries, public parser signatures, MCP
tool schemas, persistence formats, or import success responses. It requires no
architecture documentation update.
