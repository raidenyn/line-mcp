import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import express, { type Express, type Request } from 'express';
import * as http from 'http';
import * as crypto from 'crypto';
import { LineAuthProvider, publicEndpointConfig } from './line-auth-provider';
import { FileCredentialStore, latestAuthData } from './credential-store';

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

function providerFor(port: number, basePath: string, authStoreDir: string): LineAuthProvider {
  return new LineAuthProvider({
    secret: TEST_SECRET,
    endpoints: publicEndpointConfig(port, basePath),
    credentialStore: new FileCredentialStore(authStoreDir),
    authStoreDir,
  });
}

// Adapter mirroring the old setupOAuthRoutes(app, port, basePath, authStoreDir)
// signature the router tests were written against.
function setupOAuthRoutes(app: Express, port: number, basePath: string, authStoreDir: string): LineAuthProvider {
  const provider = providerFor(port, basePath, authStoreDir);
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

async function withOAuthServer(authStorePath: string, run: (serverBase: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const localServer = http.createServer(app);
  await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  setupOAuthRoutes(app, port, '', authStorePath);
  try {
    await run(`http://127.0.0.1:${port}`);
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
  fs.rmSync(authStoreDir, { recursive: true, force: true });
  fs.rmSync(authStoreDir2, { recursive: true, force: true });
}));

beforeEach(async () => {
  latestAuthData.clear();
  fs.rmSync(authStoreDir, { recursive: true, force: true });
  fs.mkdirSync(authStoreDir, { recursive: true });
  fs.rmSync(authStoreDir2, { recursive: true, force: true });
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
  it('does not issue a code or update memory when durable persistence fails', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-blocked-'));
    const blockedAuthPath = path.join(parent, 'auth');
    fs.writeFileSync(blockedAuthPath, 'not a directory');
    latestAuthData.clear();

    await withOAuthServer(blockedAuthPath, async serverBase => {
      const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
      const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
      const pollBody = await waitForTerminalLogin(serverBase, sid);

      expect(pollBody.phase).toBe('failed');
      expect(pollBody.code).toBeUndefined();
      expect(latestAuthData.has('umid')).toBe(false);
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
