import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client';
import { createTokenCodec } from '@raidenyn/mcp-runtime';
import { persistAuthData } from '@raidenyn/line-mcp';
import {
  MOCK_ACCOUNT_MID,
  MOCK_GROUP_MID,
  MOCK_DIRECT_MID,
  JPEG_BYTES,
  EXPORT_FILE_TEXT,
  type MockFixtures,
} from './mock-line-server/fixtures';

const MESSENGER_TOOLS = ['complete_import', 'get_image', 'get_messages', 'initiate_import', 'list_chats'];
const BANK_TOOLS = ['get_transactions', 'manage_categories', 'manage_templates', 'sample_messages', 'summarize_transactions'];
const MESSENGER_RESOURCES = MESSENGER_TOOLS.map((name) => `line://guide/tools/${name}`).concat('line://guide');
const COMPOSED_RESOURCES = MESSENGER_RESOURCES.concat(BANK_TOOLS.map((name) => `line://guide/tools/${name}`));

export type AppTarget = 'composed' | 'standalone';

export function prepareSeededDataRoot(input: {
  dataRoot: string;
  appPort: number;
  fixtures: MockFixtures;
}): string {
  const secret = 'mock-mcp-signing-secret';
  fs.mkdirSync(input.dataRoot, { recursive: true });
  fs.writeFileSync(path.join(input.dataRoot, 'secret'), secret, 'utf8');
  persistAuthData(input.fixtures.seededAuth, 'Mock LINE Account', path.join(input.dataRoot, 'auth'));
  return createTokenCodec({
    secret,
    issuer: `http://localhost:${input.appPort}`,
    audience: `http://localhost:${input.appPort}/mcp`,
  }).issueAccessToken({ subject: MOCK_ACCOUNT_MID, scopes: ['line'], ttlSeconds: 3600 });
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  return item?.text ?? '';
}

function extractJson<T>(text: string): T {
  const first = text.trimStart();
  const open = first[0];
  const close = open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return JSON.parse(first) as T;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < first.length; i++) {
    const ch = first[i];
    if (inStr) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inStr = false; }
    } else if (ch === '"') { inStr = true; }
    else if (ch === open) { depth++; }
    else if (ch === close) { depth--; if (depth === 0) return JSON.parse(first.slice(0, i + 1)) as T; }
  }
  return JSON.parse(first) as T;
}

function extractImage(result: { content: Array<{ type: string; data?: string; mimeType?: string }> }): { data: string; mimeType: string } {
  const item = result.content.find((c) => c.type === 'image' && typeof c.data === 'string');
  return { data: item?.data ?? '', mimeType: item?.mimeType ?? '' };
}

export async function assertTargetSurface(client: Client, target: AppTarget): Promise<void> {
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name).sort();
  const expectedTools = (target === 'composed' ? MESSENGER_TOOLS.concat(BANK_TOOLS) : MESSENGER_TOOLS).slice().sort();
  expect(toolNames).toEqual(expectedTools);

  const resourcesResult = await client.listResources();
  const uris = resourcesResult.resources.map((r) => r.uri).sort();
  const expectedUris = (target === 'composed' ? COMPOSED_RESOURCES : MESSENGER_RESOURCES).slice().sort();
  expect(uris).toEqual(expectedUris);

  for (const uri of expectedUris) {
    const read = await client.readResource({ uri });
    const item = read.contents[0];
    expect(item.mimeType).toBe('text/markdown');
    expect('text' in item).toBe(true);
    if ('text' in item) {
      expect(item.text.length).toBeGreaterThan(0);
      expect(item.text.startsWith('Guide file not found:')).toBe(false);
    }
  }
}

export async function runMessengerAssertions(
  client: Client,
  fixtures: MockFixtures,
  appOrigin: string,
): Promise<void> {
  const listChats = await client.callTool({ name: 'list_chats', arguments: {} });
  expect(extractText(listChats)).toBe(fixtures.expected.listChatsText);

  const getMessagesOnce = await client.callTool({ name: 'get_messages', arguments: { chatMid: MOCK_GROUP_MID, count: 5 } });
  expect(extractText(getMessagesOnce)).toBe(fixtures.expected.recentMessagesText);
  const getMessagesAgain = await client.callTool({ name: 'get_messages', arguments: { chatMid: MOCK_GROUP_MID, count: 5 } });
  expect(extractText(getMessagesAgain)).toBe(fixtures.expected.recentMessagesText);

  const getImage = await client.callTool({ name: 'get_image', arguments: { url: fixtures.image.previewUrl } });
  const image = extractImage(getImage);
  expect(image.mimeType).toBe('image/jpeg');
  expect(Buffer.from(image.data, 'base64')).toEqual(JPEG_BYTES);

  const initiate = await client.callTool({ name: 'initiate_import', arguments: {} });
  const initiateText = extractText(initiate);
  const uploadUrl = (JSON.parse(initiateText).upload_url as string).replace(/^http:\/\/127\.0\.0\.1:\d+/, appOrigin);
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: EXPORT_FILE_TEXT,
  });
  expect(uploadResponse.status).toBe(200);
  const uploadBody = await uploadResponse.json() as { file_ref_id: string };
  const complete = await client.callTool({
    name: 'complete_import',
    arguments: { file_ref_id: uploadBody.file_ref_id, timezone: 'UTC' },
  });
  expect(JSON.parse(extractText(complete))).toEqual(fixtures.expected.importResult);
}

export async function runComposedBankAssertions(client: Client, fixtures: MockFixtures): Promise<void> {
  const template = {
    name: 'mock-signed-transaction',
    pattern: 'MOCK TX (?<original_amount>[+-][\\d,.]+) (?<original_currency>[A-Z]+) at (?<merchant>[^|]+) \\| (?<date>\\S+) \\| acct (?<account>\\S+) \\| bal (?<balance>[\\d,.]+)',
  };

  const sample = await client.callTool({ name: 'sample_messages', arguments: { chatMid: MOCK_GROUP_MID, count: 50 } });
  const sampleText = extractText(sample);
  expect(sampleText).toContain('MOCK TX -125.50 THB at Mock Cafe');
  expect(sampleText).toContain('MOCK TX +500.00 THB at Mock Employer');

  const upsert = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_GROUP_MID, action: 'upsert', template } });
  expect(extractText(upsert)).toBe(`Template '${template.name}' saved for chat ${MOCK_GROUP_MID}.`);

  const listTemplates = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_GROUP_MID, action: 'list' } });
  const listed = extractJson<Array<{ name: string }>>(extractText(listTemplates));
  expect(listed.some((t) => t.name === template.name)).toBe(true);

  const listPresets = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_DIRECT_MID, action: 'list_presets' } });
  const presets = extractJson<Array<{ name: string }>>(extractText(listPresets));
  const presetNames = presets.map((p) => p.name);
  expect(presetNames).toContain('cardx');
  expect(presetNames).toContain('scb');

  const applyPreset = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_DIRECT_MID, action: 'apply_preset', preset_name: 'cardx' } });
  expect(extractText(applyPreset)).toContain(`Applied preset 'cardx'`);

  const listDirect = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_DIRECT_MID, action: 'list' } });
  const directTemplates = extractJson<Array<{ name: string }>>(extractText(listDirect));
  expect(directTemplates.some((t) => t.name === 'cardx-debit')).toBe(true);

  const deleteCardx = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_DIRECT_MID, action: 'delete', name: 'cardx-debit' } });
  expect(extractText(deleteCardx)).toBe(`Template 'cardx-debit' deleted from chat ${MOCK_DIRECT_MID}.`);

  const catUpsert = await client.callTool({
    name: 'manage_categories',
    arguments: { action: 'upsert', category: { name: 'Smoke Banking', pattern: 'Mock Cafe|Mock Employer' } },
  });
  expect(extractText(catUpsert)).toBe(`Category 'Smoke Banking' saved.`);

  const getTransactions = await client.callTool({ name: 'get_transactions', arguments: { chatMid: MOCK_GROUP_MID } });
  const parsedTransactions = extractJson<unknown[]>(extractText(getTransactions));
  expect(parsedTransactions).toEqual(fixtures.expected.transactions);

  const getFiltered = await client.callTool({
    name: 'get_transactions',
    arguments: { chatMid: MOCK_GROUP_MID, merchants: ['Mock Cafe'] },
  });
  const parsedFiltered = extractJson<unknown[]>(extractText(getFiltered));
  expect(parsedFiltered).toEqual(fixtures.expected.filteredDebit);

  const summarizeMonth = await client.callTool({ name: 'summarize_transactions', arguments: { chatMid: MOCK_GROUP_MID, group_by: 'month' } });
  const parsedMonth = extractJson<Record<string, unknown>>(extractText(summarizeMonth));
  expect(parsedMonth).toEqual(fixtures.expected.summaryByMonth);

  const summarizeCategory = await client.callTool({ name: 'summarize_transactions', arguments: { chatMid: MOCK_GROUP_MID, group_by: 'category' } });
  const parsedCategory = extractJson<Record<string, unknown>>(extractText(summarizeCategory));
  expect(parsedCategory).toEqual(fixtures.expected.summaryByCategory);

  const catDelete = await client.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'Smoke Banking' } });
  expect(extractText(catDelete)).toBe(`Category 'Smoke Banking' deleted.`);

  const tmplDelete = await client.callTool({ name: 'manage_templates', arguments: { chatMid: MOCK_GROUP_MID, action: 'delete', name: template.name } });
  expect(extractText(tmplDelete)).toBe(`Template '${template.name}' deleted from chat ${MOCK_GROUP_MID}.`);
}