# Template Store Atomic Writes - Design Spec

**Date:** 2026-07-21
**Issue:** [#64](https://github.com/raidenyn/line-mcp/issues/64)
**Goal:** Prevent malformed, unreadable, or partially written template stores from being mistaken for empty stores or overwritten by later mutations.

## Problem

`loadTemplates` currently catches every read, parse, migration, and migration-write error and returns an empty store with a warning. Mutation functions discard that warning and write the resulting snapshot directly to the destination. A mutation after a malformed or unreadable file therefore replaces all existing templates and currency aliases.

Both normal mutations and the legacy named-group migration also use `writeFileSync` on the destination. A failed or interrupted write can leave a truncated store, and the next mutation can turn that recoverable failure into permanent configuration loss.

## Scope

This change covers the JSON template and currency-alias files owned by `TemplateStore`. Category data is SQLite-backed and is not affected. The design does not add backups, automatic repair, retained generations, schema changes, or cross-process locking. The existing one-process-per-data-root rule remains in force.

## Architecture

The implementation remains centered in `packages/bank-mcp/src/template-store.ts`. A single private atomic-write function will persist the complete `{ templates, currency_aliases }` snapshot for both ordinary mutations and legacy pattern migration.

The public `TemplateStore` methods and exported helper functions retain their existing signatures except that the optional `warning` property is removed from the `loadTemplates` result. Existing-file failures now throw, so a warning-bearing success result would be misleading.

`packages/bank-mcp/src/tools/fetch-transactions.ts` will stop collecting the removed template-load warning. Existing tool-level error handling remains responsible for converting thrown store errors into MCP error responses where it already does so.

## Load Semantics

`loadTemplates` distinguishes absence from failure:

- If reading the guarded chat path fails with `ENOENT`, return `{ templates: [], currency_aliases: {} }`.
- If reading fails for any other reason, propagate the error.
- If JSON parsing fails, propagate the error.
- If the decoded structure cannot be consumed by the existing template migration logic, propagate the error.

Non-mutating reads are intentionally fail-fast. Listing templates or aliases, fetching transactions from saved templates, and sampling against saved templates must not report an existing bad store as empty.

This design does not expand structural validation beyond what the store currently consumes. Adding a versioned file schema or rejecting additional legacy shapes is separate work.

## Atomic Persistence

The private writer will:

1. Resolve the guarded destination path and ensure its parent store directory exists.
2. Serialize the complete template and alias snapshot before touching the filesystem.
3. Create a unique temporary file in the destination directory with exclusive creation.
4. Write the complete serialized snapshot to that temporary file.
5. Rename the temporary file over the destination.
6. If writing or renaming fails, attempt to remove the temporary file and rethrow the original error.

The temporary file must be in the destination directory so the rename stays on one filesystem and provides atomic replacement semantics. A unique name containing process-specific and random material avoids colliding with stale or concurrent temporary files. No destination truncation occurs before the rename.

The repository's one-process-per-data-root rule means this change does not introduce file locking or compare-and-swap behavior.

## Data Flows

### Mutation

1. Load the existing complete snapshot.
2. If the file is missing, begin with an empty snapshot.
3. If the existing file cannot be loaded, throw before changing or writing anything.
4. Apply the requested template or alias change in memory.
5. Atomically replace the destination with the complete updated snapshot.

All template and alias upsert/delete operations use this flow. Delete operations may still return `false` when a successfully loaded store does not contain the requested key.

### Legacy Pattern Migration

1. Read and parse the existing snapshot.
2. Migrate legacy `(?<amount>)` and `(?<currency>)` names in memory.
3. If nothing changed, return the loaded snapshot without writing.
4. If patterns changed, atomically persist the complete migrated snapshot before returning it.
5. If persistence fails, throw and leave the original valid legacy file unchanged.

A later load can retry a failed migration. The loader must not return migrated in-memory data when its required rewrite failed.

## Error Handling

- Missing file: normal empty-store result.
- Malformed JSON: throw; preserve the file.
- Unreadable existing file: throw; preserve the file.
- Unsupported structure encountered by current migration logic: throw; preserve the file.
- Temporary-file write failure: clean up the temporary file if present, preserve the destination, and rethrow.
- Rename failure: clean up the temporary file, preserve the destination, and rethrow.
- Migration persistence failure: throw and preserve the original legacy snapshot.

Cleanup failure must not replace or mask the original write or rename error.

## Testing

Tests remain colocated in `packages/bank-mcp/src/template-store.test.ts` and use injected filesystem failures where required. Coverage will verify:

- A missing file still returns an empty store.
- Malformed existing JSON throws on non-mutating reads.
- Template and alias mutations against malformed JSON throw and leave the original bytes unchanged.
- An injected temporary-file write failure leaves the prior destination unchanged and leaves no temporary artifact.
- An injected rename failure leaves the prior destination unchanged and removes the temporary artifact.
- A migration rewrite failure throws, leaves the legacy file unchanged, and permits a later retry.
- Successful mutations and migration produce the expected complete JSON snapshot without leftover temporary files.

Verification will run the focused template-store test first, then the repository gate:

```bash
npx vitest run packages/bank-mcp/src/template-store.test.ts
npm run lint
npm run build
npm run test:unit
npm run test:smoke
```

Docker and packed-artifact tests are not required because this change does not touch their inputs.

## Documentation

`docs/ARCHITECTURE.md` will describe `TemplateStore` as fail-fast for existing-file load failures and atomic for mutations and migration rewrites. No user-facing tool schema or guide changes are required.

## Files To Modify

- `packages/bank-mcp/src/template-store.ts`
- `packages/bank-mcp/src/template-store.test.ts`
- `packages/bank-mcp/src/tools/fetch-transactions.ts`
- `docs/ARCHITECTURE.md`
