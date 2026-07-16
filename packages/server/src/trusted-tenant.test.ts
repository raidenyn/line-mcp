import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import { createMcpHost } from '@raidenyn/mcp-runtime';
import { LineAuthProvider, FileCredentialStore, publicEndpointConfig, type LinePrincipal } from '@raidenyn/line-mcp';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import { buildComposedFixture, mkdtemp, type ComposedFixture } from './test-support';
import { buildRegistrations } from './registrations';

const AUTH_DATA_TEMPLATE = {
  accessToken: 'access', refreshToken: 'refresh', certificate: 'cert',
  wrappedNonce: 'nonce', kdfParameter1: 'k1', kdfParameter2: 'k2',
};

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item.type !== 'text' || item.text === undefined) throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}

/**
 * Two principals (owner-scoped isolation) sharing the SAME cache/category/
 * template stores that a real deployment on one data root would use — proves
 * both halves of the trusted-tenant design in one real MCP-over-HTTP
 * roundtrip per principal:
 *   - the owner-scoped LINE message cache isolates two principals even when
 *     they reference the identical chat_mid/message_id;
 *   - the shared (NOT owner-scoped) category/template stores are visible to
 *     every principal on the data root by design.
 */
describe('composed server — account isolation vs. trusted-tenant sharing', () => {
  let fixture: ComposedFixture;
  let authStoreDir: string;
  let httpServer: ReturnType<import('express').Express['listen']>;
  let aliceClient: Client;
  let bobClient: Client;
  let aliceTransport: StreamableHTTPClientTransport;
  let bobTransport: StreamableHTTPClientTransport;

  const CHAT_MID = 'c-shared-chat';
  const MESSAGE_ID = 'm-shared-id'; // identical id used for BOTH owners below

  beforeAll(async () => {
    authStoreDir = mkdtemp('server-tenant-auth-');
    fixture = buildComposedFixture(`${__dirname}/../docs/guide`);

    // Pre-seed the REAL cache directly (bypassing any tool call) with the
    // SAME chat_mid/message_id under two DIFFERENT owner mids but DIFFERENT
    // text — this is exactly the shape that would silently leak across
    // accounts if the cache were not owner-scoped.
    fixture.cache.upsertMessages('u-alice', CHAT_MID, [{
      id: MESSAGE_ID, from: CHAT_MID, to: CHAT_MID, toType: 1,
      createdTime: '1700000000000', contentType: 0, hasContent: false,
      text: 'ALICE_ONLY_SECRET_TEXT',
    }]);
    fixture.cache.upsertMessages('u-bob', CHAT_MID, [{
      id: MESSAGE_ID, from: CHAT_MID, to: CHAT_MID, toType: 1,
      createdTime: '1700000000000', contentType: 0, hasContent: false,
      text: 'BOB_ONLY_SECRET_TEXT',
    }]);

    const credentialStore = new FileCredentialStore(authStoreDir);
    const authProvider = new LineAuthProvider({
      secret: 'test-secret',
      endpoints: publicEndpointConfig(0, ''),
      credentialStore,
      authStoreDir,
    });
    authProvider.seedTestToken('token-alice', { ...AUTH_DATA_TEMPLATE, mid: 'u-alice' });
    authProvider.seedTestToken('token-bob', { ...AUTH_DATA_TEMPLATE, mid: 'u-bob' });

    const host = createMcpHost<LinePrincipal>({
      name: 'test-tenant',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: buildRegistrations(fixture.deps),
    });

    httpServer = host.app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    aliceTransport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer token-alice' } } });
    aliceClient = new Client({ name: 'alice', version: '0.0.0' });
    await aliceClient.connect(aliceTransport);

    bobTransport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer token-bob' } } });
    bobClient = new Client({ name: 'bob', version: '0.0.0' });
    await bobClient.connect(bobTransport);
  });

  afterAll(async () => {
    await aliceTransport?.close().catch(() => {});
    await bobTransport?.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fixture?.cleanup();
    fs.rmSync(authStoreDir, { recursive: true, force: true });
  });

  it('isolates messages: two principals sharing chat_mid/message_id see only their own text', async () => {
    const aliceResult = await aliceClient.callTool({ name: 'get_messages', arguments: { chatMid: CHAT_MID, count: 10 } });
    const bobResult = await bobClient.callTool({ name: 'get_messages', arguments: { chatMid: CHAT_MID, count: 10 } });

    const aliceText = extractText(aliceResult as never);
    const bobText = extractText(bobResult as never);

    expect(aliceText).toContain('ALICE_ONLY_SECRET_TEXT');
    expect(aliceText).not.toContain('BOB_ONLY_SECRET_TEXT');

    expect(bobText).toContain('BOB_ONLY_SECRET_TEXT');
    expect(bobText).not.toContain('ALICE_ONLY_SECRET_TEXT');
  });

  it('shares categories across principals by design (trusted-tenant, not owner-scoped)', async () => {
    const upsert = await aliceClient.callTool({
      name: 'manage_categories',
      arguments: { action: 'upsert', category: { name: 'Trusted-Tenant-Category', pattern: 'ANY_PATTERN_XYZ' } },
    });
    expect(upsert.isError).toBeFalsy();

    // Bob — a DIFFERENT principal, same data root — sees the category Alice created.
    const bobList = await bobClient.callTool({ name: 'manage_categories', arguments: { action: 'list' } });
    const categories = JSON.parse(extractText(bobList as never)) as Array<{ name: string }>;
    expect(categories.some((c) => c.name === 'Trusted-Tenant-Category')).toBe(true);

    // Cleanup as bob — proves deletion is equally cross-principal-visible.
    const del = await bobClient.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'Trusted-Tenant-Category' } });
    expect(del.isError).toBeFalsy();
  });

  it('shares per-chat templates across principals by design (trusted-tenant, not owner-scoped)', async () => {
    const upsert = await aliceClient.callTool({
      name: 'manage_templates',
      arguments: {
        chatMid: CHAT_MID,
        action: 'upsert',
        template: {
          name: 'Trusted-Tenant-Template',
          pattern: '(?<original_amount>\\d+) (?<original_currency>THB)',
        },
      },
    });
    expect(upsert.isError).toBeFalsy();

    // Bob — a DIFFERENT principal — sees the SAME chat's template Alice saved.
    const bobList = await bobClient.callTool({ name: 'manage_templates', arguments: { chatMid: CHAT_MID, action: 'list' } });
    const templates = JSON.parse(extractText(bobList as never)) as Array<{ name: string }>;
    expect(templates.some((t) => t.name === 'Trusted-Tenant-Template')).toBe(true);

    const del = await bobClient.callTool({ name: 'manage_templates', arguments: { chatMid: CHAT_MID, action: 'delete', name: 'Trusted-Tenant-Template' } });
    expect(del.isError).toBeFalsy();
  });
});
