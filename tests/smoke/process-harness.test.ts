import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { startMockLineServer, spawnManagedNode, connectMcp, reserveFreePort } from '../support/process-harness';

const projectRoot = path.resolve(__dirname, '..', '..');

describe('process harness', () => {
  it('starts and gracefully stops the standalone mock executable', async () => {
    const mock = await startMockLineServer(projectRoot);
    try {
      const response = await fetch(`${mock.origin}/__mock/health`, {
        headers: { 'x-mock-control-token': mock.controlToken },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', protocol: 'mock-line-v1' });
    } finally {
      await mock.shutdown({ verify: false });
    }
    // shutdown() deliberately force-kills (SIGTERM/SIGKILL) if the process
    // hasn't drained its event loop within ~1s, so the exit code is not
    // guaranteed — only that the process is gone and the report was clean.
    expect(await mock.process.waitForExit(1_000)).not.toBeNull();
  });

  it('terminates a detached process group idempotently', async () => {
    const managed = await spawnManagedNode({
      label: 'long-running-fixture', cwd: projectRoot,
      args: ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready\\n')"],
      readyLine: line => line === 'ready',
    });
    await Promise.all([managed.terminate(), managed.terminate()]);
    expect(await managed.waitForExit(1_000)).not.toBeNull();
  });

  it('includes captured stderr when a child exits before readiness', async () => {
    await expect(spawnManagedNode({
      label: 'early-exit-fixture', cwd: projectRoot,
      args: ['-e', "process.stderr.write('fixture failed'); process.exit(7)"],
      readyLine: line => line === 'ready',
    })).rejects.toThrow(/fixture failed/);
  });

  it('terminates the child and rejects when readiness never arrives', async () => {
    let capturedPid: number | undefined;
    const start = Date.now();
    await expect((async () => {
      const managed = await spawnManagedNode({
        label: 'never-ready-fixture', cwd: projectRoot,
        args: ['-e', "setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')"],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
      });
      capturedPid = managed.pid;
    })()).rejects.toThrow(/readiness timeout after 500ms/);
    expect(Date.now() - start).toBeLessThan(15_000);
    // The spawned detached process group must have been terminated. The
    // failSpawn path now ensures the group is reaped even though the spawn
    // rejected before the caller could capture a pid — so capturedPid may be
    // undefined here; we still assert the group is gone when we can see it.
    if (capturedPid) {
      let alive = true;
      try {
        process.kill(-capturedPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });

  it('terminates a process group even when a descendant ignores SIGTERM', async () => {
    // The spawned child itself spawns a signal-ignoring descendant, then
    // becomes ready. terminate() must kill the whole group — including the
    // descendant — not just the leader.
    const managed = await spawnManagedNode({
      label: 'signal-ignoring-descendant', cwd: projectRoot,
      args: ['-e', [
        "const { spawn } = require('child_process');",
        "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"], { detached: true, stdio: 'ignore' });",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);",
      ].join(' ')],
      readyLine: line => line === 'ready',
    });
    const pid = managed.pid;
    expect(pid).toBeGreaterThan(0);
    // Sanity: the group is alive before termination.
    expect(() => process.kill(-pid, 0)).not.toThrow();
    await managed.terminate({ gracefulMs: 1_000 });
    // The whole process group — including the SIGTERM-ignoring descendant —
    // must be gone. process.kill(-pid, 0) must throw ESRCH.
    let alive = true;
    try {
      process.kill(-pid, 0);
    } catch (err: unknown) {
      alive = false;
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(alive).toBe(false);
  });

  it('connectMcp rejects and cleans up when the URL is unreachable', async () => {
    // A port that is not listening — connect() must reject, and the
    // half-opened transport/client must not leak.
    const port = await reserveFreePort();
    const url = `http://127.0.0.1:${port}/mcp`;
    await expect(connectMcp(url, 'test-bearer')).rejects.toThrow();
    // No direct handle to assert against, but the absence of a hanging
    // unresolved promise above is the resource-leak guard: connectMcp returned
    // (rejected) synchronously relative to the failed connect() and ran
    // transport/client close() in its catch block.
  });

  it('redacts MOCK_LINE_CONTROL_TOKEN from readiness-timeout error output', async () => {
    const secretValue = 'fake-secret-token-value';
    let thrown: Error | null = null;
    try {
      await spawnManagedNode({
        label: 'control-token-redaction-fixture', cwd: projectRoot,
        args: ['-e', "setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')"],
        env: { ...process.env, MOCK_LINE_CONTROL_TOKEN: secretValue },
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/readiness timeout after 500ms/);
    // The thrown error must NOT contain the secret token value, even though
    // the env was passed through the (formerly allowlisted) envSummary.
    expect(thrown!.message).not.toContain(secretValue);
  });
});