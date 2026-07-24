# Regex ReDoS Containment Design

**Issue:** [#61](https://github.com/raidenyn/line-mcp/issues/61)

## Problem

`@raidenyn/bank-mcp` executes user-controlled JavaScript regular expressions
synchronously on the server event loop. The existing nested-quantifier
heuristic rejects only a narrow pattern shape. Overlapping alternatives such as
`(a|aa)+$` and bounded nested quantifiers bypass it and can consume seconds of
CPU on short non-matching input.

The vulnerable execution paths are:

- inline and saved transaction templates;
- category patterns;
- merchant filter patterns;
- saved-template checks during preset detection; and
- built-in preset checks during preset detection.

Saved templates and categories currently receive no regex syntax validation
before persistence. A bad saved pattern can therefore fail repeatedly on later
calls. Because JavaScript regex execution is synchronous, one authenticated
principal can block unrelated requests handled by the same process.

## Goals

- Keep the server event loop responsive while evaluating every bank regex.
- Preserve the full JavaScript regex language, including named groups,
  lookarounds, and backreferences.
- Enforce a hard, configurable execution budget for each match.
- Fail the affected MCP call clearly instead of returning partial financial
  results.
- Validate regex syntax before saving templates, categories, or presets.
- Bound worker concurrency, queued work, IPC payload size, and worker memory.
- Preserve existing first-match and output-order behavior.

## Non-Goals

- Proving statically that a JavaScript regex is safe for every possible input.
  This is not reliable while preserving the full JavaScript regex language.
- Replacing JavaScript regex syntax with the RE2 subset.
- Automatically rewriting dangerous patterns.
- Migrating or deleting existing saved patterns.
- Making worker count, queue capacity, or memory limits operator-configurable.

## Chosen Approach

Run each regex match in a bounded, reusable `worker_threads` pool. A parent-side
timer starts only after a worker accepts a job. If the match exceeds its budget,
the parent rejects the job, terminates the blocked worker, and creates a clean
replacement.

This approach preserves JavaScript regex behavior while preventing catastrophic
backtracking from blocking the main event loop. Reusing workers avoids the CPU
and memory cost of creating one worker per ordinary match. Fixed pool and queue
limits prevent concurrent hostile calls from creating unbounded workers or
pending regex jobs.

Fresh workers per match were rejected because normal transaction scans may
perform hundreds of matches and concurrent callers could exhaust process
resources through worker creation. A child-process pool was rejected because
its stronger crash boundary does not justify the additional IPC, packaging,
cleanup, Docker, and test complexity for this event-loop blocking threat.

## Architecture

### Regex Executor

Add an explicitly constructed `RegexExecutor` to `@raidenyn/bank-mcp`. It owns:

- two lazily started workers;
- a FIFO queue capped at 100 pending jobs;
- per-job timeout enforcement;
- worker termination and replacement;
- worker `resourceLimits` of 32 MiB old generation, 8 MiB young generation,
  and 4 MiB stack;
- a 16,384 UTF-16-code-unit pattern limit and a 65,536-code-unit subject limit;
  and
- idempotent shutdown.

The executor exposes asynchronous `validate`, `exec`, and `test` operations.
Each operation accepts a caller-supplied context that identifies the source,
such as a template, category, filter, or preset name. `exec` returns only the
structured-clone-safe match data needed by transaction parsing, including named
capture groups. `test` returns a boolean.

The worker module is the only bank-package code that constructs or executes a
native `RegExp` from user-controlled input. Compiled regexes never leave a
worker and are not cached on the main thread.

Worker construction remains lazy so importing `@raidenyn/bank-mcp` creates no
workers, timers, or other side effects.

### Timeout Configuration

The composed CLI reads `BANK_REGEX_TIMEOUT_MS` and passes the parsed value
through `ServerOptions`. The default is 100 milliseconds per match. Values are
clamped to the inclusive range 10-1000 milliseconds; a non-numeric value uses
the default.

The timer measures compilation plus execution after worker assignment, not time
waiting in the queue. A `validate` job is timed around compilation alone. This
prevents pool contention from falsely reporting a regex timeout while still
containing pathological compilation. Queue saturation instead produces a
distinct busy error.

Worker count, queue capacity, payload limits, and memory limits remain fixed
security controls. They are not environment settings.

### Composition And Lifecycle

`createServer` constructs one executor when the composed server starts, injects
it through `BankToolDeps`, and closes it during server shutdown after HTTP work
has drained and before database teardown. Tests may pass an explicit timeout or
executor without reading process environment state.

Closing the executor rejects queued jobs, terminates both workers, and is
idempotent. A worker that crashes or times out rejects its active job and is
replaced before more work is assigned to that slot.

## Data Flow

The regex-dependent domain operations become asynchronous and receive the
executor explicitly:

- `parseTransaction` awaits template matches in template order and returns the
  first valid transaction, as today.
- `categorize` awaits category tests in insertion order and applies the first
  matching category.
- `validateFilters` validates merchant filter syntax in workers.
- `filterTransactions` awaits merchant tests while preserving transaction order
  and OR semantics among merchant patterns.
- `detectPresets` awaits both saved-template and built-in preset tests while
  preserving current suggestion counts and order.

The transaction tools, summary helper, and `sample_messages` await these stages.
No regex-dependent stage returns partial output after an error.

### Persistence Validation

The `manage_templates` and `manage_categories` upsert actions call worker-side
`validate` before invoking their persistence stores. Preset application
validates every template pattern before performing any preset writes, so a
malformed preset cannot be partially applied. Lower-level migration primitives
continue preserving existing data without executing or deleting patterns.

Validation guarantees syntax validity and enforces the 16,384-code-unit pattern
limit. It does not claim that a syntactically valid JavaScript regex is safe
against every future subject. Runtime isolation and timeout enforcement are the
security boundary for data-dependent behavior.

Existing saved patterns are not rewritten or removed. They remain available to
list and delete. Invalid, oversized, or timed-out existing patterns fail clearly
when a call tries to execute them, without blocking unrelated requests.

## Error Handling

The executor distinguishes these failures internally:

- invalid regex syntax;
- pattern over 16,384 code units or subject over 65,536 code units;
- match execution timeout;
- full pending-work queue;
- worker crash; and
- executor shutdown.

MCP-facing errors identify the operation and pattern context where available.
Timeouts abort the whole tool call. Transaction and summary tools never return
silently incomplete financial data, and preset detection never returns a
partial set of suggestions.

The current `NESTED_QUANTIFIER_RE` heuristic and main-thread regex cache are
removed. A heuristic may reject safe patterns or miss unsafe ones and therefore
must not remain as a security decision point.

## Compatibility

The worker uses native JavaScript `RegExp`, preserving current flags and syntax.
Named capture groups continue to drive transaction extraction. Lookarounds and
backreferences remain supported. Existing first-template, first-category,
filter OR, transaction-order, and preset-suggestion behavior remains unchanged
except that invalid or resource-exhausting patterns now fail the call clearly
instead of being silently skipped or blocking the process.

The regex-dependent exported functions become asynchronous. This is acceptable
because the package is private and all repository consumers will be migrated in
the same change.

## Testing

### Executor Tests

- Verify successful `exec`, `test`, named groups, lookarounds, and
  backreferences.
- Verify invalid syntax and pattern/subject-size failures.
- Run `(a|aa)+$` against a non-match with a low injected timeout and assert
  prompt rejection.
- Cover a bounded-quantifier catastrophic-backtracking bypass with the same
  timeout assertion.
- Verify a main-thread timer continues to tick while a worker is blocked.
- Verify the timed-out worker is replaced and the next normal job succeeds.
- Verify queue saturation rejects excess work without creating more workers.
- Verify worker crashes reject the active job and trigger replacement.
- Verify timeout configuration defaulting and bounds.
- Verify `close()` rejects pending work, terminates workers, and is idempotent.

Timeout regression tests use an executor budget substantially below their test
runner timeout. They assert both the typed timeout result and a generous outer
wall-clock bound, avoiding dependence on an exact scheduler duration.

### Call-Site Tests

- Inline transaction templates.
- Saved transaction templates.
- Category matching.
- Merchant filter validation and matching.
- Saved-template checks in preset detection.
- Built-in preset checks in preset detection.
- Template and category syntax validation before persistence.
- All-pattern validation before preset application writes.
- Full-call failure rather than partial transaction, summary, or suggestion
  output.
- Preservation of matching priority and result ordering.

### Verification

Run the mandatory repository gate:

```bash
npm run lint && npm run build && npm run test:unit && npm run test:smoke
```

## Documentation

Update `docs/ARCHITECTURE.md` for the new bank-package executor, asynchronous
regex flow, and composed-server lifecycle. Update `README.md` and the relevant
bank tool guides to document `BANK_REGEX_TIMEOUT_MS`, the default and allowed
range, syntax validation, timeout failure behavior, and the guarantee that
regex execution is isolated from the main event loop.
