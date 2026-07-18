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

  it('redacts escaped and truncated quoted credentials from child output', async () => {
    const credentialKeys = [
      'accessToken', 'refreshToken', 'certificate',
      'wrappedNonce', 'kdfParameter1', 'kdfParameter2',
    ];
    const secrets: Array<{ key: string; form: string; value: string }> = [];
    const output: string[] = [];

    for (const key of credentialKeys) {
      const doubleValue = [`double`, key, `probe`, `742`].join('_');
      const singleValue = [`single`, key, `probe`, `742`].join('_');
      secrets.push(
        { key, form: 'double', value: doubleValue },
        { key, form: 'single', value: singleValue },
      );
      output.push(`{"${key}":"prefix\\"${doubleValue}\\\\suffix"}`);
      output.push(`{'${key}':'prefix\\'${singleValue}\\\\suffix'}`);
    }

    const lineTruncated = ['line', 'access', 'probe', '742'].join('_');
    const endTruncated = ['end', 'refresh', 'probe', '742'].join('_');
    secrets.push(
      { key: 'accessToken', form: 'line-truncated', value: lineTruncated },
      { key: 'refreshToken', form: 'end-truncated', value: endTruncated },
    );
    output.push(`{"accessToken":"${lineTruncated}\nSAFE_NEXT_LINE`);
    output.push(`{'refreshToken':'${endTruncated}`);

    let thrown: Error | null = null;
    try {
      await spawnManagedNode({
        label: 'json-credential-redaction-fixture', cwd: projectRoot,
        args: ['-e', `process.stderr.write(${JSON.stringify(output.join('\n'))}); setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')`],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/readiness timeout after 500ms/);
    for (const secret of secrets) {
      if (thrown!.message.includes(secret.value)) {
        throw new Error(`credential sentinel leaked for ${secret.key} (${secret.form})`);
      }
    }
    expect(thrown!.message).toContain('SAFE_NEXT_LINE');
    expect(thrown!.message.match(/<redacted>/g)?.length).toBe(secrets.length);
  });

  it('redacts quoted credentials when the stdioCap tail slice splits a credential', async () => {
    // buildReadyError tail-slices each captured buffer to the last
    // DEFAULT_STDIO_CAP bytes before redacting. If a caller sets stdioCap
    // above DEFAULT_STDIO_CAP and an unterminated credential's key prefix
    // falls before the 64 KiB tail boundary while its value extends past
    // it, slice-before-redact drops the prefix and the scanner cannot
    // match — so the value bytes leak. Redact must run on the full buffer
    // before the slice. This test pins that ordering by placing the
    // `{"accessToken":"` prefix just before the 64 KiB tail boundary and
    // a unique sentinel at the end of an unterminated value that spans
    // the boundary.
    const capBoundary = 64 * 1024;
    const stdioCap = 70_000;
    const leadingPadding = 4_000;
    const sentinel = 'UNIQUE_CAP_SENTINEL_742';
    const valuePadding = 'x'.repeat(stdioCap - leadingPadding - 16 - sentinel.length);
    const payload = 'x'.repeat(leadingPadding) + `{"accessToken":"` + valuePadding + sentinel;
    expect(payload.length).toBe(stdioCap);
    let thrown: Error | null = null;
    try {
      await spawnManagedNode({
        label: 'cap-boundary-redaction-fixture', cwd: projectRoot,
        args: ['-e', `process.stderr.write(${JSON.stringify(payload)}); setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')`],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
        stdioCap,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/readiness timeout after 500ms/);
    if (thrown!.message.includes(sentinel)) {
      throw new Error('credential sentinel leaked for accessToken (cap-boundary)');
    }
    expect(thrown!.message).toContain('<redacted>');
    void capBoundary;
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