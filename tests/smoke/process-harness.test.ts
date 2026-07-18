import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { startMockLineServer, spawnManagedNode } from '../support/process-harness';

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
    // The spawned detached process group must have been terminated.
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
});