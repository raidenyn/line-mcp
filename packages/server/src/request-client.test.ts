import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as lineMcpModule from '@raidenyn/line-mcp';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';
import type { AuthData } from '@raidenyn/line-client';
import type { LinePrincipal } from '@raidenyn/line-mcp';
import { createServerRequestClientFactory } from './request-client';

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-request-client-'));
}

function authDataFor(mid: string): AuthData {
  return {
    accessToken: `access-${mid}`, refreshToken: `refresh-${mid}`, certificate: `cert-${mid}`,
    mid, wrappedNonce: `nonce-${mid}`, kdfParameter1: 'k1', kdfParameter2: 'k2',
  };
}

function principalFor(mid: string): LinePrincipal {
  return { provider: 'line', subject: mid, mid, scopes: [] };
}

describe('createServerRequestClientFactory — plumbing (Step 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes cache and resolveCredentials straight through to @raidenyn/line-mcp\'s createRequestClientFactory unmodified', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    const resolveCredentials = vi.fn(async () => authDataFor('u-owner'));
    const factorySpy = vi.spyOn(lineMcpModule, 'createRequestClientFactory');

    createServerRequestClientFactory({ cache, resolveCredentials, authStoreDir: '/tmp/does-not-matter' });

    expect(factorySpy).toHaveBeenCalledTimes(1);
    const passedOptions = factorySpy.mock.calls[0][0];
    // Exact passthrough — no extra wrapping layer around cache/resolveCredentials.
    expect(passedOptions.cache).toBe(cache);
    expect(passedOptions.resolveCredentials).toBe(resolveCredentials);
    expect(typeof passedOptions.onAuthRefreshed).toBe('function');
    cache.close();
  });

  it('wires onAuthRefreshed to persist the EXACT refreshed snapshot via recordRefreshedAuth(fresh, authStoreDir)', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    const authStoreDir = mkdtemp();
    try {
      const recordSpy = vi.spyOn(lineMcpModule, 'recordRefreshedAuth').mockImplementation(() => {});
      const factorySpy = vi.spyOn(lineMcpModule, 'createRequestClientFactory');

      createServerRequestClientFactory({
        cache,
        resolveCredentials: async () => authDataFor('u-owner'),
        authStoreDir,
      });

      const onAuthRefreshed = factorySpy.mock.calls[0][0].onAuthRefreshed!;
      const freshSnapshot = authDataFor('u-owner');
      // Immutable — object identity is what "the exact snapshot" means here.
      onAuthRefreshed(freshSnapshot);

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(freshSnapshot, authStoreDir);
    } finally {
      cache.close();
      fs.rmSync(authStoreDir, { recursive: true, force: true });
    }
  });
});

describe('createServerRequestClientFactory — real behavior (no mocks, no network)', () => {
  let dbPath: string;
  let cache: SqliteMessageCache;

  beforeEach(() => {
    dbPath = path.join(mkdtemp(), 'messages.db');
    cache = new SqliteMessageCache({ dbPath });
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('loads credentials by the exact principal (MID-keyed)', async () => {
    const resolveCredentials = vi.fn(async (p: LinePrincipal) => authDataFor(p.mid));
    const factory = createServerRequestClientFactory({ cache, resolveCredentials, authStoreDir: mkdtemp() });

    const principal = principalFor('u-alice');
    await factory(principal);

    expect(resolveCredentials).toHaveBeenCalledExactlyOnceWith(principal);
  });

  it('returns an UNCACHED api client distinct from the cache-bound messages reader', async () => {
    const factory = createServerRequestClientFactory({
      cache,
      resolveCredentials: async (p) => authDataFor(p.mid),
      authStoreDir: mkdtemp(),
    });

    const client = await factory(principalFor('u-alice'));

    // `messages` is a wrapper object built by withMessageCache(), never the
    // same reference (or the same bound methods) as the raw `api` surface —
    // this is the "uncached api client" + "cache-bound messages reader" split
    // Step 2 requires.
    expect(client.messages).not.toBe(client.api);
    expect(client.messages.getMessages).not.toBe(client.api.getMessages);
    expect(client.messages.getMessagesInRange).not.toBe(client.api.getMessagesInRange);
  });

  it('constructs an independent client per call, scoped to that call\'s principal', async () => {
    // This factory always builds a fresh createLineClient()/withMessageCache()
    // pair per call rather than memoizing by mid — proven here by reference
    // inequality across two calls for two different principals. Calling
    // `.messages.getMessages()` would exercise the real cache-binding-by-mid
    // behavior too, but that requires invoking the underlying (real, here
    // uninjectable) LINE API client, which would attempt a genuine network
    // call — that exact behavior (two principals sharing chat_mid/message_id
    // getting isolated results through this SAME production code path) is
    // proven end-to-end, network-free, in trusted-tenant.test.ts via the
    // composed server's fake LINE API test double.
    const factory = createServerRequestClientFactory({
      cache,
      resolveCredentials: async (p) => authDataFor(p.mid),
      authStoreDir: mkdtemp(),
    });

    const aliceClient = await factory(principalFor('u-alice'));
    const bobClient = await factory(principalFor('u-bob'));

    expect(aliceClient).not.toBe(bobClient);
    expect(aliceClient.api).not.toBe(bobClient.api);
    expect(aliceClient.messages).not.toBe(bobClient.messages);
  });
});
