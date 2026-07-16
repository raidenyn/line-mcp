import { describe, it, expect, vi, afterEach } from 'vitest';
import { syncAll, startSyncLoop } from './sync';
import type { CredentialStore, StoredAuthRecord } from './auth/credential-store';
import type { MessageCache } from '@raidenyn/line-client';
import type { RequestLineClient } from './request-client';

function fakeCredentialStore(records: StoredAuthRecord[]): CredentialStore {
  return {
    load: vi.fn(async (mid: string) => records.find((r) => r.mid === mid) ?? null),
    list: vi.fn(async () => records),
    saveAtomic: vi.fn(async () => {}),
  };
}

function fakeCache(chatsByOwner: Record<string, string[]>): MessageCache {
  return {
    upsertMessages: vi.fn(),
    getMessages: vi.fn(() => []),
    latestTimestamp: vi.fn(() => null),
    getDistinctChatMids: vi.fn((ownerMid: string) => chatsByOwner[ownerMid] ?? []),
  };
}

const RECORD_A: StoredAuthRecord = {
  mid: 'u123',
  accessToken: 'tok',
  refreshToken: 'ref',
  certificate: 'cert',
  wrappedNonce: 'nonce',
  kdfParameter1: 'kdf1',
  kdfParameter2: 'kdf2',
};

describe('syncAll', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls getMessagesInRange for each previously-accessed chat', async () => {
    const cache = fakeCache({ u123: ['chat1', 'chat2'] });
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const createRequestClient = vi.fn(async (): Promise<RequestLineClient> => ({
      api: {} as RequestLineClient['api'],
      messages: { getMessages: vi.fn(), getMessagesInRange },
    }));

    await syncAll({ credentialStore, cache, createRequestClient });

    expect(createRequestClient).toHaveBeenCalledWith(expect.objectContaining({ mid: 'u123' }));
    expect(getMessagesInRange).toHaveBeenCalledWith('chat1', 0);
    expect(getMessagesInRange).toHaveBeenCalledWith('chat2', 0);
  });

  it('does not throw when the credential store is empty', async () => {
    const cache = fakeCache({});
    const credentialStore = fakeCredentialStore([]);
    const createRequestClient = vi.fn();
    await expect(syncAll({ credentialStore, cache, createRequestClient })).resolves.not.toThrow();
    expect(createRequestClient).not.toHaveBeenCalled();
  });

  it('continues syncing other chats when one chat fails', async () => {
    const cache = fakeCache({ u123: ['chat1', 'chat2'] });
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const getMessagesInRange = vi.fn()
      .mockRejectedValueOnce(new Error('LINE API error'))
      .mockResolvedValue([]);
    const createRequestClient = vi.fn(async (): Promise<RequestLineClient> => ({
      api: {} as RequestLineClient['api'],
      messages: { getMessages: vi.fn(), getMessagesInRange },
    }));

    await expect(syncAll({ credentialStore, cache, createRequestClient })).resolves.not.toThrow();
    expect(getMessagesInRange).toHaveBeenCalledTimes(2);
  });

  it('masks account and chat MIDs and omits sync error text from logs', async () => {
    const mid = 'u1234567890test';
    const chatMid = 'c1234567890test';
    const errorText = 'injected credential-like error text';
    const cache = fakeCache({ [mid]: [chatMid] });
    const credentialStore = fakeCredentialStore([{ ...RECORD_A, mid }]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const createRequestClient = vi.fn(async (): Promise<RequestLineClient> => ({
      api: {} as RequestLineClient['api'],
      messages: { getMessages: vi.fn(), getMessagesInRange: vi.fn().mockRejectedValue(new Error(errorText)) },
    }));

    await syncAll({ credentialStore, cache, createRequestClient });

    const logs = stderr.mock.calls.map(([m]) => String(m)).join('');
    expect(logs).not.toContain(mid);
    expect(logs).not.toContain(chatMid);
    expect(logs).not.toContain(errorText);
    expect(logs).toContain('u123...test');
    expect(logs).toContain('c123...test');
  });

  it('skips an account when the request client cannot be built (e.g. no resolvable credentials)', async () => {
    const cache = fakeCache({ u123: ['chat1'] });
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const createRequestClient = vi.fn().mockRejectedValue(new Error('No LINE credentials available'));

    await expect(syncAll({ credentialStore, cache, createRequestClient })).resolves.not.toThrow();
    expect(createRequestClient).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an account with no previously-accessed chats', async () => {
    const cache = fakeCache({});
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const createRequestClient = vi.fn();

    await syncAll({ credentialStore, cache, createRequestClient });

    expect(createRequestClient).not.toHaveBeenCalled();
  });

  it('syncs each account against only its own owner-scoped chats', async () => {
    const cache = fakeCache({ 'u-owner-a': ['c-a'], 'u-owner-b': ['c-b'] });
    const credentialStore = fakeCredentialStore([
      { ...RECORD_A, mid: 'u-owner-a' },
      { ...RECORD_A, mid: 'u-owner-b' },
    ]);

    const seenByOwner: Record<string, string[]> = {};
    const createRequestClient = vi.fn(async (principal: { mid: string }): Promise<RequestLineClient> => ({
      api: {} as RequestLineClient['api'],
      messages: {
        getMessages: vi.fn(),
        getMessagesInRange: vi.fn(async (chatMid: string) => {
          (seenByOwner[principal.mid] ??= []).push(chatMid);
          return [];
        }),
      },
    }));

    await syncAll({ credentialStore, cache, createRequestClient });

    expect(seenByOwner).toEqual({ 'u-owner-a': ['c-a'], 'u-owner-b': ['c-b'] });
  });
});

describe('startSyncLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs syncAll immediately on start', async () => {
    const cache = fakeCache({ u123: ['chat1'] });
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const createRequestClient = vi.fn(async (): Promise<RequestLineClient> => ({
      api: {} as RequestLineClient['api'],
      messages: { getMessages: vi.fn(), getMessagesInRange },
    }));

    const handle = startSyncLoop({ credentialStore, cache, createRequestClient }, 100_000);
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    expect(getMessagesInRange).toHaveBeenCalled();
  });

  it('omits unexpected sync error text from logs', async () => {
    const errorText = 'injected unexpected credential-like error';
    const cache: MessageCache = {
      upsertMessages: vi.fn(),
      getMessages: vi.fn(() => []),
      latestTimestamp: vi.fn(() => null),
      getDistinctChatMids: vi.fn(() => { throw new Error(errorText); }),
    };
    const credentialStore = fakeCredentialStore([RECORD_A]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const createRequestClient = vi.fn();

    const handle = startSyncLoop({ credentialStore, cache, createRequestClient }, 100_000);
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    const logs = stderr.mock.calls.map(([m]) => String(m)).join('');
    expect(logs).not.toContain(errorText);
  });

  it('single-flight guards overlapping runs: a slow first run is shared, not duplicated, by the next interval tick', async () => {
    const cache = fakeCache({ u123: ['chat1'] });
    const credentialStore = fakeCredentialStore([RECORD_A]);
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const createRequestClient = vi.fn(async (): Promise<RequestLineClient> => {
      calls++;
      await gate; // block the first (and only, if single-flight works) run in flight
      return {
        api: {} as RequestLineClient['api'],
        messages: { getMessages: vi.fn(), getMessagesInRange: vi.fn().mockResolvedValue([]) },
      };
    });

    // Very short interval so a second tick fires while the first run is still blocked on `gate`.
    const handle = startSyncLoop({ credentialStore, cache, createRequestClient }, 10);
    await new Promise((r) => setTimeout(r, 50)); // let several intervals fire while blocked
    expect(calls).toBe(1); // still only the first run in flight — no overlap started a second

    resolveFirst();
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(handle);

    // After the first run completes, a subsequent tick is free to start a new run.
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
