import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createServer, type ComposedServer } from '@raidenyn/server';
import type { AuthData } from '@raidenyn/line-client';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Reproduces issue #79: two `createServer` instances (two independent data
// roots) constructed in the SAME process must never let one root's LINE
// credential leak into the other's outbound LINE API calls, even when both
// happen to hold an account under the identical MID. Two separate CLI
// subprocesses would NOT reproduce this — each process gets its own
// LineAuthProvider instance regardless of the fix; only same-process,
// multi-instance construction (exactly what createServer/createStandaloneServer
// support) can leak state between them.

const SAME_MID = 'u-shared-mid-0001';

// Storage-key material must be valid base64 the LTSM WASM can decode in
// storage_key_init — placeholder strings like 'nonce'/'k1'/'k2' throw an
// `atob` decode error inside the sandbox before any HTTP request is signed
// and sent, which prevents the credential-bleed reproduction from surfacing
// (the stubs end up empty rather than capturing the leaked token). The
// VALID_STORAGE_KEY constants from tests/support/mock-line-server/fixtures.ts
// are real base64 values the WASM accepts; using them here lets listChats()
// complete its outbound call so the cross-root leak is observable.
const AUTH_TEMPLATE = {
  refreshToken: 'refresh', certificate: 'cert',
  wrappedNonce: 'AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT',
  kdfParameter1: 'W5kowvH9dJNVemz7XD2dww==',
  kdfParameter2: '+ZFNyJlBAnn2W5e9m/ALYA==',
};

function authDataWith(accessToken: string): AuthData {
  return { ...AUTH_TEMPLATE, mid: SAME_MID, accessToken };
}

interface AccessStub {
  origin: string;
  capturedAccessTokens: string[];
  close(): Promise<void>;
}

/** A minimal LINE-API stand-in: accepts any request, records the caller's
 * `x-line-access` header, and returns just enough shape for `listChats()` to
 * resolve without error. No HMAC/protocol validation — this stub exists only
 * to observe WHICH credential's access token reached it, not to exercise the
 * wire protocol (that's covered by tests/support/mock-line-server elsewhere). */
function startAccessStub(): Promise<AccessStub> {
  const capturedAccessTokens: string[] = [];
  const server = http.createServer((req, res) => {
    capturedAccessTokens.push(String(req.headers['x-line-access'] ?? ''));
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/talk/thrift/Talk/TalkService/getAllChatMids') {
        res.end(JSON.stringify({ code: 0, message: 'ok', data: { memberChatMids: [], invitedChatMids: [] } }));
      } else if (req.url === '/api/talk/thrift/Talk/TalkService/getAllContactIds') {
        res.end(JSON.stringify({ code: 0, message: 'ok', data: [] }));
      } else {
        res.end(JSON.stringify({ code: 0, message: 'ok', data: null }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        capturedAccessTokens,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function callListChats(port: number, bearer: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } },
  );
  const client = new Client({ name: 'isolation-check', version: '0.0.0' });
  await client.connect(transport);
  try {
    await client.callTool({ name: 'list_chats', arguments: {} });
  } finally {
    await transport.close();
  }
}

describe('cross-root credential isolation (issue #79)', () => {
  const dataRoots: string[] = [];
  const servers: ComposedServer[] = [];
  const stubs: AccessStub[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await Promise.all(stubs.map((s) => s.close()));
    for (const root of dataRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  it('never resolves data-root B\'s outbound LINE call using data-root A\'s credential, for the same MID', async () => {
    const stubA = await startAccessStub();
    const stubB = await startAccessStub();
    stubs.push(stubA, stubB);

    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-isolation-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-isolation-b-'));
    dataRoots.push(rootA, rootB);

    const serverA = createServer({
      dataRoot: rootA,
      port: 0,
      lineApiBaseUrl: stubA.origin,
      testAuth: [{ token: 'token-a', authData: authDataWith('access-a') }],
    });
    const serverB = createServer({
      dataRoot: rootB,
      port: 0,
      lineApiBaseUrl: stubB.origin,
      testAuth: [{ token: 'token-b', authData: authDataWith('access-b') }],
    });
    servers.push(serverA, serverB);

    const { port: portA } = await serverA.start();
    const { port: portB } = await serverB.start();

    // Order matters for this reproduction: root A's request must complete
    // first, priming whatever freshness state it owns; THEN root B's request
    // is the one that would (pre-fix) inherit root A's stale snapshot.
    await callListChats(portA, 'token-a');
    await callListChats(portB, 'token-b');

    expect(stubA.capturedAccessTokens).toContain('access-a');
    expect(stubA.capturedAccessTokens).not.toContain('access-b');
    expect(stubB.capturedAccessTokens).toContain('access-b');
    expect(stubB.capturedAccessTokens).not.toContain('access-a');
  });
});