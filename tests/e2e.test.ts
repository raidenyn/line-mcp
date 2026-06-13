import { beforeAll, afterAll, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..');

let mcpClient: Client;
let transport: StdioClientTransport;
let authJson: string;
let firstChatMid: string;
let imagePreviewUrl: string | null = null;

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function extractText(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}

beforeAll(async () => {
  authJson = fs.readFileSync(path.join(PROJECT_ROOT, '.line-auth.json'), 'utf8');
  transport = new StdioClientTransport({
    command: 'npx',
    args: ['ts-node', path.join(PROJECT_ROOT, 'src', 'index.ts')],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'e2e-test', version: '1.0.0' });
  await mcpClient.connect(transport);
});

afterAll(async () => {
  await transport.close();
});

it('list_chats returns at least one chat with a mid', async () => {
  const result = await mcpClient.callTool({ name: 'list_chats', arguments: { auth: authJson } });
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
      arguments: { chatMid: mid, count: 20, auth: authJson },
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
    arguments: { chatMid: firstChatMid, count: 999, auth: authJson },
  });
  expect(result.isError).toBe(true);
});

it('get_image returns a base64 image when a previewUrl is available', async ({ skip }) => {
  if (!imagePreviewUrl) {
    skip();
  }
  const result = await mcpClient.callTool({
    name: 'get_image',
    arguments: { url: imagePreviewUrl, auth: authJson },
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
    arguments: { url: 'https://invalid.example.test/no-such.jpg', auth: authJson },
  });
  expect(result.isError).toBe(true);
  expect(extractText(result)).toMatch(/Failed to fetch image/);
});
