import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import * as http from 'http';
import type { AuthData } from '@raidenyn/line-client';
import type { Request as ExpressRequest } from 'express';
import {
  LineAuthProvider,
  publicEndpointConfig,
  type PublicEndpointConfig,
} from './line-auth-provider';
import { FileCredentialStore, persistAuthData } from './credential-store';

// Guard against any accidental real LINE network use in the refresh round-trip.
vi.mock('@raidenyn/line-client', async importOriginal => {
  const original = await importOriginal<typeof import('@raidenyn/line-client')>();
  const LineClient = vi.fn().mockImplementation(function LineClient() {
    return { login: vi.fn(), waitForPin: vi.fn(), waitForCompletion: vi.fn(), getCompletedAuth: vi.fn() };
  });
  return { ...original, LineClient };
});

const SECRET = 'provider-test-secret';

const AUTH: AuthData = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  certificate: 'cert-1',
  mid: 'u1234567890test',
  wrappedNonce: 'nonce-1',
  kdfParameter1: 'kdf1-1',
  kdfParameter2: 'kdf2-1',
};

function bearer(token: string): ExpressRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as ExpressRequest;
}

function decodeClaims(token: string): Record<string, unknown> {
  const data = token.slice(0, token.lastIndexOf('.'));
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function providerWith(endpoints: PublicEndpointConfig, authStoreDir: string): LineAuthProvider {
  return new LineAuthProvider({
    secret: SECRET,
    endpoints,
    credentialStore: new FileCredentialStore(authStoreDir),
    authStoreDir,
  });
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-provider-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────
// Canonical endpoint configuration (one injected source of truth)
// ───────────────────────────────────────────────────────────

describe('canonical endpoints derive from one injected PublicEndpointConfig', () => {
  const endpoints: PublicEndpointConfig = {
    issuer: new URL('http://localhost:9999/base'),
    resource: new URL('http://localhost:9999/base/mcp'),
    basePath: '/base',
    requiredScopes: ['line'],
  };

  it('token claims carry the injected issuer and audience', () => {
    const provider = providerWith(endpoints, dir);
    const pair = (provider as unknown as {
      issueTokens(a: AuthData): { access_token: string; refresh_token: string };
    }).issueTokens(AUTH);
    const claims = decodeClaims(pair.access_token);
    expect(claims.issuer).toBe('http://localhost:9999/base');
    expect(claims.audience).toBe('http://localhost:9999/base/mcp');
  });

  it('challenge points at the resource metadata URL derived from the config origin + basePath', () => {
    const provider = providerWith(endpoints, dir);
    const header = provider.challenge({ headers: {} } as unknown as ExpressRequest);
    expect(header).toContain('http://localhost:9999/.well-known/oauth-protected-resource/base/mcp');
  });

  it('metadata endpoints report the injected issuer/resource', async () => {
    const provider = providerWith(endpoints, dir);
    const app = express();
    app.use(express.json());
    provider.mountRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const asMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server/base`)
        .then(r => r.json());
      expect(asMeta.issuer).toBe('http://localhost:9999/base');
      expect(asMeta.authorization_endpoint).toBe('http://localhost:9999/base/authorize');

      const prMeta = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/base/mcp`)
        .then(r => r.json());
      expect(prMeta.resource).toBe('http://localhost:9999/base/mcp');
      expect(prMeta.authorization_servers).toEqual(['http://localhost:9999/base']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

// ───────────────────────────────────────────────────────────
// authenticate / resolveCredentials
// ───────────────────────────────────────────────────────────

describe('authenticate', () => {
  it('returns null with no bearer header', async () => {
    const provider = providerWith(publicEndpointConfig(3000, ''), dir);
    expect(await provider.authenticate({ headers: {} } as unknown as ExpressRequest)).toBeNull();
  });

  it('returns null for a garbage token', async () => {
    const provider = providerWith(publicEndpointConfig(3000, ''), dir);
    expect(await provider.authenticate(bearer('notavalidtoken'))).toBeNull();
  });

  it('accepts a seeded test-bypass token and yields a MID principal', async () => {
    const provider = providerWith(publicEndpointConfig(3000, ''), dir);
    provider.seedTestToken('test-bypass-token', AUTH);
    const principal = await provider.authenticate(bearer('test-bypass-token'));
    expect(principal).not.toBeNull();
    expect(principal!.mid).toBe(AUTH.mid);
    expect(principal!.subject).toBe(principal!.mid);
    // resolveCredentials finds the seeded credential the bypass primed.
    expect((await provider.resolveCredentials(principal!))?.accessToken).toBe(AUTH.accessToken);
  });

  it('rejects a token signed with a different secret', async () => {
    const issuer = providerWith(publicEndpointConfig(3000, ''), dir);
    const other = new LineAuthProvider({
      secret: 'a-totally-different-secret',
      endpoints: publicEndpointConfig(3000, ''),
      credentialStore: new FileCredentialStore(dir),
      authStoreDir: dir,
    });
    const foreign = (other as unknown as {
      issueTokens(a: AuthData): { access_token: string };
    }).issueTokens(AUTH).access_token;
    expect(await issuer.authenticate(bearer(foreign))).toBeNull();
  });
});

describe('resolveCredentials', () => {
  it('returns null when subject and mid disagree', async () => {
    const provider = providerWith(publicEndpointConfig(3000, ''), dir);
    persistAuthData(AUTH, 'Personal LINE', dir);
    const bad = { provider: 'line' as const, subject: 'u-a', mid: 'u-b', scopes: ['line'] };
    expect(await provider.resolveCredentials(bad)).toBeNull();
  });

  it('prefers the in-memory freshest snapshot over disk', async () => {
    const provider = providerWith(publicEndpointConfig(3000, ''), dir);
    persistAuthData(AUTH, 'Personal LINE', dir);
    const fresher: AuthData = { ...AUTH, accessToken: 'access-rotated' };
    provider.recordRefreshedAuth(fresher);
    const resolved = await provider.resolveCredentials({
      provider: 'line', subject: AUTH.mid, mid: AUTH.mid, scopes: ['line'],
    });
    expect(resolved?.accessToken).toBe('access-rotated');
  });

  it('never resolves one provider\'s recorded credential from another provider on a different dataRoot (same MID)', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-provider-other-'));
    try {
      const providerA = providerWith(publicEndpointConfig(3000, ''), dir);
      const providerB = providerWith(publicEndpointConfig(3000, ''), otherDir);
      providerA.recordRefreshedAuth({ ...AUTH, accessToken: 'root-a-access' });
      providerB.recordRefreshedAuth({ ...AUTH, accessToken: 'root-b-access' });

      const principal = { provider: 'line' as const, subject: AUTH.mid, mid: AUTH.mid, scopes: ['line'] };
      const resolvedFromA = await providerA.resolveCredentials(principal);
      const resolvedFromB = await providerB.resolveCredentials(principal);

      expect(resolvedFromA?.accessToken).toBe('root-a-access');
      expect(resolvedFromB?.accessToken).toBe('root-b-access');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('prefers a fresher snapshot installed by recordRefreshedAuth during a pending disk load', async () => {
    // Regression: freshestCredential awaits credentialStore.load(mid); a
    // concurrent recordRefreshedAuth() during that await installs a fresher
    // snapshot. The load resolving with a STALE disk value must NOT overwrite
    // the in-memory fresher value. (The slowStore captures a stale snapshot
    // at construction so recordRefreshedAuth's own persist does not feed back
    // into the load result.)
    persistAuthData(AUTH, 'Personal LINE', dir);
    const staleFromDisk: AuthData = { ...AUTH };
    let releaseLoad!: () => void;
    const loadHeld = new Promise<void>(resolve => { releaseLoad = resolve; });
    const slowStore: import('./credential-store').CredentialStore = {
      async load() {
        await loadHeld;
        return staleFromDisk;
      },
      async list() { return []; },
      async saveAtomic() { /* unused */ },
    };
    const provider = new LineAuthProvider({
      secret: SECRET,
      endpoints: publicEndpointConfig(3000, ''),
      credentialStore: slowStore,
      authStoreDir: dir,
    });
    const principal = { provider: 'line' as const, subject: AUTH.mid, mid: AUTH.mid, scopes: ['line'] };
    const pending = provider.resolveCredentials(principal);
    // While the disk load is still pending, install a fresher snapshot.
    const fresher: AuthData = { ...AUTH, accessToken: 'access-rotated-during-load' };
    provider.recordRefreshedAuth(fresher);
    releaseLoad();
    const resolved = await pending;
    expect(resolved?.accessToken).toBe('access-rotated-during-load');
  });

  it('returns the snapshot installed by recordRefreshedAuth during a pending disk load that ultimately finds no record', async () => {
    // Same TOCTOU, but the disk load returns null — without the re-check,
    // resolveCredentials would return null despite the fresh snapshot that
    // arrived mid-load.
    let releaseLoad!: () => void;
    const loadHeld = new Promise<void>(resolve => { releaseLoad = resolve; });
    const slowStore: import('./credential-store').CredentialStore = {
      async load() {
        await loadHeld;
        return null;
      },
      async list() { return []; },
      async saveAtomic() { /* unused */ },
    };
    const provider = new LineAuthProvider({
      secret: SECRET,
      endpoints: publicEndpointConfig(3000, ''),
      credentialStore: slowStore,
      authStoreDir: dir,
    });
    const principal = { provider: 'line' as const, subject: AUTH.mid, mid: AUTH.mid, scopes: ['line'] };
    const pending = provider.resolveCredentials(principal);
    const fresher: AuthData = { ...AUTH, accessToken: 'access-fresh-no-disk' };
    provider.recordRefreshedAuth(fresher);
    releaseLoad();
    const resolved = await pending;
    expect(resolved?.accessToken).toBe('access-fresh-no-disk');
  });
});

// ───────────────────────────────────────────────────────────
// Refresh grant after restart (no re-authorization)
// ───────────────────────────────────────────────────────────

describe('refresh grant survives a restart using persisted credentials', () => {
  it('reissues from a persisted account without invoking LINE login', async () => {
    // Process 1: persist fresh credentials and mint a refresh token.
    const provider1 = providerWith(publicEndpointConfig(3000, ''), dir);
    persistAuthData(AUTH, 'Personal LINE', dir);
    const refreshToken = (provider1 as unknown as {
      issueTokens(a: AuthData): { refresh_token: string };
    }).issueTokens(AUTH).refresh_token;

    // Process 2 (restart): brand-new provider, empty in-memory cache.
    const provider2 = providerWith(publicEndpointConfig(3000, ''), dir);
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    provider2.mountRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const { LineClient } = await import('@raidenyn/line-client');
    vi.mocked(LineClient).mockClear();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { access_token: string };
      const principal = await provider2.authenticate(bearer(body.access_token));
      expect(principal?.mid).toBe(AUTH.mid);
      expect(LineClient).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
