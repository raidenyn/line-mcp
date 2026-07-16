import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AuthData } from '@raidenyn/line-client';
import type { Request as ExpressRequest } from 'express';
import {
  LineAuthProvider,
  publicEndpointConfig,
} from './line-auth-provider';
import {
  FileCredentialStore,
  latestAuthData,
  persistAuthData,
  recordRefreshedAuth,
  loadStoredAuthRecord,
} from './credential-store';

const SECRET = 'shared-signing-secret-for-transition-tests';

const AUTH: AuthData = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-abc',
  certificate: 'cert-abc',
  mid: 'u1234567890abcdef',
  wrappedNonce: 'nonce-abc',
  kdfParameter1: 'kdf1-abc',
  kdfParameter2: 'kdf2-abc',
};

// Reproduce the OLD token primitive exactly: base64url(json).base64url(hmac).
// Critically signed with the SAME secret the new provider uses, so rejection is
// proven by the schema check, not by a mismatched key.
function legacySign(payload: object, secret = SECRET): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function decodeClaims(token: string): Record<string, unknown> {
  const data = token.slice(0, token.lastIndexOf('.'));
  return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function bearerRequest(token: string): ExpressRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as ExpressRequest;
}

// Provider under test, plus the /token router refresh path exercised through a
// tiny reflection of the router's grant handling (verify + reload + reissue).
function makeProvider(authStoreDir: string): LineAuthProvider {
  return new LineAuthProvider({
    secret: SECRET,
    endpoints: publicEndpointConfig(3000, ''),
    credentialStore: new FileCredentialStore(authStoreDir),
    authStoreDir,
  });
}

// The refresh grant is only reachable through the mounted /token route, which
// calls the provider's private issueFromRefresh via a bound closure. We reach
// it here through mountRoutes by capturing the dep the router receives.
function refreshHandler(provider: LineAuthProvider): (token: string) => Promise<unknown> {
  let captured: ((token: string) => Promise<unknown>) | undefined;
  const fakeApp = {
    get() { /* ignore */ },
    post(pathArg: string, handler: unknown) {
      if (pathArg.endsWith('/token')) {
        // The /token handler reads req.body and calls deps.issueFromRefresh.
        captured = async (token: string) => {
          const req = { body: { grant_type: 'refresh_token', refresh_token: token } };
          let statusCode = 200;
          const res = {
            status(code: number) { statusCode = code; return res; },
            json(payload: unknown) { return { statusCode, payload }; },
          };
          return (handler as (r: unknown, s: unknown) => Promise<unknown>)(req, res)
            .then(() => ({ statusCode }));
        };
      }
    },
  };
  provider.mountRoutes(fakeApp as never);
  if (!captured) throw new Error('token route not mounted');
  return captured;
}

describe('breaking token cutover', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-transition-'));
    latestAuthData.clear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    latestAuthData.clear();
  });

  describe('legacy token rejection (same secret)', () => {
    it('rejects a legacy access token { authData, expiresAt } on the bearer path', async () => {
      const provider = makeProvider(dir);
      const legacyAccess = legacySign({ authData: AUTH, expiresAt: Date.now() + 86_400_000 });
      const principal = await provider.authenticate(bearerRequest(legacyAccess));
      expect(principal).toBeNull();
    });

    it('rejects a legacy refresh token { authData } on the bearer path', async () => {
      const provider = makeProvider(dir);
      const legacyRefresh = legacySign({ authData: AUTH });
      const principal = await provider.authenticate(bearerRequest(legacyRefresh));
      expect(principal).toBeNull();
    });

    it('rejects a legacy refresh token { authData } on the refresh grant path', async () => {
      persistAuthData(AUTH, 'Personal LINE', dir); // account still exists on disk
      const provider = makeProvider(dir);
      const refresh = refreshHandler(provider);
      const legacyRefresh = legacySign({ authData: AUTH });
      const result = (await refresh(legacyRefresh)) as { statusCode: number };
      expect(result.statusCode).toBe(400);
    });

    it('rejects a legacy access token { authData, expiresAt } on the refresh grant path', async () => {
      persistAuthData(AUTH, 'Personal LINE', dir);
      const provider = makeProvider(dir);
      const refresh = refreshHandler(provider);
      const legacyAccess = legacySign({ authData: AUTH, expiresAt: Date.now() + 86_400_000 });
      const result = (await refresh(legacyAccess)) as { statusCode: number };
      expect(result.statusCode).toBe(400);
    });
  });

  describe('new claims carry MID identity only', () => {
    it('embeds no LINE credential material in access or refresh tokens', () => {
      const provider = makeProvider(dir);
      const pair = (provider as unknown as {
        issueTokens(a: AuthData): { access_token: string; refresh_token: string };
      }).issueTokens(AUTH);

      for (const token of [pair.access_token, pair.refresh_token]) {
        const claims = decodeClaims(token);
        expect(claims.subject).toBe(AUTH.mid);
        // MID-only: none of the LINE secrets appear anywhere in the claims.
        const serialized = JSON.stringify(claims);
        expect(serialized).not.toContain(AUTH.accessToken);
        expect(serialized).not.toContain(AUTH.refreshToken);
        expect(serialized).not.toContain(AUTH.certificate);
        expect(serialized).not.toContain(AUTH.wrappedNonce);
        expect(serialized).not.toContain(AUTH.kdfParameter1);
        expect(serialized).not.toContain(AUTH.kdfParameter2);
        expect(claims).not.toHaveProperty('authData');
        expect(claims).not.toHaveProperty('accessToken');
        expect(claims).not.toHaveProperty('certificate');
      }
    });

    it('mints a new access token that authenticates back to its MID principal', async () => {
      const provider = makeProvider(dir);
      const pair = (provider as unknown as {
        issueTokens(a: AuthData): { access_token: string; refresh_token: string };
      }).issueTokens(AUTH);
      const principal = await provider.authenticate(bearerRequest(pair.access_token));
      expect(principal).not.toBeNull();
      expect(principal!.mid).toBe(AUTH.mid);
      expect(principal!.subject).toBe(AUTH.mid);
      expect(principal!.subject).toBe(principal!.mid);
      expect(principal!.provider).toBe('line');
    });
  });

  describe('credential freshness', () => {
    it('loads credentials by MID after a restart (empty in-memory cache)', async () => {
      persistAuthData(AUTH, 'Personal LINE', dir);
      latestAuthData.clear(); // simulate a fresh process
      const provider = makeProvider(dir);
      const resolved = await provider.resolveCredentials({
        provider: 'line', subject: AUTH.mid, mid: AUTH.mid, scopes: ['line'],
      });
      expect(resolved?.accessToken).toBe(AUTH.accessToken);
    });

    it('returns null (reauthorization required) when no record exists for the MID', async () => {
      const provider = makeProvider(dir);
      const resolved = await provider.resolveCredentials({
        provider: 'line', subject: 'u-missing', mid: 'u-missing', scopes: ['line'],
      });
      expect(resolved).toBeNull();
    });

    it('refuses the refresh grant when the account has no stored record', async () => {
      // A syntactically valid, signature-valid, MID-only refresh token whose
      // account is not on disk must not mint new tokens.
      const provider = makeProvider(dir);
      const pair = (provider as unknown as {
        issueTokens(a: AuthData): { access_token: string; refresh_token: string };
      }).issueTokens(AUTH);
      latestAuthData.clear(); // account gone from memory and never persisted
      const refresh = refreshHandler(provider);
      const result = (await refresh(pair.refresh_token)) as { statusCode: number };
      expect(result.statusCode).toBe(400);
    });

    it('persists the exact refreshed snapshot and updates memory first', () => {
      persistAuthData(AUTH, 'Personal LINE', dir);
      latestAuthData.clear();
      const fresher: AuthData = { ...AUTH, accessToken: 'access-rotated', refreshToken: 'refresh-rotated' };

      recordRefreshedAuth(fresher, dir);

      expect(latestAuthData.get(AUTH.mid)).toEqual(fresher);
      expect(loadStoredAuthRecord(AUTH.mid, dir)).toEqual({ ...fresher, displayName: 'Personal LINE' });
    });

    it('preserves the account display name across a credential refresh', () => {
      persistAuthData(AUTH, 'Personal LINE', dir);
      const fresher: AuthData = { ...AUTH, accessToken: 'access-rotated' };
      recordRefreshedAuth(fresher, dir);
      expect(loadStoredAuthRecord(AUTH.mid, dir)?.displayName).toBe('Personal LINE');
    });

    it('keeps a single in-memory entry per MID across separate auth object copies', () => {
      const copyA: AuthData = { ...AUTH, accessToken: 'copy-a' };
      const copyB: AuthData = { ...AUTH, accessToken: 'copy-b' };
      recordRefreshedAuth(copyA, dir);
      recordRefreshedAuth(copyB, dir);
      // Same MID → one keyed entry, last write wins (single-flight coalescing).
      expect(latestAuthData.size).toBe(1);
      expect(latestAuthData.get(AUTH.mid)?.accessToken).toBe('copy-b');
    });

    it('refreshes independent MIDs without cross-contamination', () => {
      const other: AuthData = { ...AUTH, mid: 'u-otheraccount', accessToken: 'other-access' };
      recordRefreshedAuth(AUTH, dir);
      recordRefreshedAuth(other, dir);
      expect(latestAuthData.size).toBe(2);
      expect(latestAuthData.get(AUTH.mid)?.accessToken).toBe(AUTH.accessToken);
      expect(latestAuthData.get('u-otheraccount')?.accessToken).toBe('other-access');
    });

    it('keeps the refreshed snapshot in memory when disk persistence fails', () => {
      const blocked = path.join(dir, 'blocked-file');
      fs.writeFileSync(blocked, 'not a directory');
      const fresher: AuthData = { ...AUTH, accessToken: 'access-rotated' };
      // Non-fatal policy: memory updated, disk write swallowed, no throw.
      expect(() => recordRefreshedAuth(fresher, blocked)).not.toThrow();
      expect(latestAuthData.get(AUTH.mid)).toEqual(fresher);
    });
  });
});
