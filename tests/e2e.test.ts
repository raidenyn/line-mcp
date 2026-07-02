import { beforeAll, afterAll, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 13117; // Fixed port for tests to avoid collisions
const MCP_URL = new URL(`http://localhost:${PORT}/mcp`);

let mcpClient: Client;
let transport: StreamableHTTPClientTransport;
let serverProcess: ChildProcess;
let authJson: string;
let testToken: string;
let firstChatMid: string;
let imagePreviewUrl: string | null = null;

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function extractText(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/.well-known/oauth-authorization-server`, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Server did not become ready in time');
}

beforeAll(async () => {
  authJson = fs.readFileSync(path.join(PROJECT_ROOT, '.line-auth.json'), 'utf8');
  testToken = crypto.randomBytes(32).toString('hex');

  serverProcess = spawn(
    'npx',
    ['ts-node', path.join(PROJECT_ROOT, 'src', 'index.ts')],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        LINE_AUTH_DATA: authJson,
        TEST_TOKEN: testToken,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true, // spawn as process group leader so we can kill the whole group
    },
  );

  serverProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  await waitForServer(`http://localhost:${PORT}`, 30_000);

  transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${testToken}` } },
  });
  mcpClient = new Client({ name: 'e2e-test', version: '1.0.0' });
  await mcpClient.connect(transport);
}, 60_000);

afterAll(async () => {
  await transport?.close().catch(() => {});
  try {
    // Kill the whole process group (npx → ts-node → node) so nothing lingers on the port
    process.kill(-serverProcess.pid!, 'SIGTERM');
  } catch {
    serverProcess.kill();
  }
});

it('list_chats returns at least one chat with a mid', async () => {
  const result = await mcpClient.callTool({ name: 'list_chats', arguments: {} });
  expect(result.isError).toBeFalsy();
  const text = extractText(result);
  expect(text).toMatch(/\[(?:GROUP|USER)\]/);
  const mids = [...text.matchAll(/^\s+mid:\s+(\S+)/gm)].map((m) => m[1]);
  expect(mids.length).toBeGreaterThan(0);
  firstChatMid = mids[0];
  (globalThis as Record<string, unknown>).__allChatMids = mids;
});

it('get_messages returns messages for a valid chatMid', async () => {
  const allMids: string[] = ((globalThis as Record<string, unknown>).__allChatMids as string[]) ?? [firstChatMid];
  let messagesText: string | null = null;
  for (const mid of allMids) {
    const result = await mcpClient.callTool({
      name: 'get_messages',
      arguments: { chatMid: mid, count: 20 },
    });
    if (result.isError) continue;
    const text = extractText(result);
    if (text === 'No messages found.') continue;
    messagesText = text;
    firstChatMid = mid;
    break;
  }
  if (!messagesText) {
    console.warn('No chat with messages found — skipping timestamp assertion');
    return;
  }
  expect(messagesText).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const previewMatch = messagesText.match(/\(preview:\s+(https?:\/\/\S+)\)/);
  if (previewMatch) imagePreviewUrl = previewMatch[1];
});

it('get_messages rejects count > 200', async () => {
  expect(firstChatMid).toBeTruthy();
  const result = await mcpClient.callTool({
    name: 'get_messages',
    arguments: { chatMid: firstChatMid, count: 999 },
  });
  expect(result.isError).toBe(true);
});

it('get_image returns a base64 image when a previewUrl is available', async ({ skip }) => {
  if (!imagePreviewUrl) {
    skip();
  }
  const result = await mcpClient.callTool({
    name: 'get_image',
    arguments: { url: imagePreviewUrl },
  });
  expect(result.isError).toBeFalsy();
  const item = result.content[0];
  expect(item.type).toBe('image');
  if (item.type === 'image') {
    expect(item.mimeType).toMatch(/^image\//);
    expect(Buffer.from(item.data, 'base64').length).toBeGreaterThan(0);
  }
});

it('get_image returns isError for a bad URL', async () => {
  const result = await mcpClient.callTool({
    name: 'get_image',
    arguments: { url: 'https://invalid.example.test/no-such.jpg' },
  });
  expect(result.isError).toBe(true);
  expect(extractText(result)).toMatch(/Failed to fetch image/);
});

it('summarize_transactions accepts chatMid directly', async () => {
  expect(firstChatMid).toBeTruthy();
  const result = await mcpClient.callTool({
    name: 'summarize_transactions',
    arguments: { chatMid: firstChatMid, group_by: 'month' },
  });
  // Either a valid summary or "no saved templates" — both prove the new interface is wired
  const text = extractText(result);
  const isValidSummary = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
  const isNoTemplatesError = text.includes('No templates') || text.includes('no saved templates');
  expect(isValidSummary || isNoTemplatesError).toBe(true);
});

it('resources/list returns all 10 guide URIs', async () => {
  const result = await mcpClient.listResources();
  const uris = result.resources.map((r) => r.uri);
  const expected = [
    'line://guide',
    'line://guide/tools/list_chats',
    'line://guide/tools/get_messages',
    'line://guide/tools/get_image',
    'line://guide/tools/sample_messages',
    'line://guide/tools/manage_templates',
    'line://guide/tools/get_transactions',
    'line://guide/tools/summarize_transactions',
    'line://guide/tools/initiate_import',
    'line://guide/tools/complete_import',
  ];
  for (const uri of expected) {
    expect(uris).toContain(uri);
  }
});

it('resources/read returns non-empty markdown for line://guide', async () => {
  const result = await mcpClient.readResource({ uri: 'line://guide' });
  expect(result.contents).toHaveLength(1);
  const item = result.contents[0];
  expect(item.mimeType).toBe('text/markdown');
  expect('text' in item).toBe(true);
  if ('text' in item) {
    expect(item.text.length).toBeGreaterThan(0);
  }
});
