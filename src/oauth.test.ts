import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Mock LineClient so /authorize doesn't hit the real LINE API
vi.mock('./line-client', () => {
  const mockAuthData = {
    accessToken: 'tok',
    refreshToken: 'rtok',
    certificate: 'cert',
    mid: 'umid',
    wrappedNonce: 'wn',
    kdfParameter1: 'k1',
    kdfParameter2: 'k2',
  };
  const mockLineClient = {
    login: vi.fn().mockResolvedValue({ qrUrl: 'https://line.me/R/nv/QRLogin?sid=fakesid' }),
    waitForPin: vi.fn().mockResolvedValue(null),
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    getCompletedAuth: vi.fn().mockReturnValue(mockAuthData),
  };
  return { LineClient: vi.fn().mockImplementation(() => mockLineClient) };
});

import { setupOAuthRoutes, activeTokens, loadTokenState, makeWwwAuthenticate } from './oauth';

const TOKEN_STATE_FILE = path.join(process.cwd(), '.line-mcp-tokens.json');

// --- helpers ---

let server: http.Server;
let base: string;

async function req(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// --- test lifecycle ---

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      setupOAuthRoutes(app, addr.port);
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  activeTokens.clear();
  // Remove any token state file written during tests
  try { fs.unlinkSync(TOKEN_STATE_FILE); } catch { /* ok */ }
});

// ───────────────────────────────────────────────────────────
// makeWwwAuthenticate
// ───────────────────────────────────────────────────────────

describe('makeWwwAuthenticate', () => {
  it('includes port and resource_metadata URL', () => {
    const header = makeWwwAuthenticate(3001);
    expect(header).toContain('Bearer error="invalid_token"');
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource');
  });
});

// ───────────────────────────────────────────────────────────
// loadTokenState
// ───────────────────────────────────────────────────────────

describe('loadTokenState', () => {
  it('loads valid non-expired tokens from disk', () => {
    const token = 'testtoken123';
    const now = Date.now();
    const state = {
      activeTokens: {
        [token]: {
          authData: { accessToken: 'at', refreshToken: 'rt', certificate: 'c', mid: 'm', wrappedNonce: 'w', kdfParameter1: 'k1', kdfParameter2: 'k2' },
          mcpRefreshToken: 'mrt',
          expiresAt: now + 3_600_000,
        },
      },
      refreshTokens: { mrt: { accessToken: 'at', refreshToken: 'rt', certificate: 'c', mid: 'm', wrappedNonce: 'w', kdfParameter1: 'k1', kdfParameter2: 'k2' } },
    };
    fs.writeFileSync(TOKEN_STATE_FILE, JSON.stringify(state), 'utf8');
    loadTokenState();
    expect(activeTokens.has(token)).toBe(true);
    expect(activeTokens.get(token)!.expiresAt).toBeGreaterThan(now);
  });

  it('skips expired tokens', () => {
    const state = {
      activeTokens: {
        expiredtok: {
          authData: { accessToken: 'a', refreshToken: 'r', certificate: 'c', mid: 'm', wrappedNonce: 'w', kdfParameter1: 'k1', kdfParameter2: 'k2' },
          mcpRefreshToken: 'mrt2',
          expiresAt: Date.now() - 1000,
        },
      },
      refreshTokens: {},
    };
    fs.writeFileSync(TOKEN_STATE_FILE, JSON.stringify(state), 'utf8');
    loadTokenState();
    expect(activeTokens.has('expiredtok')).toBe(false);
  });

  it('handles missing file gracefully', () => {
    expect(() => loadTokenState()).not.toThrow();
  });

  it('handles corrupt JSON gracefully', () => {
    fs.writeFileSync(TOKEN_STATE_FILE, '{invalid json}}', 'utf8');
    expect(() => loadTokenState()).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────
// GET /.well-known/oauth-protected-resource
// ───────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns resource and authorization_servers', async () => {
    const { status, body } = await req(`${base}/.well-known/oauth-protected-resource`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.resource).toMatch(/\/mcp$/);
    expect(Array.isArray(b.authorization_servers)).toBe(true);
    expect(b.bearer_methods_supported).toContain('header');
  });
});

// ───────────────────────────────────────────────────────────
// GET /.well-known/oauth-authorization-server
// ───────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns issuer, endpoints, and PKCE support', async () => {
    const { status, body } = await req(`${base}/.well-known/oauth-authorization-server`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.issuer).toMatch(/^http:\/\/localhost:\d+$/);
    expect(b.authorization_endpoint).toContain('/authorize');
    expect(b.token_endpoint).toContain('/token');
    expect((b.code_challenge_methods_supported as string[]).includes('S256')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
// GET /authorize — validation
// ───────────────────────────────────────────────────────────

describe('GET /authorize', () => {
  const validParams = new URLSearchParams({
    response_type: 'code',
    client_id: 'claude-code',
    redirect_uri: 'http://localhost:8765/callback',
    code_challenge: s256('verifier123'),
    code_challenge_method: 'S256',
    state: 'st',
  });

  it('returns 400 when response_type is missing', async () => {
    const params = new URLSearchParams(validParams);
    params.delete('response_type');
    const { status } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
  });

  it('returns 400 when client_id is missing', async () => {
    const params = new URLSearchParams(validParams);
    params.delete('client_id');
    const { status } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
  });

  it('returns 400 when redirect_uri is missing', async () => {
    const params = new URLSearchParams(validParams);
    params.delete('redirect_uri');
    const { status } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
  });

  it('returns 400 when code_challenge is missing', async () => {
    const params = new URLSearchParams(validParams);
    params.delete('code_challenge');
    const { status } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
  });

  it('returns 400 for non-loopback redirect_uri', async () => {
    const params = new URLSearchParams(validParams);
    params.set('redirect_uri', 'https://evil.example.com/callback');
    const { status, body } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
    expect(body as string).toContain('loopback');
  });

  it('returns 400 for unsupported code_challenge_method', async () => {
    const params = new URLSearchParams(validParams);
    params.set('code_challenge_method', 'plain');
    const { status } = await req(`${base}/authorize?${params}`);
    expect(status).toBe(400);
  });

  it('accepts 127.0.0.1 as loopback redirect_uri (passes validation)', async () => {
    const params = new URLSearchParams(validParams);
    params.set('redirect_uri', 'http://127.0.0.1:9000/callback');
    const { status, body } = await req(`${base}/authorize?${params}`);
    // A 400 means validation rejected it — anything else means it passed validation
    expect(status).not.toBe(400);
    if (status === 400) expect(body as string).not.toContain('loopback');
  });
});

// ───────────────────────────────────────────────────────────
// GET /authorize/poll
// ───────────────────────────────────────────────────────────

describe('GET /authorize/poll', () => {
  it('returns 404 for unknown session id', async () => {
    const { status, body } = await req(`${base}/authorize/poll?sid=nonexistent`);
    expect(status).toBe(404);
    expect((body as Record<string, string>).error).toBe('Session not found');
  });
});

// ───────────────────────────────────────────────────────────
// POST /token
// ───────────────────────────────────────────────────────────

describe('POST /token', () => {
  const post = (body: Record<string, string>) =>
    req(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns 400 for unsupported grant_type', async () => {
    const { status, body } = await post({ grant_type: 'implicit' });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('unsupported_grant_type');
  });

  it('authorization_code: returns 400 when code is missing', async () => {
    const { status, body } = await post({ grant_type: 'authorization_code', code_verifier: 'v' });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_request');
  });

  it('authorization_code: returns 400 when code_verifier is missing', async () => {
    const { status, body } = await post({ grant_type: 'authorization_code', code: 'someCode' });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_request');
  });

  it('authorization_code: returns invalid_grant for unknown code', async () => {
    const { status, body } = await post({
      grant_type: 'authorization_code',
      code: 'nosuchcode',
      code_verifier: 'verifier',
    });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_grant');
  });

  it('refresh_token: returns 400 when refresh_token is missing', async () => {
    const { status, body } = await post({ grant_type: 'refresh_token' });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_request');
  });

  it('refresh_token: returns invalid_grant for unknown token', async () => {
    const { status, body } = await post({
      grant_type: 'refresh_token',
      refresh_token: 'nosuchtoken',
    });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_grant');
  });

  it('accepts form-encoded body', async () => {
    const { status, body } = await req(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=bad',
    });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_grant');
  });
});
