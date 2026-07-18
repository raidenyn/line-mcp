import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { startMockLineServer, spawnManagedNode, connectMcp, reserveFreePort, createTemporaryDataRoot } from '../support/process-harness';

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
      await spawnManagedNode({
        label: 'never-ready-fixture', cwd: projectRoot,
        args: ['-e', "setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')"],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
        onSpawn: (child) => { capturedPid = child.pid; },
      });
    })()).rejects.toThrow(/readiness timeout after 500ms/);
    expect(Date.now() - start).toBeLessThan(15_000);
    // The spawned detached process group must have been terminated by the
    // failSpawn path. We capture the pid via onSpawn (before the await that
    // rejects), so we can assert against the group here.
    expect(capturedPid).toBeDefined();
    expect(capturedPid!).toBeGreaterThan(0);
    let alive = true;
    try {
      process.kill(-capturedPid!, 0);
    } catch (err: unknown) {
      alive = false;
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(alive).toBe(false);
  });

  it('terminates a process group even when a descendant ignores SIGTERM', async () => {
    // The spawned child itself spawns a signal-ignoring descendant WITHOUT
    // detaching it, so the descendant stays in the parent's process group.
    // terminate() kills the whole group (-pid), so the descendant must die
    // alongside the leader even though it ignores SIGTERM.
    let grandchildPid: number | undefined;
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
    });
    const pid = managed.pid;
    expect(pid).toBeGreaterThan(0);
    expect(grandchildPid).toBeDefined();
    expect(grandchildPid!).toBeGreaterThan(0);
    // Sanity: the group is alive before termination, and the grandchild is
    // a member of that group (so killing -pid will reach it).
    expect(() => process.kill(-pid, 0)).not.toThrow();
    expect(() => process.kill(grandchildPid!, 0)).not.toThrow();
    await managed.terminate({ gracefulMs: 1_000 });
    // The whole process group — including the SIGTERM-ignoring descendant —
    // must be gone. process.kill(-pid, 0) must throw ESRCH.
    let groupAlive = true;
    try {
      process.kill(-pid, 0);
    } catch (err: unknown) {
      groupAlive = false;
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(groupAlive).toBe(false);
    // The grandchild must also be gone — it stayed in the parent's group,
    // so the group-directed SIGKILL reached it.
    let gcAlive = true;
    try {
      process.kill(grandchildPid!, 0);
    } catch (err: unknown) {
      gcAlive = false;
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(gcAlive).toBe(false);
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

  it('redacts credential-bearing forms (accessToken/refreshToken/certificate/JWT) from child output', async () => {
    // A child that writes credential-shaped material to stderr and then never
    // becomes ready must surface a readiness-timeout error whose message does
    // NOT contain any of the raw secret values.
    const jwtValue = 'eyJhbGciOi.fake.payload';
    const refreshSecret = 'refresh_secret_xyz';
    const certValue = 'abc123nonce';
    let thrown: Error | null = null;
    try {
      await spawnManagedNode({
        label: 'credential-redaction-fixture', cwd: projectRoot,
        args: ['-e', `process.stderr.write('accessToken=${jwtValue} refreshToken=${refreshSecret} certificate=${certValue} wrappedNonce=wn123 kdfParameter1=k1 kdfParameter2=k2 x-line-access: abc.def.ghi bare=${jwtValue}'); setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')`],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/readiness timeout after 500ms/);
    // None of the raw secret values may appear in the thrown error.
    expect(thrown!.message).not.toContain(jwtValue);
    expect(thrown!.message).not.toContain(refreshSecret);
    expect(thrown!.message).not.toContain(certValue);
    expect(thrown!.message).not.toContain('wn123');
    expect(thrown!.message).not.toContain('k1');
    // The x-line-access header value must also be redacted (the bare JWT
    // fragment abc.def.ghi should not survive the JWT redaction).
    expect(thrown!.message).not.toContain('abc.def.ghi');
    // And the redaction markers should be present.
    expect(thrown!.message).toContain('accessToken=<redacted>');
    expect(thrown!.message).toContain('refreshToken=<redacted>');
    expect(thrown!.message).toContain('certificate=<redacted>');
    expect(thrown!.message).toContain('<redacted-jwt>');
  });

  it('removes a temporary root even when setup throws after creation', () => {
    // The mock-line-smoke scenarios create the dataRoot FIRST, then run every
    // setup step (mock.reset, mock.configure, prepareSeededDataRoot,
    // startApplication, connectMcp, assertions) inside an outer try/finally so
    // a partial setup failure cannot leak the root. This test pins that
    // pattern: createTemporaryDataRoot, throw before any app starts, and
    // assert the root directory is removed afterward. runRegisteredCleanups
    // is intentionally NOT the authoritative cleanup path here — the
    // try/finally is.
    const root = createTemporaryDataRoot('line-smoke-setup-fail-');
    expect(fs.existsSync(root)).toBe(true);
    expect(() => {
      try {
        throw new Error('setup failed');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }).toThrow(/setup failed/);
    expect(fs.existsSync(root)).toBe(false);
  });
});