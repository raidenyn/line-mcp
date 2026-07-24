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

// The composed server's real tool/resource registration wiring, driven end to
// end over a real HTTP MCP client roundtrip — never just a registration-count
// assertion against a bare McpServer. Only the raw LINE network layer is
// faked (see test-support.ts); createMcpHost, the real registerLineTools/
// registerBankTools/registerLineResources/registerBankResources, and the
// real MCP protocol transport are all exercised as in production.
describe('composed server — tool/resource registration (real MCP roundtrip)', () => {
  let fixture: ComposedFixture;
  let authStoreDir: string;
  let httpServer: ReturnType<import('express').Express['listen']>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    authStoreDir = mkdtemp('server-composition-auth-');
    // Reuse the REAL packaged docs/guide directory (not a synthetic stand-in)
    // so this test proves the actual shipped composed overview is reachable.
    fixture = buildComposedFixture(`${__dirname}/../docs/guide`);

    const credentialStore = new FileCredentialStore(authStoreDir);
    const authProvider = new LineAuthProvider({
      secret: 'test-secret',
      endpoints: publicEndpointConfig(0, ''),
      credentialStore,
      authStoreDir,
    });
    authProvider.seedTestToken('test-token', { ...AUTH_DATA_TEMPLATE, mid: 'u-test' });

    const host = createMcpHost<LinePrincipal>({
      name: 'test-composed',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: buildRegistrations(fixture.deps),
    });

    httpServer = host.app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer test-token' } },
    });
    client = new Client({ name: 'composition-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport?.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fixture?.cleanup();
    fs.rmSync(authStoreDir, { recursive: true, force: true });
  });

  it('lists exactly ten tools, with no duplicates', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate registrations
    expect(names.sort()).toEqual(
      [
        'list_chats', 'get_messages', 'get_image', 'initiate_import', 'complete_import',
        'manage_templates', 'manage_categories', 'sample_messages', 'get_transactions', 'summarize_transactions',
      ].sort(),
    );
  });

  it('lists exactly eleven resources: one composed overview + ten tool guides, with no duplicates', async () => {
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(new Set(uris).size).toBe(uris.length); // no duplicate registrations
    expect(uris.sort()).toEqual(
      [
        'line://guide',
        'line://guide/tools/list_chats',
        'line://guide/tools/get_messages',
        'line://guide/tools/get_image',
        'line://guide/tools/initiate_import',
        'line://guide/tools/complete_import',
        'line://guide/tools/sample_messages',
        'line://guide/tools/manage_templates',
        'line://guide/tools/manage_categories',
        'line://guide/tools/get_transactions',
        'line://guide/tools/summarize_transactions',
      ].sort(),
    );
  });

  it('reads the composed (ten-tool) overview at line://guide — not either package-relative one', async () => {
    const result = await client.readResource({ uri: 'line://guide' });
    const item = result.contents[0];
    expect(item.mimeType).toBe('text/markdown');
    expect('text' in item).toBe(true);
    if ('text' in item) {
      // The composed overview mentions both messenger AND bank workflows —
      // the trimmed line-mcp-only overview does not mention transaction
      // parsing at all (see packages/line-mcp/docs/guide/overview.md).
      expect(item.text).toMatch(/bank transaction/i);
      expect(item.text).toMatch(/manage_categories/);
      expect(item.text).toMatch(/list_chats/);
    }
  });
});
