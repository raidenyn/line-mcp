import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client';
import { createTokenCodec } from '@raidenyn/mcp-runtime';
import { persistAuthData } from '@raidenyn/line-mcp';
import {
  MOCK_ACCOUNT_MID,
  MOCK_GROUP_MID,
  MOCK_DIRECT_MID,
  MOCK_PIN,
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

export { extractText };

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

  // Drive getMessagesInRange through a real MCP bank tool with a `since`
  // parameter so the production client path (cache wrapper -> LineClient
  // .getMessagesInRange -> getPreviousMessagesV2WithRequest) is exercised
  // end-to-end, not only by hand-crafted contract requests. The `since`
  // date predates the fixture history so getMessagesInRange is the code
  // path selected by fetch-transactions.ts.
  const getTransactionsSince = await client.callTool({
    name: 'get_transactions',
    arguments: { chatMid: MOCK_GROUP_MID, since: '2026-01-01' },
  });
  const parsedSinceTransactions = extractJson<unknown[]>(extractText(getTransactionsSince));
  expect(parsedSinceTransactions).toEqual(fixtures.expected.transactions);

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

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
}

const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:8765/callback';

/**
 * Validate that every advertised OAuth endpoint shares the expected local
 * app origin (or the loopback alias with the same port), then rebind it to
 * {@link appOrigin} while preserving the advertised path. A metadata
 * regression advertising a foreign origin (e.g.
 * https://attacker.example/register) would otherwise make the supposedly
 * local deterministic smoke suite perform external network I/O.
 */
export function validateAndRebindEndpoints(
  metadata: { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string },
  appOrigin: string,
): { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string } {
  const expectedOrigin = appOrigin.replace(/\/$/, '');
  const portMatch = expectedOrigin.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)$/);
  if (!portMatch) {
    throw new Error(
      `validateAndRebindEndpoints expects a loopback appOrigin (http://localhost:<port> or http://127.0.0.1:<port>), got: ${expectedOrigin}`,
    );
  }
  const port = portMatch[1];
  const allowedOrigin = new RegExp(
    `^https?://(?:localhost|127\\.0\\.0\\.1):${port}$`,
  );
  const fields: Array<keyof typeof metadata> = [
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
  ];
  const result: Record<string, string> = {};
  for (const field of fields) {
    const advertised = metadata[field];
    const match = advertised.match(/^https?:\/\/[^/]+(?=\/|$)/);
    if (!match) {
      throw new Error(
        `OAuth metadata field ${field} has an unparseable origin: ${advertised}`,
      );
    }
    const advertisedOrigin = match[0];
    if (!allowedOrigin.test(advertisedOrigin)) {
      throw new Error(
        `OAuth metadata field ${field} advertised origin ${advertisedOrigin} does not match expected local origin (localhost or 127.0.0.1 on port ${port})`,
      );
    }
    const path = advertised.slice(advertisedOrigin.length);
    if (!path.startsWith('/')) {
      throw new Error(
        `OAuth metadata field ${field} has no path component: ${advertised}`,
      );
    }
    result[field] = `${expectedOrigin}${path}`;
  }
  return {
    authorizationEndpoint: result.authorization_endpoint!,
    tokenEndpoint: result.token_endpoint!,
    registrationEndpoint: result.registration_endpoint!,
  };
}

export async function authorizeWithPkce(
  appOrigin: string,
  options: { expectPin: boolean },
): Promise<OAuthTokens> {
  // Step 1: Fetch the OAuth authorization-server and protected-resource metadata.
  const asMetaRes = await fetch(`${appOrigin}/.well-known/oauth-authorization-server`);
  expect(asMetaRes.status).toBe(200);
  const asMeta = await asMetaRes.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  // The server advertises its canonical issuer (e.g. http://localhost:PORT); the
  // harness drives 127.0.0.1, so assert the advertised endpoints share the
  // expected local origin (rejecting any foreign origin) and rebind each URL
  // to appOrigin while preserving the advertised path suffixes.
  expect(asMeta.authorization_endpoint.endsWith('/authorize')).toBe(true);
  expect(asMeta.token_endpoint.endsWith('/token')).toBe(true);
  expect(asMeta.registration_endpoint.endsWith('/register')).toBe(true);
  const rebinding = validateAndRebindEndpoints(asMeta, appOrigin);

  const prMetaRes = await fetch(`${appOrigin}/.well-known/oauth-protected-resource/mcp`);
  expect(prMetaRes.status).toBe(200);
  const prMeta = await prMetaRes.json() as { resource: string; authorization_servers: string[] };
  expect(prMeta.resource.endsWith('/mcp')).toBe(true);
  expect(prMeta.authorization_servers.length).toBeGreaterThan(0);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = LOOPBACK_REDIRECT_URI;
  const registration = await fetch(rebinding.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'mock-line-smoke',
      scope: 'line',
    }),
  });
  expect(registration.status).toBe(201);
  const regBody = await registration.json() as { client_id: string };
  const clientId = regBody.client_id;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'smoke-state',
  });
  // validateAndRebindEndpoints already rebound the authorization endpoint to
  // appOrigin while honoring the advertised path; fetch it directly.
  const page = await (await fetch(`${rebinding.authorizationEndpoint}?${params}`)).text();
  const contextMatch = page.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/);
  if (!contextMatch) throw new Error('OAuth page did not include oauth-context');
  const contextJson = JSON.parse(contextMatch[1]) as { sid: string };
  const sid = contextJson.sid;

  let observedPin: string | undefined;
  let code: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pollRes = await fetch(`${appOrigin}/authorize/poll?sid=${encodeURIComponent(sid)}`);
    const poll = await pollRes.json() as {
      phase: string;
      pin?: string;
      code?: string;
      error?: string;
    };
    if (poll.phase === 'pin_needed') observedPin = poll.pin;
    if (poll.phase === 'failed') throw new Error(`OAuth login failed: ${poll.error}`);
    if (poll.phase === 'complete') {
      code = poll.code;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(observedPin).toBe(options.expectPin ? MOCK_PIN : undefined);
  if (!code) throw new Error('OAuth login did not complete');

  const tokenRes = await fetch(rebinding.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tokenBody = await tokenRes.json() as { access_token: string; refresh_token: string };
  return { accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token };
}

export async function refreshMcpToken(
  appOrigin: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const res = await fetch(`${appOrigin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

function readDataRootSecret(dataRoot: string): string {
  const secretFile = path.join(dataRoot, 'secret');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  if (!secret) throw new Error(`data-root secret missing at ${secretFile}`);
  return secret;
}

function mintExpiredAccessToken(dataRoot: string, port: number): string {
  const secret = readDataRootSecret(dataRoot);
  const issuer = `http://localhost:${port}`;
  const audience = `http://localhost:${port}/mcp`;
  const codec = createTokenCodec({
    secret,
    issuer,
    audience,
    now: () => 0,
  });
  // Issued at epoch 0 with TTL of 1 second → expired well before the test's now().
  return codec.issueAccessToken({
    subject: MOCK_ACCOUNT_MID,
    scopes: ['line'],
    ttlSeconds: 1,
  });
}

export async function assertMcpUnauthorized(
  appOrigin: string,
  dataRoot: string,
  port: number,
): Promise<void> {
  const mcpUrl = `${appOrigin}/mcp`;
  const expectedWww = `Bearer error="invalid_token", resource_metadata="http://localhost:${port}/.well-known/oauth-protected-resource/mcp"`;
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-unauthorized', version: '0.0.0' },
    },
  };

  const cases: Array<{ label: string; headers: Record<string, string> }> = [
    { label: 'no bearer', headers: {} },
    { label: 'garbage bearer', headers: { authorization: 'Bearer not-a-real-token' } },
    {
      label: 'expired MCP token',
      headers: { authorization: `Bearer ${mintExpiredAccessToken(dataRoot, port)}` },
    },
  ];

  for (const { headers } of cases) {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(initBody),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('invalid_token');
    expect(res.headers.get('www-authenticate')).toBe(expectedWww);
  }
}

