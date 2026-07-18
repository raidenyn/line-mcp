import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MockScenarioConfig, MockReport } from './mock-line-server/state';

const SAFE_ENV_KEYS = new Set([
  'PORT', 'DATA_DIR', 'BASE_PATH', 'PUBLIC_URL', 'LINE_API_BASE_URL',
  'NODE_ENV', 'TS_NODE_PROJECT', 'TS_NODE_IGNORE_DIAGNOSTICS',
  'PATH',
]);
const MID_PATTERN = /u_[a-z0-9_]+/gi;

function isGroupAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid)) return;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

const QUOTED_CREDENTIAL_PREFIX = /(["'])(accessToken|refreshToken|certificate|wrappedNonce|kdfParameter1|kdfParameter2)\1(\s*:\s*)(["'])/gi;

function redactQuotedCredentials(value: string): string {
  let result = '';
  let copiedThrough = 0;
  let match: RegExpExecArray | null;

  QUOTED_CREDENTIAL_PREFIX.lastIndex = 0;
  while ((match = QUOTED_CREDENTIAL_PREFIX.exec(value)) !== null) {
    const valueQuote = match[4];
    let cursor = QUOTED_CREDENTIAL_PREFIX.lastIndex;

    result += value.slice(copiedThrough, cursor) + '<redacted>';
    while (cursor < value.length && value[cursor] !== '\r' && value[cursor] !== '\n') {
      if (value[cursor] === '\\' && cursor + 1 < value.length
          && value[cursor + 1] !== '\r' && value[cursor + 1] !== '\n') {
        cursor += 2;
        continue;
      }
      if (value[cursor] === valueQuote) {
        result += valueQuote;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    copiedThrough = cursor;
    QUOTED_CREDENTIAL_PREFIX.lastIndex = cursor;
  }

  return result + value.slice(copiedThrough);
}

function redact(value: string): string {
  return redactQuotedCredentials(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
    .replace(/(x-mock-control-token:\s*)([^\r\n]*)/gi, '$1<redacted>')
    .replace(/(x-line-access:\s*)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(MOCK_LINE_CONTROL_TOKEN=)([^\r\n]*)/gi, '$1<redacted>')
    .replace(/(accessToken=)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(refreshToken=)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(certificate=)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(wrappedNonce=)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(kdfParameter1=)([^\s\r\n]*)/gi, '$1<redacted>')
    .replace(/(kdfParameter2=)([^\s\r\n]*)/gi, '$1<redacted>')
    // JWT-like tokens (base64url header starting with eyJ...) — match the
    // full three-segment JWT form, or any long eyJ... run, and replace.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>')
    .replace(MID_PATTERN, '<mid>');
}

function filterSafeEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    if (SAFE_ENV_KEYS.has(key)) {
      out[key] = env[key];
    }
  }
  return out;
}

const DEFAULT_STDIO_CAP = 64 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_GRACEFUL_MS = 2_000;

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  waitForExit(timeoutMs: number): Promise<number | null>;
  terminate(options?: { gracefulMs?: number }): Promise<void>;
}

export interface SpawnOptions {
  label: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  readyLine?: (line: string) => boolean;
  readyTimeoutMs?: number;
  stdioCap?: number;
  onSpawn?: (child: ChildProcess) => void;
}

interface BuiltProcess extends ManagedProcess {
  readonly stdout: string;
  readonly stderr: string;
}

function buildReadyError(label: string, reason: string, stdout: string, stderr: string, env?: NodeJS.ProcessEnv): Error {
  const envSummary = env ? redact(JSON.stringify(filterSafeEnv(env))) : '';
  const msg = [
    `[${label}] ${reason}`,
    `--- stdout ---`,
    redact(stdout).slice(-Math.min(stdout.length, DEFAULT_STDIO_CAP)),
    `--- stderr ---`,
    redact(stderr).slice(-Math.min(stderr.length, DEFAULT_STDIO_CAP)),
    envSummary ? `--- env (safe allowlist) ---\n${envSummary}` : '',
  ].filter(Boolean).join('\n');
  return new Error(msg);
}

export function spawnManagedNode(options: SpawnOptions): Promise<ManagedProcess> {
  return new Promise<ManagedProcess>((resolve, reject) => {
    const cap = options.stdioCap ?? DEFAULT_STDIO_CAP;
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    const child = spawn(process.execPath, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Notify the caller of the child as soon as it exists — before any
    // readiness await — so a timeout/rejection on spawn can still surface
    // the pid for cleanup-group assertions.
    try {
      options.onSpawn?.(child);
    } catch { /* user hook must not break spawn */ }

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let pendingLines = '';
    let timer: NodeJS.Timeout | null = null;

    const cleanupEarly = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const failSpawn = async (reason: string) => {
      if (settled) return;
      settled = true;
      cleanupEarly();
      // The child was already spawned; a readiness failure must not leak it.
      // Capture the pid before terminating so callers can assert against the
      // process group even when the spawn never resolved into a handle.
      const failPid = child.pid;
      await terminateChildNow(child);
      if (failPid != null && failPid > 0 && isGroupAlive(failPid)) {
        try { process.kill(-failPid, 'SIGKILL'); } catch { /* already dead */ }
        await waitForGroupExit(failPid, 2_000);
      }
      reject(buildReadyError(options.label, reason, stdoutBuf, stderrBuf, options.env));
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBuf.length < cap) stdoutBuf += chunk.toString('utf8').slice(0, cap - stdoutBuf.length);
        if (options.readyLine) {
          pendingLines += chunk.toString('utf8');
          let nl: number;
          while ((nl = pendingLines.indexOf('\n')) >= 0) {
            const line = pendingLines.slice(0, nl);
            pendingLines = pendingLines.slice(nl + 1);
            if (!settled && options.readyLine(line)) {
              settled = true;
              cleanupEarly();
              resolve(makeManaged(child, () => stdoutBuf, () => stderrBuf));
              return;
            }
          }
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBuf.length < cap) stderrBuf += chunk.toString('utf8').slice(0, cap - stderrBuf.length);
      });
    }

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
    child.on('error', (err) => {
      failSpawn(`spawn error: ${err.message}`);
    });

    if (options.readyLine) {
      timer = setTimeout(() => {
        failSpawn(`readiness timeout after ${readyTimeoutMs}ms`);
      }, readyTimeoutMs);
    } else {
      settled = true;
      resolve(makeManaged(child, () => stdoutBuf, () => stderrBuf));
    }
  });
}

async function terminateChildNow(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid == null || pid <= 0) return;
  if (child.exitCode != null || child.signalCode != null) {
    // Leader is gone, but descendants that ignore signals may still live.
    if (isGroupAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
      await waitForGroupExit(pid, 2_000);
    }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  const exited = await new Promise<number | null>((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve(child.exitCode ?? (child.signalCode ? -1 : 0));
      return;
    }
    const onExit = (code: number | null) => {
      clearTimeout(fallback);
      resolve(code != null ? code : -1);
    };
    const fallback = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(null);
    }, 2_000);
    child.once('exit', onExit);
  });
  // Whether or not the leader exited, ensure the whole group is gone.
  // A descendant that ignores SIGTERM can keep the group alive after the
  // leader exits — probe the group itself and SIGKILL it if any member remains.
  if (isGroupAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
    await waitForGroupExit(pid, 2_000);
  }
  void exited;
}

function makeManaged(child: ChildProcess, getStdout: () => string, getStderr: () => string): BuiltProcess {
  let exitPromise: Promise<number | null> | null = null;
  let terminatePromise: Promise<void> | null = null;
  const pid = child.pid ?? -1;

  function getExitPromise(): Promise<number | null> {
    if (exitPromise) return exitPromise;
    exitPromise = new Promise<number | null>((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve(child.exitCode ?? (child.signalCode ? -1 : 0));
        return;
      }
      child.once('exit', (code, signal) => {
        resolve(code != null ? code : (signal != null ? -1 : 0));
      });
    });
    return exitPromise;
  }

  function waitForExit(timeoutMs: number): Promise<number | null> {
    return Promise.race([
      getExitPromise(),
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  function terminate(terminateOptions?: { gracefulMs?: number }): Promise<void> {
    if (terminatePromise) return terminatePromise;
    const gracefulMs = terminateOptions?.gracefulMs ?? DEFAULT_GRACEFUL_MS;
    terminatePromise = (async () => {
      if (pid <= 0) return;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      // Wait for the whole group to die, not just the leader. A descendant
      // that ignores SIGTERM can keep the group alive after the leader exits,
      // so probe the group itself with process.kill(-pid, 0).
      await waitForGroupExit(pid, gracefulMs);
      if (isGroupAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
        await waitForGroupExit(pid, 2_000);
      }
    })();
    return terminatePromise;
  }

  return {
    get child() { return child; },
    get pid() { return pid; },
    get stdout() { return getStdout(); },
    get stderr() { return getStderr(); },
    waitForExit,
    terminate,
  };
}

export function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to reserve port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForHttp(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; expectJson?: (body: unknown) => boolean } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const expectJson = options.expectJson ?? ((b) => b != null && typeof b === 'object' && (b as { status?: string }).status === 'ok');
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (expectJson(body)) return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForHttp timeout for ${url} (last error: ${lastErr ?? 'none'})`);
}

export interface RunningMock {
  readonly process: ManagedProcess;
  readonly origin: string;
  readonly controlToken: string;
  reset(): Promise<void>;
  configure(config: MockScenarioConfig): Promise<void>;
  report(): Promise<MockReport>;
  shutdown(options?: { verify?: boolean }): Promise<MockReport>;
}

const registeredCleanups: Array<() => Promise<void>> = [];

export function registerCleanup(fn: () => Promise<void>): void {
  registeredCleanups.push(fn);
}

export async function runRegisteredCleanups(): Promise<void> {
  const fns = registeredCleanups.splice(0);
  for (const fn of fns.reverse()) {
    try { await fn(); } catch { /* swallow; original failure already surfaced */ }
  }
}

function parseReadyMessage(line: string): { host: string; port: number; protocol: string } | null {
  try {
    const obj = JSON.parse(line);
    if (obj && obj.event === 'mock-line-ready' && typeof obj.host === 'string' && typeof obj.port === 'number') {
      return { host: obj.host, port: obj.port, protocol: obj.protocol };
    }
  } catch { /* not JSON */ }
  return null;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function startMockLineServer(projectRoot: string): Promise<RunningMock> {
  const controlToken = randomToken();
  const child = await spawnManagedNode({
    label: 'mock-line-server',
    cwd: projectRoot,
    args: [
      '-r', 'ts-node/register/transpile-only',
      path.join(projectRoot, 'tests/support/mock-line-server/cli.ts'),
    ],
    env: {
      ...process.env,
      PORT: '0',
      MOCK_LINE_CONTROL_TOKEN: controlToken,
      TS_NODE_PROJECT: path.join(projectRoot, 'tsconfig.base.json'),
      TS_NODE_IGNORE_DIAGNOSTICS: '5011',
    },
    readyLine: (line) => parseReadyMessage(line) !== null,
    readyTimeoutMs: 60_000,
  });

  const ready = parseReadyMessage((child.stdout.split('\n').find((l) => parseReadyMessage(l) !== null)) ?? '');
  if (!ready) throw new Error('mock-line-server ready line not found after spawn');
  const origin = `http://${ready.host}:${ready.port}`;

  registerCleanup(async () => { try { await child.terminate(); } catch { /* */ } });

  function controlHeaders(): Record<string, string> {
    return { 'x-mock-control-token': controlToken };
  }

  async function reset(): Promise<void> {
    const res = await fetch(`${origin}/__mock/reset`, { method: 'POST', headers: controlHeaders() });
    if (!res.ok) throw new Error(`mock reset failed: ${res.status}`);
  }
  async function configure(config: MockScenarioConfig): Promise<void> {
    const res = await fetch(`${origin}/__mock/configure`, {
      method: 'POST',
      headers: { ...controlHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`mock configure failed: ${res.status} ${await res.text()}`);
  }
  async function report(): Promise<MockReport> {
    const res = await fetch(`${origin}/__mock/report`, { headers: controlHeaders() });
    if (!res.ok) throw new Error(`mock report failed: ${res.status}`);
    return await res.json() as MockReport;
  }
  async function shutdown(options?: { verify?: boolean }): Promise<MockReport> {
    const verify = options?.verify ?? false;
    let report: MockReport;
    try {
      const res = await fetch(`${origin}/__mock/shutdown`, { method: 'POST', headers: controlHeaders() });
      if (res.ok) {
        report = await res.json() as MockReport;
      } else {
        report = await fetchReportSafe();
      }
    } catch {
      report = await fetchReportSafe();
    }
    // The report was already received via HTTP; wait only briefly for the
    // server's natural exit (event loop draining after server.close()), then
    // force-kill deterministically. The keep-alive socket from our own
    // fetch('/__mock/shutdown') can hold the CLI alive for ~4s, so do NOT
    // rely on a natural exit within the wait window — terminate instead.
    const exitCode = await child.waitForExit(1_000);
    if (exitCode == null) {
      try { await child.terminate({ gracefulMs: 3_000 }); } catch { /**/ }
    }
    if (verify && report && !report.ok) {
      throw new Error(`mock shutdown verification failed: ${JSON.stringify(report.verificationErrors)}`);
    }
    return report;
  }

  async function fetchReportSafe(): Promise<MockReport> {
    try {
      const res = await fetch(`${origin}/__mock/report`, { headers: controlHeaders() });
      if (res.ok) return await res.json() as MockReport;
    } catch { /* server gone */ }
    return {
      scenarioId: null, routeCounts: {}, observedLoginBranches: [], refreshCount: 0,
      expectedRejections: {}, observedExpectedRejections: {}, violations: [],
      pendingLineRequests: 0, unresolvedSessions: 0, verificationErrors: [], ok: false,
    };
  }

  return {
    process: child,
    origin,
    controlToken,
    reset,
    configure,
    report,
    shutdown,
  };
}

export type AppTarget = 'composed' | 'standalone';

export interface RunningApp {
  readonly process: ManagedProcess;
  readonly origin: string;
  readonly mcpUrl: string;
  readonly dataRoot: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface StartApplicationOptions {
  target: AppTarget;
  projectRoot: string;
  dataRoot: string;
  port: number;
  lineApiBaseUrl: string;
  basePath?: string;
  publicUrl?: string;
}

export async function startApplication(options: StartApplicationOptions): Promise<RunningApp> {
  const basePath = options.basePath ?? '/';
  const publicUrl = options.publicUrl ?? `http://127.0.0.1:${options.port}`;
  const entry = options.target === 'composed'
    ? path.join(options.projectRoot, 'packages/server/dist/cli.js')
    : path.join(options.projectRoot, 'packages/line-mcp/dist/cli.js');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TEST_TOKEN;
  delete env.LINE_AUTH_DATA;
  env.PORT = String(options.port);
  env.DATA_DIR = options.dataRoot;
  env.BASE_PATH = basePath;
  env.PUBLIC_URL = publicUrl;
  env.LINE_API_BASE_URL = options.lineApiBaseUrl;

  const child = await spawnManagedNode({
    label: `app-${options.target}`,
    cwd: options.projectRoot,
    args: [entry],
    env,
  });

  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const origin = `http://127.0.0.1:${options.port}`;
  const healthz = `${origin}${normalizedBase}/healthz`;

  let earlyExitRejection: Error | null = null;
  const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    earlyExitRejection = buildReadyError(
      `app-${options.target}`,
      `application exited before /healthz responded (code=${code} signal=${signal ?? 'null'})`,
      child.stdout, child.stderr, env,
    );
  };
  child.child.once('exit', onEarlyExit);

  try {
    let lastHttpErr: unknown = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (earlyExitRejection) throw earlyExitRejection;
      try {
        const res = await fetch(healthz, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (body != null && typeof body === 'object' && (body as { status?: string }).status === 'ok') {
            break;
          }
        }
      } catch (err) {
        if (earlyExitRejection) throw earlyExitRejection;
        lastHttpErr = err;
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (earlyExitRejection) throw earlyExitRejection;
    if (Date.now() >= deadline) {
      throw new Error(`application /healthz timeout after 15000ms (last error: ${lastHttpErr ?? 'none'})`);
    }
  } catch (err) {
    child.child.removeListener('exit', onEarlyExit);
    try { await child.terminate({ gracefulMs: 1_000 }); } catch { /* */ }
    throw err;
  }
  child.child.removeListener('exit', onEarlyExit);

  registerCleanup(async () => { try { await child.terminate(); } catch { /**/ } });

  const mcpUrl = `${origin}${normalizedBase}/mcp`;

  async function stop(): Promise<void> {
    await child.terminate({ gracefulMs: 5_000 });
  }

  return {
    process: child,
    origin,
    mcpUrl,
    dataRoot: options.dataRoot,
    port: options.port,
    stop,
  };
}

export interface McpConnection {
  readonly client: Client;
  close(): Promise<void>;
}

export async function connectMcp(url: string, bearer: string): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'smoke-harness', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    // Half-opened transport/client must not leak if connect() rejects.
    try { await transport.close(); } catch { /**/ }
    try { await client.close(); } catch { /**/ }
    throw err;
  }
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try { await client.close(); } catch { /**/ }
    try { await transport.close(); } catch { /**/ }
  }
  registerCleanup(close);
  return { client, close };
}

export function createTemporaryDataRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerCleanup(async () => {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /**/ }
  });
  return dir;
}