import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import { registerLineTools, type LineToolDeps } from './tools';
import { registerLineResources } from './resources';
import { ImportService } from './import-service';
import type { LinePrincipal } from './auth/line-auth-provider';
import { createStandaloneServer } from './standalone';

function fakeDeps(): LineToolDeps {
  const cache = {
    upsertMessages: vi.fn(),
    getMessages: vi.fn(() => []),
    latestTimestamp: vi.fn(() => null),
    getDistinctChatMids: vi.fn(() => []),
  };
  return {
    createRequestClient: vi.fn(),
    importService: new ImportService({ basePath: '', cache, createRequestClient: vi.fn() }),
  };
}

function fakeContext(): RequestContext<LinePrincipal> {
  return {
    principal: { provider: 'line', subject: 'u1', mid: 'u1', scopes: [] },
    // Only property access is exercised by the tools under test here.
    request: {} as RequestContext<LinePrincipal>['request'],
  };
}

function registeredToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

function registeredResourceUris(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources).sort();
}

describe('registerLineTools — standalone registration', () => {
  it('registers exactly the five messenger tools', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerLineTools(server, fakeContext(), fakeDeps());
    expect(registeredToolNames(server)).toEqual(
      ['complete_import', 'get_image', 'get_messages', 'initiate_import', 'list_chats'].sort(),
    );
  });
});

describe('registerLineResources — standalone registration', () => {
  it('registers exactly six resources (overview + five tool guides) by default', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerLineResources(server);
    expect(registeredResourceUris(server)).toHaveLength(6);
    expect(registeredResourceUris(server)).toContain('line://guide');
  });

  it('omits the overview URI when includeOverview is false, leaving exactly five resources', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerLineResources(server, { includeOverview: false });
    const uris = registeredResourceUris(server);
    expect(uris).toHaveLength(5);
    expect(uris).not.toContain('line://guide');
  });
});

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(PACKAGE_ROOT, 'dist', 'index.js');
const DIST_CLI = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

describe('@raidenyn/line-mcp package import — no side effects', () => {
  it('requiring the compiled package root creates no files, opens no listeners, and exits promptly', () => {
    if (!fs.existsSync(DIST_INDEX)) {
      throw new Error(`${DIST_INDEX} does not exist — run \`npm run build\` before this test`);
    }
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-import-check-'));
    try {
      const before = fs.readdirSync(tmpCwd);
      // A bare `require` of the package root. If importing it opened a
      // listener, started a timer, or touched the filesystem, this process
      // would either hang (caught by the timeout below) or leave files behind.
      execFileSync(process.execPath, ['-e', `require(${JSON.stringify(DIST_INDEX)});`], {
        cwd: tmpCwd,
        timeout: 5_000,
        env: { ...process.env, DATA_DIR: undefined },
      });
      const after = fs.readdirSync(tmpCwd);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('compiled CLI — start and stop', () => {
  let child: ReturnType<typeof spawn> | undefined;
  let tmpDataDir: string | undefined;

  afterEach(() => {
    if (child && !child.killed) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (tmpDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('starts listening on an ephemeral port and shuts down cleanly on SIGTERM', async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`${DIST_CLI} does not exist — run \`npm run build\` before this test`);
    }
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-cli-'));

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI did not report listening in time')), 10_000);
      child = spawn(process.execPath, [DIST_CLI], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, DATA_DIR: tmpDataDir, PORT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (/listening on port/.test(chunk.toString())) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) reject(new Error(`CLI exited early with code ${code}`));
      });
    });

    await ready;

    const exited = new Promise<number | null>((resolve) => {
      child!.on('exit', (code) => resolve(code));
    });
    process.kill(-child!.pid!, 'SIGTERM');
    const code = await exited;
    expect(code === 0 || code === null).toBe(true);
  }, 20_000);
});

describe('createStandaloneServer — in-process start/stop', () => {
  it('starts on an ephemeral port and stops cleanly, deriving data paths from the explicit dataRoot rather than process.cwd()', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-standalone-'));
    // A decoy cwd: if the factory ever fell back to process.cwd() for
    // persistent data, its files would land here instead of under dataRoot.
    const decoyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-decoy-cwd-'));
    const originalCwd = process.cwd();
    process.chdir(decoyCwd);
    try {
      const server = createStandaloneServer({ dataRoot: tmpDataDir, port: 0 });
      const { port } = await server.start();
      expect(port).toBeGreaterThan(0);

      // /healthz answers { status: 'ok', version } — the same liveness contract
      // the composed server exposes, and what the Docker HEALTHCHECK probes.
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: '1.0.0' });

      await server.stop();

      expect(fs.existsSync(path.join(tmpDataDir, 'secret'))).toBe(true);
      expect(fs.existsSync(path.join(decoyCwd, 'secret'))).toBe(false);
      expect(fs.existsSync(path.join(decoyCwd, 'data'))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
      fs.rmSync(decoyCwd, { recursive: true, force: true });
    }
  });

  it('refuses to start against a legacy-only database (no persistence-current.json pointer)', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-legacy-'));
    try {
      fs.mkdirSync(path.join(tmpDataDir, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(tmpDataDir, 'cache', 'messages.db'), '');
      const server = createStandaloneServer({ dataRoot: tmpDataDir, port: 0 });
      await expect(server.start()).rejects.toThrow(/legacy combined database/);
    } finally {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  it('restarts cleanly against its own previously-persisted dataRoot (no false legacy-database refusal)', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-restart-'));
    try {
      // First run against a completely fresh dataRoot: no pointer, no
      // cache/messages.db — this is the "first ever start" case.
      const first = createStandaloneServer({ dataRoot: tmpDataDir, port: 0 });
      await first.start();
      await first.stop();

      // The standalone server must have created its own dedicated DB file,
      // and must NOT have created (or touched) the legacy monolith path.
      const ownDbPath = path.join(tmpDataDir, 'line-mcp', 'messages.db');
      const legacyDbPath = path.join(tmpDataDir, 'cache', 'messages.db');
      expect(fs.existsSync(ownDbPath)).toBe(true);
      expect(fs.existsSync(legacyDbPath)).toBe(false);

      // Second run against the SAME dataRoot simulates a process restart.
      // Before the fix, this incorrectly threw "legacy combined database"
      // because the standalone server's own first run had left a file at
      // cache/messages.db with no persistence-current.json pointer.
      const second = createStandaloneServer({ dataRoot: tmpDataDir, port: 0 });
      await expect(second.start()).resolves.toMatchObject({ port: expect.any(Number) });
      await second.stop();

      // Same dedicated DB file is reused across the restart, not replaced.
      expect(fs.existsSync(ownDbPath)).toBe(true);
      expect(fs.existsSync(legacyDbPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
