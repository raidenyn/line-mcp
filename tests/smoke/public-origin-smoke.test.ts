import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  startMockLineServer,
  reserveFreePort,
  createTemporaryDataRoot,
  startApplication,
  type RunningMock,
  type RunningApp,
} from '../support/process-harness';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BASE_PATH = '/line-mcp';
const PUBLIC_URL = 'https://mcp.example.com';
const ALLOWED_CALLBACK = 'https://client.example.com/oauth/callback';
const epochSeconds = Math.floor(Date.now() / 1000);

function authorizeParams(redirectUri: string): URLSearchParams {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return new URLSearchParams({
    response_type: 'code',
    client_id: 'public-origin-smoke',
    redirect_uri: redirectUri,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'smoke',
  });
}

describe.sequential('public-origin smoke (compiled CLIs)', () => {
  let mock: RunningMock;

  beforeAll(async () => {
    mock = await startMockLineServer(PROJECT_ROOT);
  }, 60_000);

  afterAll(async () => {
    // Only the QR page is requested; no login branch completes, so route
    // counts and login-branch expectations are not asserted.
    await mock.shutdown({ verify: false });
  }, 15_000);

  it.each(['composed', 'standalone'] as const)(
    '%s advertises PUBLIC_URL and enforces the redirect allowlist',
    async target => {
      const port = await reserveFreePort();
      const dataRoot = createTemporaryDataRoot(`line-smoke-public-${target}-`);
      let app: RunningApp | undefined;
      try {
        await mock.reset();
        await mock.configure({
          scenarioId: `${target}-public-origin`,
          mode: 'full-auth',
          epochSeconds,
          expectedRefreshCount: 0,
          expectedLoginBranches: [],
          expectedRejections: {},
        });

        app = await startApplication({
          target,
          projectRoot: PROJECT_ROOT,
          dataRoot,
          port,
          lineApiBaseUrl: mock.origin,
          basePath: BASE_PATH,
          publicUrl: PUBLIC_URL,
          extraEnv: { OAUTH_ALLOWED_REDIRECT_URIS: ALLOWED_CALLBACK },
        });

        const health = await fetch(`${app.origin}${BASE_PATH}/healthz`);
        expect(health.status).toBe(200);

        const asMeta = await fetch(
          `${app.origin}/.well-known/oauth-authorization-server${BASE_PATH}`,
        );
        expect(asMeta.status).toBe(200);
        const as = await asMeta.json() as Record<string, unknown>;
        expect(as.issuer).toBe(`${PUBLIC_URL}${BASE_PATH}`);
        expect(as.authorization_endpoint).toBe(`${PUBLIC_URL}${BASE_PATH}/authorize`);
        expect(as.token_endpoint).toBe(`${PUBLIC_URL}${BASE_PATH}/token`);
        expect(as.registration_endpoint).toBe(`${PUBLIC_URL}${BASE_PATH}/register`);

        const prMeta = await fetch(
          `${app.origin}/.well-known/oauth-protected-resource${BASE_PATH}/mcp`,
        );
        expect(prMeta.status).toBe(200);
        const pr = await prMeta.json() as Record<string, unknown>;
        expect(pr.resource).toBe(`${PUBLIC_URL}${BASE_PATH}/mcp`);
        expect(pr.authorization_servers).toEqual([`${PUBLIC_URL}${BASE_PATH}`]);

        const allowed = await fetch(
          `${app.origin}${BASE_PATH}/authorize?${authorizeParams(ALLOWED_CALLBACK)}`,
        );
        expect(allowed.status).not.toBe(400);

        const rejected = await fetch(
          `${app.origin}${BASE_PATH}/authorize?${authorizeParams('https://attacker.example/cb')}`,
        );
        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain('OAUTH_ALLOWED_REDIRECT_URIS');

        const unauthorized = await fetch(`${app.origin}${BASE_PATH}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'public-origin-smoke', version: '0.0.0' },
            },
          }),
        });
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers.get('www-authenticate')).toContain(
          `${PUBLIC_URL}/.well-known/oauth-protected-resource${BASE_PATH}/mcp`,
        );
      } finally {
        await app?.stop().catch(() => {});
        fs.rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('refuses to start when PUBLIC_URL contains a path, and says to use BASE_PATH', async () => {
    const port = await reserveFreePort();
    const dataRoot = createTemporaryDataRoot('line-smoke-public-bad-url-');
    try {
      // The harness appends the safe env summary to errors, so match the CLI's
      // own `Fatal:` line rather than the bare variable names.
      await expect(startApplication({
        target: 'composed',
        projectRoot: PROJECT_ROOT,
        dataRoot,
        port,
        lineApiBaseUrl: mock.origin,
        basePath: BASE_PATH,
        publicUrl: `${PUBLIC_URL}/bad`,
      })).rejects.toThrow(/Fatal: .*PUBLIC_URL.*BASE_PATH/);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
