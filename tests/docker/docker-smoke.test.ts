import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { createTokenCodec } from '@raidenyn/mcp-runtime';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Docker target smoke gate (issue #75, Task 12).
 *
 * Builds (if not already tagged) and runs each runtime Docker target against a
 * throwaway data root on an ephemeral host port, waits for `/healthz`, and then
 * proves — over a REAL MCP `tools/list` roundtrip, not a byte grep — that the
 * composed `server` target exposes all ten tool registrations and the
 * standalone `line-mcp` target exposes only the five messenger registrations.
 *
 * This is the exact same tool surface asserted in-process by
 * `packages/server/src/composition.test.ts`; here it is asserted against the
 * actually-shipped container image, which additionally proves better-sqlite3's
 * native addon loads inside the runtime base image (a broken base image fails
 * at container start, before `/healthz` ever answers).
 *
 * Excluded from `npm run test:unit`; run explicitly (the CI `docker` job and
 * the Task 12 local exit criteria both invoke this file by path).
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_IMAGE = process.env.SMOKE_SERVER_IMAGE ?? 'line-mcp-server:test';
const STANDALONE_IMAGE = process.env.SMOKE_STANDALONE_IMAGE ?? 'line-mcp-standalone:test';

// Internal container config is fixed (PORT=3000, BASE_PATH=/ → normalized ''),
// so the token issuer/audience the server validates against are constant and
// independent of whichever ephemeral host port Docker assigns.
const SECRET = 'docker-smoke-secret';
const ISSUER = 'http://localhost:3000';
const AUDIENCE = 'http://localhost:3000/mcp';

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0;
}

function imageExists(tag: string): boolean {
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0;
}

function buildIfMissing(target: string, tag: string): void {
  if (imageExists(tag)) return;
  execFileSync('docker', ['build', '--target', target, '-t', tag, '.'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function mintToken(): string {
  const codec = createTokenCodec({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE });
  return codec.issueAccessToken({ subject: 'u-docker-smoke', scopes: ['line'], ttlSeconds: 3600 });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunningContainer {
  id: string;
  hostPort: string;
  dataDir: string;
}

function startContainer(tag: string): RunningContainer {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-smoke-data-'));
  // Pre-seed the signing secret so the minted bearer verifies against a key we
  // control, rather than the random one the server would otherwise generate.
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, 'utf8');

  const id = execFileSync(
    'docker',
    [
      'run', '-d',
      // Run as the invoking host user so the bind-mounted data root (owned by
      // that user) is writable — the composed target migrates + opens SQLite
      // under it at startup.
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '-e', 'PORT=3000',
      '-e', 'BASE_PATH=/',
      '-e', 'DATA_DIR=/data',
      '-v', `${dataDir}:/data`,
      '-p', '127.0.0.1::3000',
      tag,
    ],
    { encoding: 'utf8' },
  ).trim();

  const portLine = execFileSync('docker', ['port', id, '3000'], { encoding: 'utf8' }).trim().split('\n')[0];
  const hostPort = portLine.slice(portLine.lastIndexOf(':') + 1);
  return { id, hostPort, dataDir };
}

function stopContainer(c: RunningContainer): void {
  try {
    const logs = spawnSync('docker', ['logs', c.id], { encoding: 'utf8' });
    void logs;
    execFileSync('docker', ['rm', '-f', c.id], { stdio: 'ignore' });
  } finally {
    fs.rmSync(c.dataDir, { recursive: true, force: true });
  }
}

async function waitForHealthz(hostPort: string, id: string): Promise<void> {
  const url = `http://127.0.0.1:${hostPort}/healthz`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  const logs = spawnSync('docker', ['logs', id], { encoding: 'utf8' });
  throw new Error(`healthz never became ready for container ${id}. Logs:\n${logs.stdout}\n${logs.stderr}`);
}

async function listTools(hostPort: string): Promise<string[]> {
  const token = mintToken();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hostPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'docker-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    return result.tools.map((t) => t.name).sort();
  } finally {
    await transport.close().catch(() => {});
  }
}

const MESSENGER_TOOLS = [
  'list_chats', 'get_messages', 'get_image', 'initiate_import', 'complete_import',
].sort();

const COMPOSED_TOOLS = [
  ...MESSENGER_TOOLS,
  'manage_templates', 'manage_categories', 'sample_messages', 'get_transactions', 'summarize_transactions',
].sort();

describe.skipIf(!dockerAvailable())('Docker runtime targets — real MCP tools/list smoke', () => {
  beforeAll(() => {
    buildIfMissing('server', SERVER_IMAGE);
    buildIfMissing('line-mcp', STANDALONE_IMAGE);
  }, 900_000);

  it('composed `server` target exposes exactly the ten composed tools', async () => {
    const c = startContainer(SERVER_IMAGE);
    try {
      await waitForHealthz(c.hostPort, c.id);
      const tools = await listTools(c.hostPort);
      expect(tools).toEqual(COMPOSED_TOOLS);
    } finally {
      stopContainer(c);
    }
  }, 120_000);

  it('standalone `line-mcp` target exposes only the five messenger tools', async () => {
    const c = startContainer(STANDALONE_IMAGE);
    try {
      await waitForHealthz(c.hostPort, c.id);
      const tools = await listTools(c.hostPort);
      expect(tools).toEqual(MESSENGER_TOOLS);
    } finally {
      stopContainer(c);
    }
  }, 120_000);

  it('standalone `line-mcp` image contains no bank-mcp or server package directory', () => {
    const out = execFileSync(
      'docker',
      ['run', '--rm', '--entrypoint', 'sh', STANDALONE_IMAGE, '-c', 'ls packages'],
      { encoding: 'utf8' },
    );
    const dirs = out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    expect(dirs).toEqual(['line-client', 'line-client-sqlite', 'line-mcp', 'mcp-runtime']);
  }, 60_000);
});
