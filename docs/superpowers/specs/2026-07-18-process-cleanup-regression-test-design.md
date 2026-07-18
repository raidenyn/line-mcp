# Process Cleanup Regression Test Design

## Summary

Correct and harden the two process-harness tests that spawn persistent
descendants. The early-exit fixture will use a valid signal-ignoring descendant
so the test actually exercises process-group cleanup, and both descendant tests
will clean up surviving processes even when setup or assertions fail.

## Problem

The early-exit fixture currently registers handlers for both `SIGTERM` and
`SIGKILL`. Node rejects the `SIGKILL` handler with `uv_signal_start EINVAL`
because `SIGKILL` cannot be caught. The descendant therefore exits by itself,
allowing the test to pass even if `spawnManagedNode` rejects without cleaning
the detached process group.

The explicit-termination and early-exit descendant tests also perform cleanup
only on their successful assertion paths. A setup or assertion failure can
leave the persistent descendant or its detached process group running.

## Scope

Change only `tests/smoke/process-harness.test.ts`.

In scope:

- Correct the early-exit descendant fixture.
- Make the group and grandchild assertions unconditional.
- Add assertion-independent cleanup to the two tests that spawn persistent
  descendants.
- Verify that the test detects the original direct-rejection behavior.

Out of scope:

- Changes to `tests/support/process-harness.ts`.
- Broad cleanup refactoring for tests that do not spawn persistent descendants.
- Production code, package APIs, documentation, or CI configuration changes.

## Test Structure

### Explicit termination

The existing explicit-termination test will continue to spawn a leader and a
same-group grandchild that ignores `SIGTERM`. It will capture both PIDs, then
run setup and behavior assertions inside `try`:

- The detached group and grandchild are alive before termination.
- `managed.terminate()` removes the whole group.
- Both the group probe and individual grandchild probe report `ESRCH` after
  termination.

A `finally` block will best-effort send `SIGKILL` to the group and captured
grandchild PID. It will tolerate missing or already-dead processes so cleanup
does not mask the test result.

### Early exit before readiness

The early-exit leader will spawn a same-group grandchild that ignores only
`SIGTERM`, write the grandchild PID to stderr, wait briefly, and exit before
readiness. Without process-group cleanup, that grandchild remains alive.

The test will capture the leader PID through `onSpawn` and parse the grandchild
PID from the rejection diagnostics. The PID assertion will be mandatory rather
than best-effort. The test will then assert:

- Rejection reports that the child exited before readiness.
- Both captured PIDs are valid.
- The detached group is gone after rejection.
- The grandchild is gone after rejection.

A `finally` block will best-effort kill both the detached group and individual
grandchild PID. This fallback applies even if spawning, PID parsing, or any
assertion fails.

## Cleanup Behavior

Cleanup remains local and explicit in each test. It does not use the behavior
under test as its only safety mechanism:

1. If a valid leader PID was captured, send `SIGKILL` to `-leaderPid`.
2. If a valid grandchild PID was captured, send `SIGKILL` to that PID.
3. Ignore cleanup errors such as `ESRCH`, because the intended test path may
   already have removed the processes.

Group cleanup comes first, while the individual PID kill provides a fallback
if group membership or leader timing differs from expectations.

## Verification

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts
npm run test:smoke
```

Also perform a regression-sensitivity check:

1. Temporarily change the early-exit event path in `spawnManagedNode` back to
   direct rejection without `failSpawn` cleanup.
2. Run the focused early-exit regression test and confirm it fails because the
   group or grandchild remains alive.
3. Restore the current implementation.
4. Run the focused test and full smoke suite and confirm they pass.

The temporary mutation must not remain in the final diff.

## Acceptance Criteria

- The early-exit descendant ignores only catchable `SIGTERM` and remains alive
  after its leader exits if harness cleanup is disabled.
- The early-exit regression test fails against direct rejection and passes
  when rejection is routed through process-group cleanup.
- The test always captures and checks both the detached group and grandchild
  PID.
- Both persistent-descendant tests use `try/finally` cleanup that kills any
  surviving group and individual descendant without masking failures.
- The focused process-harness suite and `npm run test:smoke` pass without
  orphaned processes.
