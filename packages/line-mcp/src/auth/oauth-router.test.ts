import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import express, { type Express, type Request } from 'express';
import * as http from 'http';
import * as crypto from 'crypto';
import { LineAuthProvider, publicEndpointConfig } from './line-auth-provider';
import { FileCredentialStore } from './credential-store';
import { createRedirectPolicy, type RedirectPolicy } from './redirect-policy';
import { createMcpHost } from '@raidenyn/mcp-runtime';

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

// Mock LineClient so /authorize doesn't hit the real LINE API.
vi.mock('@raidenyn/line-client', async importOriginal => {
  const original = await importOriginal<typeof import('@raidenyn/line-client')>();
  const mockAuthData = {
    accessToken: 'tok',
    refreshToken: 'rtok',
    certificate: 'cert',
    mid: 'umid',
    wrappedNonce: 'wn',
    kdfParameter1: 'k1',
    kdfParameter2: 'k2',
  };
  const createdClients: Array<{
    login: ReturnType<typeof vi.fn>;
    waitForPin: ReturnType<typeof vi.fn>;
    waitForCompletion: ReturnType<typeof vi.fn>;
    getCompletedAuth: ReturnType<typeof vi.fn>;
    getProfileDisplayName: ReturnType<typeof vi.fn>;
  }> = [];
  const profileLookup = vi.fn().mockResolvedValue('Personal LINE');
  const LineClient = vi.fn().mockImplementation(function LineClient() {
    const client = {
      login: vi.fn().mockResolvedValue({ qrUrl: 'https://line.me/R/nv/QRLogin?sid=fakesid' }),
      waitForPin: vi.fn().mockResolvedValue(null),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      getCompletedAuth: vi.fn().mockReturnValue(mockAuthData),
      getProfileDisplayName: profileLookup,
    };
    createdClients.push(client);
    return client;
  });
  return {
    ...original,
    LineClient,
    __createdClients: createdClients,
    __profileLookup: profileLookup,
    __mockAuthData: mockAuthData,
  };
});

const TEST_SECRET = 'oauth-router-test-secret';

function providerFor(
  port: number,
  basePath: string,
  authStoreDir: string,
  lineApiBaseUrl?: string,
  extra?: { publicUrl?: string; redirectPolicy?: RedirectPolicy },
): LineAuthProvider {
  return new LineAuthProvider({
    secret: TEST_SECRET,
    endpoints: publicEndpointConfig(port, basePath, undefined, extra?.publicUrl),
    credentialStore: new FileCredentialStore(authStoreDir),
    authStoreDir,
    redirectPolicy: extra?.redirectPolicy,
    lineApiBaseUrl,
  });
}

// Adapter mirroring the old setupOAuthRoutes(app, port, basePath, authStoreDir)
// signature the router tests were written against.
function setupOAuthRoutes(
  app: Express,
  port: number,
  basePath: string,
  authStoreDir: string,
  lineApiBaseUrl?: string,
  extra?: { publicUrl?: string; redirectPolicy?: RedirectPolicy },
): LineAuthProvider {
  const provider = providerFor(port, basePath, authStoreDir, lineApiBaseUrl, extra);
  provider.mountRoutes(app);
  return provider;
}

const stubReq = { headers: {} } as unknown as Request;

// --- helpers ---

let server: http.Server;
let base: string;
let server2: http.Server;
let base2: string;
let authStoreDir: string;
let authStoreDir2: string;
const BASE_PATH_2 = '/line-mcp';

// A login started by one case can still be persisting its certificate while the
// next case's beforeEach runs; a plain recursive rm can then hit ENOTEMPTY.
// Retry the removal briefly instead of leaking the race into the next case.
function removeStoreDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function req(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

const sampleAuthData = {
  accessToken: 'at',
  refreshToken: 'rt',
  certificate: 'c',
  mid: 'testmid',
  wrappedNonce: 'w',
  kdfParameter1: 'k1',
  kdfParameter2: 'k2',
};

function writeRouteAuth(mid: string, displayName: string, certificate: string): void {
  fs.writeFileSync(path.join(authStoreDir, `${mid}.json`), JSON.stringify({
    ...sampleAuthData,
    mid,
    certificate,
    displayName,
  }));
}

function bodyAsHtml(response: { body: unknown }): string {
  expect(typeof response.body).toBe('string');
  return response.body as string;
}

function parseSelector(html: string): { selectionSession: string; personalChoice: string; workChoice: string } {
  const selectionSession = html.match(/name="selection_session" value="([^"]+)"/)?.[1];
  const rows = [...html.matchAll(/value="([^"]+)"[^>]*>\s*([^<]+)/g)];
  const choiceFor = (label: string) => rows.find(([, , text]) => text.trim() === label)?.[1];
  const personalChoice = choiceFor('Personal LINE');
  const workChoice = choiceFor('Work LINE');
  if (!selectionSession || !personalChoice || !workChoice) {
    throw new Error('Could not parse account selector');
  }
  return { selectionSession, personalChoice, workChoice };
}

async function postSelection(selectionSession: string, choice: string, targetBase = base, targetPath = '') {
  return req(`${targetBase}${targetPath}/authorize/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ selection_session: selectionSession, choice }),
  });
}

async function lastCreatedClient() {
  const lineModule = await import('@raidenyn/line-client') as unknown as {
    __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
  };
  return lineModule.__createdClients.at(-1)!;
}

const routeParams = () => new URLSearchParams({
  response_type: 'code',
  client_id: 'claude-code',
  redirect_uri: 'http://localhost:8765/callback',
  code_challenge: s256('verifier123'),
  code_challenge_method: 'S256',
  state: 'st',
});

async function withOAuthServer(
  authStorePath: string,
  run: (serverBase: string, provider: LineAuthProvider) => Promise<void>,
  extra?: { publicUrl?: string; redirectPolicy?: RedirectPolicy },
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const localServer = http.createServer(app);
  await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  const provider = setupOAuthRoutes(app, port, '', authStorePath, undefined, extra);
  try {
    await run(`http://127.0.0.1:${port}`, provider);
  } finally {
    await new Promise<void>(resolve => localServer.close(() => resolve()));
  }
}

function sessionIdFromQrPage(html: string): string {
  const context = html.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/)?.[1];
  const sid = context && (JSON.parse(context) as { sid?: unknown }).sid;
  if (typeof sid !== 'string') throw new Error('QR page did not contain a login session ID');
  return sid;
}

async function waitForTerminalLogin(serverBase: string, sid: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await req(`${serverBase}/authorize/poll?sid=${encodeURIComponent(sid)}`);
    const body = response.body as { phase: string; code?: string; error?: string };
    if (body.phase === 'complete' || body.phase === 'failed') return body;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Login session did not reach a terminal phase');
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
      authStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-routes-'));
      setupOAuthRoutes(app, addr.port, '', authStoreDir);
      resolve();
    });
  });

  const app2 = express();
  app2.use(express.json());
  app2.use(express.urlencoded({ extended: false }));

  await new Promise<void>((resolve) => {
    server2 = http.createServer(app2);
    // Bind on 'localhost': the provider derives issuer/resource URLs from
    // `http://localhost:${port}` independent of the request host, so base2 must
    // match that scheme for exact-equality assertions.
    server2.listen(0, 'localhost', () => {
      const addr = server2.address() as { port: number };
      base2 = `http://localhost:${addr.port}`;
      authStoreDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-routes-prefix-'));
      setupOAuthRoutes(app2, addr.port, BASE_PATH_2, authStoreDir2);
      resolve();
    });
  });
});

afterAll(() => Promise.all([
  new Promise<void>((resolve) => server.close(() => resolve())),
  new Promise<void>((resolve) => server2.close(() => resolve())),
]).then(() => {
  removeStoreDir(authStoreDir);
  removeStoreDir(authStoreDir2);
}));

beforeEach(async () => {
  removeStoreDir(authStoreDir);
  fs.mkdirSync(authStoreDir, { recursive: true });
  removeStoreDir(authStoreDir2);
  fs.mkdirSync(authStoreDir2, { recursive: true });
  const lineModule = await import('@raidenyn/line-client') as unknown as {
    LineClient: ReturnType<typeof vi.fn>;
    __createdClients: unknown[];
    __profileLookup: ReturnType<typeof vi.fn>;
  };
  lineModule.LineClient.mockClear();
  lineModule.__createdClients.length = 0;
  lineModule.__profileLookup.mockReset();
  lineModule.__profileLookup.mockResolvedValue('Personal LINE');
});

// ───────────────────────────────────────────────────────────
// challenge (WWW-Authenticate)
// ───────────────────────────────────────────────────────────

describe('challenge / WWW-Authenticate', () => {
  it('includes port and resource_metadata URL', () => {
    const header = providerFor(3001, '', authStoreDir).challenge(stubReq);
    expect(header).toContain('Bearer error="invalid_token"');
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource/mcp');
  });

  it('appends basePath after the well-known segment, not before, mirroring the /mcp resource path', () => {
    const header = providerFor(3001, '/line-mcp', authStoreDir).challenge(stubReq);
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource/line-mcp/mcp');
    expect(header).not.toContain('/line-mcp/.well-known');
  });
});

// ───────────────────────────────────────────────────────────
// GET /.well-known/oauth-protected-resource
// ───────────────────────────────────────────────────────────

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns resource and authorization_servers', async () => {
    const { status, body } = await req(`${base}/.well-known/oauth-protected-resource/mcp`);
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

  it('starts first-time QR login without a certificate when no account is saved', async () => {
    const { __createdClients } = await import('@raidenyn/line-client') as unknown as {
      __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
    };
    const response = await req(`${base}/authorize?${validParams}`);
    expect(response.status).toBe(200);
    expect(__createdClients.at(-1)?.login).toHaveBeenCalledWith(undefined);
  });

  it('forwards lineApiBaseUrl to the LineClient constructed for /authorize', async () => {
    const { LineClient } = await import('@raidenyn/line-client') as unknown as {
      LineClient: ReturnType<typeof vi.fn>;
    };
    LineClient.mockClear();
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    const localServer = http.createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
    const port = (localServer.address() as { port: number }).port;
    const localStore = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-gateway-'));
    setupOAuthRoutes(app, port, '', localStore, 'http://127.0.0.1:18201');
    try {
      const response = await req(`http://127.0.0.1:${port}/authorize?${validParams}`);
      expect(response.status).toBe(200);
      expect(LineClient).toHaveBeenCalledWith(
        undefined,
        globalThis.fetch,
        undefined,
        'http://127.0.0.1:18201',
      );
    } finally {
      await new Promise<void>(resolve => localServer.close(() => resolve()));
      fs.rmSync(localStore, { recursive: true, force: true });
    }
  });

  it('keeps script-breakout OAuth values in inert JSON context', async () => {
    const state = '</script><img src=x onerror=alert(1)>';
    const redirectUri = 'http://localhost:8765/</script><img src=x onerror=alert(2)>';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'claude-code',
      redirect_uri: redirectUri,
      code_challenge: s256('verifier123'),
      code_challenge_method: 'S256',
      state,
    });

    const { status, body } = await req(`${base}/authorize?${params}`);
    const html = body as string;
    const context = html.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/)?.[1];

    expect(status).toBe(200);
    expect(html).not.toContain('</script><img');
    expect(context).toBeDefined();
    expect(JSON.parse(context!)).toMatchObject({ state, redirectUri, basePath: '' });
  });

  it('automatically starts QR login with the only saved certificate', async () => {
    fs.writeFileSync(path.join(authStoreDir, `${sampleAuthData.mid}.json`), JSON.stringify({
      ...sampleAuthData,
      displayName: 'Personal LINE',
    }));
    const { __createdClients } = await import('@raidenyn/line-client') as unknown as {
      __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
    };

    const response = await req(`${base}/authorize?${validParams}`);

    expect(response.status).toBe(200);
    expect(__createdClients.at(-1)?.login).toHaveBeenCalledWith(sampleAuthData.certificate);
  });

  it('does not expose login startup errors from authorization requests', async () => {
    const lineModule = await import('@raidenyn/line-client') as unknown as {
      LineClient: ReturnType<typeof vi.fn>;
    };
    lineModule.LineClient.mockImplementationOnce(function LineClient() {
      return { login: vi.fn().mockRejectedValue(new Error('secret-token-and-full-mid')) };
    });

    const response = await req(`${base}/authorize?${validParams}`);

    expect(response.status).toBe(500);
    expect(response.body).toBe('Failed to start LINE login; please try again.');
    expect(response.body).not.toContain('secret-token-and-full-mid');
  });

  it('renders human names and opaque choices without starting QR for multiple accounts', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const { LineClient } = await import('@raidenyn/line-client');

    const { status, body } = await req(`${base}/authorize?${validParams}`);
    const html = body as string;

    expect(status).toBe(200);
    expect(html).toContain('Personal LINE');
    expect(html).toContain('Work LINE');
    expect(html).not.toContain('u-personal');
    expect(html).not.toContain('u-work');
    expect(html).not.toContain('personal-cert');
    expect(html).not.toContain(sampleAuthData.accessToken);
    expect(LineClient).not.toHaveBeenCalled();
  });

  it('uses the selected account certificate once and rejects replay', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
    const form = new URLSearchParams({ selection_session: selectionSession, choice: workChoice });

    const selected = await req(`${base}/authorize/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    expect(selected.status).toBe(200);
    expect((await lastCreatedClient()).login).toHaveBeenCalledWith('work-cert');

    const replay = await req(`${base}/authorize/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    expect(replay.status).toBe(400);
  });

  it('does not expose login startup errors from account selection', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
    const lineModule = await import('@raidenyn/line-client') as unknown as {
      LineClient: ReturnType<typeof vi.fn>;
    };
    lineModule.LineClient.mockImplementationOnce(function LineClient() {
      return { login: vi.fn().mockRejectedValue(new Error('secret-token-and-full-mid')) };
    });

    const response = await postSelection(selectionSession, workChoice);

    expect(response.status).toBe(500);
    expect(response.body).toBe('Failed to start LINE login; please try again.');
    expect(response.body).not.toContain('secret-token-and-full-mid');
  });

  it('returns 400 for an unknown selection session', async () => {
    const response = await postSelection('missing-session', 'missing-choice');
    expect(response.status).toBe(400);
  });

  it('returns 400 for a tampered choice and consumes the selection session', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));

    expect((await postSelection(selectionSession, 'missing-choice')).status).toBe(400);
    expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
  });

  it('returns 400 when the selected record disappears before submission', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
    fs.unlinkSync(path.join(authStoreDir, 'u-work.json'));

    expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
  });

  it('expires account selection sessions after ten minutes', async () => {
    vi.useFakeTimers();
    try {
      writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
      writeRouteAuth('u-work', 'Work LINE', 'work-cert');
      const selector = await req(`${base}/authorize?${validParams}`);
      const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
      vi.advanceTimersByTime(600_001);

      expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses opaque choices to distinguish duplicate display names', async () => {
    writeRouteAuth('u-personal', 'LINE Account', 'personal-cert');
    writeRouteAuth('u-work', 'LINE Account', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const html = bodyAsHtml(selector);
    const choices = [...html.matchAll(/name="choice" value="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(choices).size).toBe(2);
  });

  it('shows a masked MID for a legacy record without displayName', async () => {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    fs.writeFileSync(path.join(authStoreDir, 'u123456789abcdef.json'), JSON.stringify({
      ...sampleAuthData,
      mid: 'u123456789abcdef',
      certificate: 'legacy-cert',
    }));

    const selector = await req(`${base}/authorize?${validParams}`);
    const html = bodyAsHtml(selector);
    expect(html).toContain('u123...cdef');
    expect(html).not.toContain('u123456789abcdef');
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
    expect(status).not.toBe(400);
    if (status === 400) expect(body as string).not.toContain('loopback');
  });

  // Regression: non-http(s) schemes whose authority is `localhost`/`127.0.0.1`
  // used to pass isLoopbackRedirectUri() because only the hostname was checked.
  for (const redirectUri of [
    'javascript://localhost/evil',
    'data://localhost',
    'file://127.0.0.1/x',
  ]) {
    it(`rejects ${redirectUri.split(':')[0]}: scheme redirect_uri as non-loopback`, async () => {
      const params = new URLSearchParams(validParams);
      params.set('redirect_uri', redirectUri);
      const { status, body } = await req(`${base}/authorize?${params}`);
      expect(status).toBe(400);
      expect(body as string).toContain('loopback');
    });
  }
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

describe('OAuth completion persistence', () => {
  it('does not issue a code or update the provider\'s freshness state when durable persistence fails', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-blocked-'));
    const blockedAuthPath = path.join(parent, 'auth');
    fs.writeFileSync(blockedAuthPath, 'not a directory');

    await withOAuthServer(blockedAuthPath, async (serverBase, provider) => {
      const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
      const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
      const pollBody = await waitForTerminalLogin(serverBase, sid);

      expect(pollBody.phase).toBe('failed');
      expect(pollBody.code).toBeUndefined();
      expect(await provider.resolveCredentials({
        provider: 'line', subject: 'umid', mid: 'umid', scopes: ['line'],
      })).toBeNull();
    });
  });

  it('persists the profile name before reporting login complete', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-success-'));
    await withOAuthServer(store, async serverBase => {
      const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
      const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
      const pollBody = await waitForTerminalLogin(serverBase, sid);

      expect(pollBody.phase).toBe('complete');
      expect(pollBody.code).toBeTypeOf('string');
      expect(JSON.parse(fs.readFileSync(path.join(store, 'umid.json'), 'utf8')))
        .toMatchObject({ mid: 'umid', displayName: 'Personal LINE' });
    });
  });

  it('retains the saved display name when profile lookup fails', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-profile-fallback-'));
    fs.writeFileSync(path.join(store, 'umid.json'), JSON.stringify({
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      certificate: 'old-cert',
      mid: 'umid',
      wrappedNonce: 'old-nonce',
      kdfParameter1: 'old-kdf1',
      kdfParameter2: 'old-kdf2',
      displayName: 'Existing Name',
    }));
    const lineModule = await import('@raidenyn/line-client') as unknown as {
      __profileLookup: ReturnType<typeof vi.fn>;
    };
    lineModule.__profileLookup.mockRejectedValueOnce(new Error('profile unavailable'));

    await withOAuthServer(store, async serverBase => {
      const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
      const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
      expect((await waitForTerminalLogin(serverBase, sid)).phase).toBe('complete');
      expect(JSON.parse(fs.readFileSync(path.join(store, 'umid.json'), 'utf8')).displayName)
        .toBe('Existing Name');
    });
  });

  it('does not apply a selected account name to a different completed account', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-different-account-'));
    fs.writeFileSync(path.join(store, 'u-selected.json'), JSON.stringify({
      ...sampleAuthData,
      mid: 'u-selected',
      certificate: 'selected-cert',
      displayName: 'Personal LINE',
    }));
    fs.writeFileSync(path.join(store, 'u-other.json'), JSON.stringify({
      ...sampleAuthData,
      mid: 'u-other',
      certificate: 'other-cert',
      displayName: 'Work LINE',
    }));
    const lineModule = await import('@raidenyn/line-client') as unknown as {
      __profileLookup: ReturnType<typeof vi.fn>;
    };
    lineModule.__profileLookup.mockRejectedValueOnce(new Error('profile unavailable'));

    await withOAuthServer(store, async serverBase => {
      const selector = await req(`${serverBase}/authorize?${routeParams()}`);
      const { selectionSession, personalChoice } = parseSelector(bodyAsHtml(selector));
      const selected = await postSelection(selectionSession, personalChoice, serverBase);
      const sid = sessionIdFromQrPage(bodyAsHtml(selected));

      expect((await waitForTerminalLogin(serverBase, sid)).phase).toBe('complete');
      expect(JSON.parse(fs.readFileSync(path.join(store, 'umid.json'), 'utf8')).displayName)
        .toBeUndefined();
    });
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

  it('refresh_token: returns invalid_grant for a garbage token', async () => {
    const { status, body } = await post({
      grant_type: 'refresh_token',
      refresh_token: 'notasignedtoken',
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

// ───────────────────────────────────────────────────────────
// Non-root basePath ('/line-mcp')
// ───────────────────────────────────────────────────────────

describe('non-root basePath', () => {
  it('serves account selection submission under the configured base path', async () => {
    const params = routeParams();
    fs.writeFileSync(path.join(authStoreDir2, 'u-personal.json'), JSON.stringify({
      ...sampleAuthData,
      mid: 'u-personal',
      certificate: 'personal-cert',
      displayName: 'Personal LINE',
    }));
    fs.writeFileSync(path.join(authStoreDir2, 'u-work.json'), JSON.stringify({
      ...sampleAuthData,
      mid: 'u-work',
      certificate: 'work-cert',
      displayName: 'Work LINE',
    }));
    const selector = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));

    const selected = await postSelection(selectionSession, workChoice, base2, BASE_PATH_2);

    expect(selected.status).toBe(200);
    expect((await lastCreatedClient()).login).toHaveBeenCalledWith('work-cert');
  });

  it('serves protected-resource metadata at the well-known suffix location mirroring /mcp', async () => {
    const { status, body } = await req(`${base2}/.well-known/oauth-protected-resource${BASE_PATH_2}/mcp`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.resource).toBe(`${base2}${BASE_PATH_2}/mcp`);
    expect(b.authorization_servers).toEqual([`${base2}${BASE_PATH_2}`]);
  });

  it('does not serve protected-resource metadata at the unprefixed well-known location', async () => {
    const { status } = await req(`${base2}/.well-known/oauth-protected-resource`);
    expect(status).toBe(404);
  });

  it('does not serve protected-resource metadata at basePath alone, without the /mcp suffix', async () => {
    const { status } = await req(`${base2}/.well-known/oauth-protected-resource${BASE_PATH_2}`);
    expect(status).toBe(404);
  });

  it('serves AS metadata at the well-known suffix location with prefixed endpoints', async () => {
    const { status, body } = await req(`${base2}/.well-known/oauth-authorization-server${BASE_PATH_2}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.issuer).toBe(`${base2}${BASE_PATH_2}`);
    expect(b.authorization_endpoint).toBe(`${base2}${BASE_PATH_2}/authorize`);
    expect(b.token_endpoint).toBe(`${base2}${BASE_PATH_2}/token`);
    expect(b.registration_endpoint).toBe(`${base2}${BASE_PATH_2}/register`);
  });

  it('does not mount routes at the unprefixed AS well-known location', async () => {
    const { status } = await req(`${base2}/.well-known/oauth-authorization-server`);
    expect(status).toBe(404);
  });

  it('serves /authorize under the prefix, not at root', async () => {
    const params = routeParams();
    const prefixed = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
    expect(prefixed.status).not.toBe(400);

    const unprefixed = await req(`${base2}/authorize?${params}`);
    expect(unprefixed.status).toBe(404);
  });

  it('embeds the basePath in the authorize page OAuth context', async () => {
    const params = routeParams();
    const { body: html } = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
    const page = html as string;
    const context = page.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/)?.[1];
    expect(JSON.parse(context!)).toMatchObject({ basePath: BASE_PATH_2 });
    expect(page).toContain(`fetch(basePath + '/authorize/poll?sid='`);
  });

  it('serves /token under the prefix, not at root', async () => {
    const prefixed = await req(`${base2}${BASE_PATH_2}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'implicit' }),
    });
    expect(prefixed.status).toBe(400);

    const unprefixed = await req(`${base2}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'implicit' }),
    });
    expect(unprefixed.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────
// PUBLIC_URL / advertised endpoints
// ───────────────────────────────────────────────────────────

async function withConfiguredServer(
  options: { publicUrl?: string; basePath?: string; trustProxy?: boolean },
  run: (serverBase: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
  const localServer = http.createServer(app);
  await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-public-'));
  setupOAuthRoutes(app, port, options.basePath ?? '', store, undefined, {
    publicUrl: options.publicUrl,
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => localServer.close(() => resolve()));
    fs.rmSync(store, { recursive: true, force: true });
  }
}

function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function obtainCode(serverBase: string): Promise<string> {
  const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
  const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
  const pollBody = await waitForTerminalLogin(serverBase, sid);
  if (!pollBody.code) throw new Error(`Login did not issue a code: ${pollBody.error}`);
  return pollBody.code;
}

describe('PUBLIC_URL', () => {
  it('advertises the public issuer and every endpoint', async () => {
    await withConfiguredServer({ publicUrl: 'https://mcp.example.com', basePath: '/line-mcp' }, async serverBase => {
      const { status, body } = await req(`${serverBase}/.well-known/oauth-authorization-server/line-mcp`);
      expect(status).toBe(200);
      const meta = body as Record<string, unknown>;
      expect(meta.issuer).toBe('https://mcp.example.com/line-mcp');
      expect(meta.authorization_endpoint).toBe('https://mcp.example.com/line-mcp/authorize');
      expect(meta.token_endpoint).toBe('https://mcp.example.com/line-mcp/token');
      expect(meta.registration_endpoint).toBe('https://mcp.example.com/line-mcp/register');
    });
  });

  it('advertises the public protected resource', async () => {
    await withConfiguredServer({ publicUrl: 'https://mcp.example.com', basePath: '/line-mcp' }, async serverBase => {
      const { status, body } = await req(`${serverBase}/.well-known/oauth-protected-resource/line-mcp/mcp`);
      expect(status).toBe(200);
      const meta = body as Record<string, unknown>;
      expect(meta.resource).toBe('https://mcp.example.com/line-mcp/mcp');
      expect(meta.authorization_servers).toEqual(['https://mcp.example.com/line-mcp']);
    });
  });

  it('points the challenge at the public metadata URL', () => {
    const header = providerFor(3001, '/line-mcp', authStoreDir, undefined, {
      publicUrl: 'https://mcp.example.com',
    }).challenge(stubReq);
    expect(header).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/line-mcp/mcp"',
    );
  });

  it('keeps localhost behavior when PUBLIC_URL is omitted', () => {
    const header = providerFor(3001, '', authStoreDir).challenge(stubReq);
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource/mcp');
  });

  it('normalizes case and the default port', async () => {
    await withConfiguredServer({ publicUrl: 'https://MCP.Example.com:443/', basePath: '/line-mcp' }, async serverBase => {
      const { body } = await req(`${serverBase}/.well-known/oauth-authorization-server/line-mcp`);
      expect((body as Record<string, unknown>).issuer).toBe('https://mcp.example.com/line-mcp');
    });
  });
});

// ───────────────────────────────────────────────────────────
// redirect_uri policy enforcement
// ───────────────────────────────────────────────────────────

async function withPolicyServer(
  policyRaw: string | undefined,
  run: (serverBase: string, store: string) => Promise<void>,
): Promise<void> {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-policy-'));
  try {
    await withOAuthServer(store, serverBase => run(serverBase, store), {
      redirectPolicy: createRedirectPolicy(policyRaw),
    });
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
}

function paramsWithRedirect(redirectUri: string): URLSearchParams {
  const params = new URLSearchParams(routeParams());
  params.set('redirect_uri', redirectUri);
  return params;
}

describe('/authorize redirect policy', () => {
  const allowlist = 'https://client.example.com/oauth/callback';

  it('accepts an allowed https redirect, starts LINE login, and names the destination', async () => {
    const { LineClient, __createdClients } = await import('@raidenyn/line-client') as unknown as {
      LineClient: ReturnType<typeof vi.fn>;
      __createdClients: unknown[];
    };
    LineClient.mockClear();
    __createdClients.length = 0;

    await withPolicyServer(allowlist, async serverBase => {
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect(allowlist)}`);
      expect(response.status).toBe(200);
      const html = bodyAsHtml(response);
      expect(html).toContain('You will be returned to');
      expect(html).toContain('client.example.com');
      expect(__createdClients).toHaveLength(1);
    });
  });

  it('rejects a disallowed https redirect without starting LINE login', async () => {
    const { LineClient } = await import('@raidenyn/line-client') as unknown as {
      LineClient: ReturnType<typeof vi.fn>;
    };
    LineClient.mockClear();

    await withPolicyServer(allowlist, async serverBase => {
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect('https://attacker.example/cb')}`);
      expect(response.status).toBe(400);
      expect(bodyAsHtml(response)).toContain('OAUTH_ALLOWED_REDIRECT_URIS');
      expect(LineClient).not.toHaveBeenCalled();
    });
  });

  it('keeps loopback allowed when an allowlist is configured', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect('http://127.0.0.1:53682/callback')}`);
      expect(response.status).not.toBe(400);
    });
  });

  it('still rejects non-http schemes even when loopback-shaped', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect('javascript://localhost/evil')}`);
      expect(response.status).toBe(400);
    });
  });

  it('names both loopback and the allowlist variable in the rejection', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect('https://attacker.example/cb')}`);
      const html = bodyAsHtml(response);
      expect(html).toContain('loopback');
      expect(html).toContain('OAUTH_ALLOWED_REDIRECT_URIS');
    });
  });

  it('shows the destination on the account selector', async () => {
    await withPolicyServer(allowlist, async (serverBase, store) => {
      fs.writeFileSync(path.join(store, 'u-personal.json'), JSON.stringify({
        ...sampleAuthData, mid: 'u-personal', certificate: 'personal-cert', displayName: 'Personal LINE',
      }));
      fs.writeFileSync(path.join(store, 'u-work.json'), JSON.stringify({
        ...sampleAuthData, mid: 'u-work', certificate: 'work-cert', displayName: 'Work LINE',
      }));
      const response = await req(`${serverBase}/authorize?${paramsWithRedirect(allowlist)}`);
      expect(response.status).toBe(200);
      const html = bodyAsHtml(response);
      expect(html).toContain('You will be returned to');
      expect(html).toContain('client.example.com');
    });
  });
});

describe('/register redirect policy', () => {
  const allowlist = 'https://client.example.com';

  const register = (serverBase: string, body: unknown) => req(`${serverBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('accepts an allowed URI and echoes it', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const { status, body } = await register(serverBase, {
        redirect_uris: ['https://client.example.com/cb'],
      });
      expect(status).toBe(201);
      expect((body as Record<string, unknown>).redirect_uris).toEqual(['https://client.example.com/cb']);
    });
  });

  it('rejects a disallowed URI with invalid_redirect_uri', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const { status, body } = await register(serverBase, {
        redirect_uris: ['https://attacker.example/cb'],
      });
      expect(status).toBe(400);
      expect((body as Record<string, unknown>).error).toBe('invalid_redirect_uri');
      expect((body as Record<string, unknown>).client_id).toBeUndefined();
    });
  });

  it('rejects a mixed list as a whole', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const { status } = await register(serverBase, {
        redirect_uris: ['https://client.example.com/cb', 'https://attacker.example/cb'],
      });
      expect(status).toBe(400);
    });
  });

  it.each([[{ redirect_uris: 'https://client.example.com/cb' }], [{ redirect_uris: null }], [{ redirect_uris: [123] }]])(
    'rejects malformed redirect_uris %j',
    async body => {
      await withPolicyServer(allowlist, async serverBase => {
        const response = await register(serverBase, body);
        expect(response.status).toBe(400);
        expect((response.body as Record<string, unknown>).error).toBe('invalid_redirect_uri');
      });
    },
  );

  it('still accepts a registration without redirect_uris', async () => {
    await withPolicyServer(allowlist, async serverBase => {
      const { status, body } = await register(serverBase, { client_name: 'no-callbacks' });
      expect(status).toBe(201);
      expect((body as Record<string, unknown>).client_id).toBeTypeOf('string');
    });
  });

  it('rejects an https callback under the default loopback-only policy', async () => {
    await withPolicyServer(undefined, async serverBase => {
      const { status } = await register(serverBase, {
        redirect_uris: ['https://client.example.com/oauth/callback'],
      });
      expect(status).toBe(400);
    });
  });
});

describe('/token redirect_uri and client_id checks', () => {
  const postToken = (body: Record<string, string>) => req(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('accepts matching redirect_uri and client_id', async () => {
    const code = await obtainCode(base);
    const { status } = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'verifier123',
      redirect_uri: 'http://localhost:8765/callback',
      client_id: 'claude-code',
    });
    expect(status).toBe(200);
  });

  it('rejects a differing redirect_uri with invalid_grant', async () => {
    const code = await obtainCode(base);
    const { status, body } = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'verifier123',
      redirect_uri: 'https://other.example/cb',
    });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_grant');
  });

  it('rejects a differing client_id with invalid_grant', async () => {
    const code = await obtainCode(base);
    const { status, body } = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'verifier123',
      client_id: 'someone-else',
    });
    expect(status).toBe(400);
    expect((body as Record<string, string>).error).toBe('invalid_grant');
  });

  it('accepts a request that omits both', async () => {
    const code = await obtainCode(base);
    const { status } = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'verifier123',
    });
    expect(status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────
// Host independence / forwarded headers
// ───────────────────────────────────────────────────────────

describe('Host independence', () => {
  it.each([false, true])('ignores forwarded headers in metadata (trust proxy: %s)', async trustProxy => {
    await withConfiguredServer(
      { publicUrl: 'https://mcp.example.com', basePath: '/line-mcp', trustProxy },
      async serverBase => {
        const forwarded = {
          host: 'internal:3000',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        };
        for (const path of [
          '/.well-known/oauth-authorization-server/line-mcp',
          '/.well-known/oauth-protected-resource/line-mcp/mcp',
        ]) {
          const plain = await rawRequest(`${serverBase}${path}`);
          const withHeaders = await rawRequest(`${serverBase}${path}`, { headers: forwarded });
          expect(withHeaders.status).toBe(200);
          expect(withHeaders.body).toBe(plain.body);
        }
      },
    );
  });

  it('embeds no forwarded or internal host in the authorize page', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-forwarded-'));
    try {
      await withOAuthServer(store, async serverBase => {
        const params = new URLSearchParams(routeParams());
        params.set('redirect_uri', 'https://client.example.com/cb');
        const response = await rawRequest(`${serverBase}/authorize?${params}`, {
          headers: {
            host: 'internal:3000',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'http',
          },
        });
        expect(response.status).toBe(200);
        expect(response.body).not.toContain('evil.example');
        expect(response.body).not.toContain('internal:3000');
      }, { publicUrl: 'https://mcp.example.com', redirectPolicy: createRedirectPolicy('https://client.example.com') });
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('redeems a code at /token and calls /mcp through different Host headers', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-cross-host-'));
    const localServer = http.createServer();
    try {
      const provider = providerFor(0, '', store);
      const host = createMcpHost({
        name: 'cross-host',
        version: '0.0.0',
        basePath: '',
        authProvider: provider,
        registrations: [],
      });
      localServer.on('request', host.app);
      await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
      const port = (localServer.address() as { port: number }).port;
      const origin = `http://127.0.0.1:${port}`;

      const authorize = await rawRequest(`${origin}/authorize?${routeParams()}`, {
        headers: { host: 'mcp.example.com' },
      });
      expect(authorize.status).toBe(200);
      const sid = sessionIdFromQrPage(authorize.body);
      const pollBody = await waitForTerminalLogin(origin, sid);
      expect(pollBody.code).toBeTypeOf('string');

      const tokenResponse = await rawRequest(`${origin}/token`, {
        method: 'POST',
        headers: { host: 'internal:3000', 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: pollBody.code,
          code_verifier: 'verifier123',
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const accessToken = (JSON.parse(tokenResponse.body) as { access_token: string }).access_token;

      const mcpResponse = await rawRequest(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          host: 'third.example',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'cross-host', version: '0.0.0' },
          },
        }),
      });
      expect(mcpResponse.status).not.toBe(401);
    } finally {
      await new Promise<void>(resolve => localServer.close(() => resolve()));
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
