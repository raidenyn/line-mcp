# Process Cleanup Regression Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the process-harness descendant tests prove early-exit group cleanup and guarantee fallback cleanup when setup or assertions fail.

**Architecture:** Keep the change entirely in `tests/smoke/process-harness.test.ts`. Each of the two persistent-descendant tests captures leader and grandchild PIDs, performs strict lifecycle assertions inside `try`, and best-effort kills the group and individual descendant in `finally`; a temporary mutation of the existing harness establishes that the early-exit test fails against direct rejection.

**Tech Stack:** TypeScript, Node.js child processes and POSIX process groups, Vitest 4.

## Global Constraints

- Final code changes are limited to `tests/smoke/process-harness.test.ts`.
- Do not change production package code, public APIs, documentation, or CI configuration.
- The early-exit descendant must ignore only catchable `SIGTERM`; it must not register a `SIGKILL` handler.
- Both persistent-descendant tests must clean up the detached group and captured grandchild PID in `finally` without masking the original failure.
- The early-exit test must unconditionally assert that both the detached group and captured grandchild PID are gone.
- The temporary mutation in `tests/support/process-harness.ts` is verification-only and must not remain in the final diff or commit.

---

### Task 1: Correct and harden persistent-descendant lifecycle tests

**Files:**
- Modify: `tests/smoke/process-harness.test.ts:72-181`
- Temporarily modify for regression verification only: `tests/support/process-harness.ts:187-203`
- Reference: `docs/superpowers/specs/2026-07-18-process-cleanup-regression-test-design.md`

**Interfaces:**
- Consumes: `spawnManagedNode(options: SpawnOptions): Promise<ManagedProcess>`, `ManagedProcess.terminate(options?: { gracefulMs?: number }): Promise<void>`, and Node's `process.kill(pid, signal)`.
- Produces: Two self-cleaning Vitest regression tests; no exported functions, runtime interfaces, or production behavior changes.

- [ ] **Step 1: Rewrite the explicit-termination test with assertion-independent cleanup**

Replace the existing `terminates a process group even when a descendant ignores SIGTERM` test with:

```typescript
  it('terminates a process group even when a descendant ignores SIGTERM', async () => {
    // The spawned child itself spawns a signal-ignoring descendant WITHOUT
    // detaching it, so the descendant stays in the parent's process group.
    // terminate() kills the whole group (-pid), so the descendant must die
    // alongside the leader even though it ignores SIGTERM.
    let leaderPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const managed = await spawnManagedNode({
        label: 'signal-ignoring-descendant', cwd: projectRoot,
        args: ['-e', [
          "const { spawn } = require('child_process');",
          "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
          "process.stdout.write(String(gc.pid) + '\\n');",
          "setInterval(() => {}, 1000);",
        ].join(' ')],
        readyLine: (line) => {
          const parsed = Number.parseInt(line.trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            grandchildPid = parsed;
            return true;
          }
          return false;
        },
        onSpawn: (child) => { leaderPid = child.pid; },
      });
      leaderPid = managed.pid;
      expect(leaderPid).toBeGreaterThan(0);
      expect(grandchildPid).toBeDefined();
      expect(grandchildPid!).toBeGreaterThan(0);
      // Sanity: the group is alive before termination, and the grandchild is
      // a member of that group (so killing -pid will reach it).
      expect(() => process.kill(-leaderPid!, 0)).not.toThrow();
      expect(() => process.kill(grandchildPid!, 0)).not.toThrow();
      await managed.terminate({ gracefulMs: 1_000 });
      // The whole process group, including the SIGTERM-ignoring descendant,
      // must be gone.
      let groupAlive = true;
      try {
        process.kill(-leaderPid!, 0);
      } catch (err: unknown) {
        groupAlive = false;
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      expect(groupAlive).toBe(false);
      let gcAlive = true;
      try {
        process.kill(grandchildPid!, 0);
      } catch (err: unknown) {
        gcAlive = false;
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      expect(gcAlive).toBe(false);
    } finally {
      if (leaderPid != null && leaderPid > 0) {
        try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* already dead */ }
      }
      if (grandchildPid != null && grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  });
```

- [ ] **Step 2: Rewrite the early-exit test with a valid fixture and mandatory PID assertions**

Replace the existing `cleans up the process group when the child exits before readiness` test with:

```typescript
  it('cleans up the process group when the child exits before readiness', async () => {
    // The child spawns a same-group descendant that ignores SIGTERM and then
    // exits before readiness. The descendant remains alive unless the harness
    // cleans the detached process group before rejecting.
    let capturedPid: number | undefined;
    let grandchildPid: number | undefined;
    let thrown: Error | null = null;
    try {
      try {
        await spawnManagedNode({
          label: 'early-exit-with-descendant', cwd: projectRoot,
          args: ['-e', [
            "const { spawn } = require('child_process');",
            "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
            "process.stderr.write('grandchild=' + gc.pid + '\\n');",
            "setTimeout(() => process.exit(7), 100);",
          ].join(' ')],
          readyLine: line => line === 'ready',
          readyTimeoutMs: 5_000,
          onSpawn: (child) => { capturedPid = child.pid; },
        });
      } catch (err) {
        thrown = err as Error;
        const match = thrown.message.match(/grandchild=(\d+)/);
        if (match) grandchildPid = Number.parseInt(match[1], 10);
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toMatch(/child exited before readiness/);
      expect(capturedPid).toBeDefined();
      expect(capturedPid!).toBeGreaterThan(0);
      expect(grandchildPid).toBeDefined();
      expect(grandchildPid!).toBeGreaterThan(0);
      let groupAlive = true;
      try {
        process.kill(-capturedPid!, 0);
      } catch (err: unknown) {
        groupAlive = false;
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      expect(groupAlive).toBe(false);
      let gcAlive = true;
      try {
        process.kill(grandchildPid!, 0);
      } catch (err: unknown) {
        gcAlive = false;
        expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      expect(gcAlive).toBe(false);
    } finally {
      if (capturedPid != null && capturedPid > 0) {
        try { process.kill(-capturedPid, 'SIGKILL'); } catch { /* already dead */ }
      }
      if (grandchildPid != null && grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  });
```

- [ ] **Step 3: Run the corrected tests against the current harness**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts -t "descendant|child exits before readiness"
```

Expected: the explicit-termination and early-exit descendant tests both pass. The command exits `0`, and Vitest reports the other tests in the file as skipped by the name filter.

- [ ] **Step 4: Temporarily restore direct rejection to prove the early-exit test detects the regression**

In `tests/support/process-harness.ts`, temporarily replace the current `child.on('exit')` callback with the original direct-rejection behavior:

```typescript
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        cleanupEarly();
        if (options.readyLine) {
          const exitCode = code != null ? code : (signal != null ? -1 : 0);
          reject(buildReadyError(
            options.label,
            `child exited before readiness (code=${exitCode} signal=${signal ?? 'null'})`,
            stdoutBuf,
            stderrBuf,
            options.env,
          ));
        } else {
          resolve(makeManaged(child, () => stdoutBuf, () => stderrBuf));
        }
      }
    });
```

Do not stage or commit this temporary mutation.

- [ ] **Step 5: Run the early-exit regression test and verify it fails safely**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts -t "cleans up the process group when the child exits before readiness"
```

Expected: FAIL at `expect(groupAlive).toBe(false)` or `expect(gcAlive).toBe(false)`, proving the descendant survives direct rejection. The test's `finally` block then kills the surviving group and PID, so Vitest exits rather than hanging.

- [ ] **Step 6: Restore the current cleanup-enabled early-exit callback**

Replace the temporary callback in `tests/support/process-harness.ts` with the cleanup-enabled implementation:

```typescript
    child.on('exit', (code, signal) => {
      if (!settled) {
        cleanupEarly();
        if (options.readyLine) {
          const exitCode = code != null ? code : (signal != null ? -1 : 0);
          // Route the early-exit rejection through failSpawn so the child's
          // process group is cleaned up (terminateChildNow + group-kill +
          // waitForGroupExit) before the rejection fires. A descendant
          // that the child spawned in the same group and that ignores
          // signals would otherwise survive a synchronous reject() here.
          // failSpawn is async and child.on('exit') can't await, so use the
          // same void-fire pattern as child.on('error') below.
          void failSpawn(`child exited before readiness (code=${exitCode} signal=${signal ?? 'null'})`);
        } else {
          settled = true;
          resolve(makeManaged(child, () => stdoutBuf, () => stderrBuf));
        }
      }
    });
```

Run:

```bash
git diff -- tests/support/process-harness.ts
```

Expected: no output. If the diff is non-empty, restore the exact pre-task callback before continuing.

- [ ] **Step 7: Run the focused process-harness suite**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts
```

Expected: PASS with all tests in `tests/smoke/process-harness.test.ts` passing and no unhandled-process or timeout errors.

- [ ] **Step 8: Run the complete smoke suite**

Run:

```bash
npm run test:smoke
```

Expected: `npm run build` succeeds, every test under `tests/smoke` passes, and the command exits `0` without hanging or reporting leaked child processes.

- [ ] **Step 9: Verify the final diff is test-only and clean**

Run:

```bash
git status --short
git diff --check
git diff -- tests/smoke/process-harness.test.ts tests/support/process-harness.ts
```

Expected: only `tests/smoke/process-harness.test.ts` is modified by the implementation; `tests/support/process-harness.ts` has no diff; `git diff --check` prints nothing.

- [ ] **Step 10: Commit the implementation**

Run:

```bash
git add tests/smoke/process-harness.test.ts
git commit -m "test: harden process cleanup regression coverage"
```

Expected: one commit containing only the two descendant-test changes. Do not stage `tests/support/process-harness.ts`.
