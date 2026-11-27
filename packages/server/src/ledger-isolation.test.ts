import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import { createMcpHost } from '@raidenyn/mcp-runtime';
import { LineAuthProvider, FileCredentialStore, publicEndpointConfig, type LinePrincipal } from '@raidenyn/line-mcp';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import { buildComposedFixture, mkdtemp, type ComposedFixture } from './test-support';
import { buildRegistrations } from './registrations';

const AUTH_DATA_TEMPLATE = {
  accessToken: 'access', refreshToken: 'refresh', certificate: 'cert',
  wrappedNonce: 'nonce', kdfParameter1: 'k1', kdfParameter2: 'k2',
};

interface Body {
  settings?: { base_currency: string; timezone: string; revision: number };
  source?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  error?: { code: string; message: string; action?: string; details?: Record<string, unknown> };
}

function body(result: CallToolResult): Body {
  return (result.structuredContent ?? {}) as Body;
}

async function callManage(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return client.callTool({ name: 'manage_accounts', arguments: args }) as Promise<CallToolResult>;
}

async function callStatus(client: Client): Promise<CallToolResult> {
  return client.callTool({ name: 'ledger_status', arguments: {} }) as Promise<CallToolResult>;
}

/**
 * Two principals on one data root, driven over a real MCP-over-HTTP roundtrip:
 * the owner-scoped ledger (not the trusted-tenant category/template stores)
 * must answer another owner's source exactly like an unknown one and keep
 * every list, revision and idempotency key inside the calling account.
 */
describe('composed server — ledger owner isolation', () => {
  let fixture: ComposedFixture;
  let authStoreDir: string;
  let httpServer: ReturnType<import('express').Express['listen']>;
  let aliceClient: Client;
  let bobClient: Client;
  let aliceTransport: StreamableHTTPClientTransport;
  let bobTransport: StreamableHTTPClientTransport;

  const ALICE_CHAT = 'c-alice-chat';
  const BOB_CHAT = 'c-bob-chat';
  const SHARED_CHAT = 'c-shared-ledger-chat';

  beforeAll(async () => {
    authStoreDir = mkdtemp('server-ledger-isolation-auth-');
    fixture = buildComposedFixture(`${__dirname}/../docs/guide`);

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
      name: 'test-ledger-isolation',
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

    const aliceSetup = await callManage(aliceClient, {
      action: 'add_source', provider: 'line', source_id: ALICE_CHAT, base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
    });
    expect(aliceSetup.isError).toBeFalsy();
    const bobSetup = await callManage(bobClient, {
      action: 'add_source', provider: 'line', source_id: BOB_CHAT, base_currency: 'USD', owner_timezone: 'UTC',
    });
    expect(bobSetup.isError).toBeFalsy();
  });

  afterAll(async () => {
    await aliceTransport?.close().catch(() => {});
    await bobTransport?.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fixture?.cleanup();
    fs.rmSync(authStoreDir, { recursive: true, force: true });
  });

  it('answers another owner\u2019s source as not_found and never lists it', async () => {
    const getOther = await callManage(bobClient, { action: 'get_source', provider: 'line', source_id: ALICE_CHAT });
    expect(getOther.isError).toBe(true);
    expect(body(getOther).error?.code).toBe('not_found');

    const updateOther = await callManage(bobClient, {
      action: 'update_source', provider: 'line', source_id: ALICE_CHAT, label: 'stolen',
    });
    expect(updateOther.isError).toBe(true);
    expect(body(updateOther).error?.code).toBe('not_found');

    const aliceSource = await callManage(aliceClient, { action: 'get_source', provider: 'line', source_id: ALICE_CHAT });
    expect(body(aliceSource).source).toMatchObject({ source_id: ALICE_CHAT, revision: 1, label: null });

    const bobList = await callManage(bobClient, { action: 'list_sources' });
    const bobStatus = await callStatus(bobClient);
    for (const result of [bobList, bobStatus]) {
      const ids = (body(result).sources ?? []).map((source) => source.source_id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain(BOB_CHAT);
      expect(ids).not.toContain(ALICE_CHAT);
    }
  });

  it('lets both owners register the same chat with their own labels', async () => {
    const aliceAdd = await callManage(aliceClient, {
      action: 'add_source', provider: 'line', source_id: SHARED_CHAT,
      base_currency: 'THB', owner_timezone: 'Asia/Bangkok', label: 'A',
    });
    expect(aliceAdd.isError).toBeFalsy();
    const bobAdd = await callManage(bobClient, {
      action: 'add_source', provider: 'line', source_id: SHARED_CHAT,
      base_currency: 'USD', owner_timezone: 'UTC', label: 'B',
    });
    expect(bobAdd.isError).toBeFalsy();

    const aliceGet = await callManage(aliceClient, { action: 'get_source', provider: 'line', source_id: SHARED_CHAT });
    expect(body(aliceGet).source?.label).toBe('A');
    const bobGet = await callManage(bobClient, { action: 'get_source', provider: 'line', source_id: SHARED_CHAT });
    expect(body(bobGet).source?.label).toBe('B');
  });

  it('treats the same idempotency key as a new write for the other owner', async () => {
    const aliceUpdate = await callManage(aliceClient, {
      action: 'update_source', provider: 'line', source_id: ALICE_CHAT, label: 'alice-renamed', idempotency_key: 'same-key',
    });
    expect(aliceUpdate.isError).toBeFalsy();

    const bobUpdate = await callManage(bobClient, {
      action: 'update_source', provider: 'line', source_id: BOB_CHAT, label: 'bob-renamed', idempotency_key: 'same-key',
    });
    expect(bobUpdate.isError).toBeFalsy();
    expect(body(bobUpdate).source?.label).toBe('bob-renamed');
  });
});
