import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MessageCache } from './message-cache';
import { syncAll, startSyncLoop } from './sync';
import type { AuthData } from './line-client';

function msg(id: string, createdTime: string) {
  return { id, from: 'u1', to: 'chat1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

function makeAuthDir(authData: AuthData): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  writeFileSync(join(dir, `${authData.mid}.json`), JSON.stringify(authData));
  return dir;
}

const TEST_AUTH: AuthData = {
  mid: 'u123',
  accessToken: 'tok',
  refreshToken: 'ref',
  certificate: 'cert',
  wrappedNonce: 'nonce',
  kdfParameter1: 'kdf1',
  kdfParameter2: 'kdf2',
};

describe('syncAll', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls getMessagesInRange for each previously-accessed chat', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(TEST_AUTH.mid, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(TEST_AUTH.mid, 'chat2', [msg('2', '2000')]);

    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).toHaveBeenCalledWith(TEST_AUTH, cache);
    expect(getMessagesInRange).toHaveBeenCalledWith('chat1', 0);
    expect(getMessagesInRange).toHaveBeenCalledWith('chat2', 0);
  });

  it('does not throw when auth dir is missing', async () => {
    const cache = new MessageCache(':memory:');
    await expect(syncAll(cache, { authDir: '/nonexistent/auth' })).resolves.not.toThrow();
  });

  it('continues syncing other chats when one chat fails', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(TEST_AUTH.mid, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(TEST_AUTH.mid, 'chat2', [msg('2', '2000')]);

    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn()
      .mockRejectedValueOnce(new Error('LINE API error'))
      .mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await expect(syncAll(cache, { authDir, makeClient })).resolves.not.toThrow();
    expect(getMessagesInRange).toHaveBeenCalledTimes(2);
  });

  it('masks account and chat MIDs and omits sync error text from logs', async () => {
    const authData = { ...TEST_AUTH, mid: 'u1234567890test' };
    const chatMid = 'c1234567890test';
    const errorText = 'injected credential-like error text';
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(authData.mid, chatMid, [{ ...msg('1', '1000'), to: chatMid }]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const makeClient = vi.fn().mockReturnValue({
      getMessagesInRange: vi.fn().mockRejectedValue(new Error(errorText)),
    });

    await syncAll(cache, { authDir: makeAuthDir(authData), makeClient });

    const logs = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(logs).not.toContain(authData.mid);
    expect(logs).not.toContain(chatMid);
    expect(logs).not.toContain(errorText);
    expect(logs).toContain('u123...test');
    expect(logs).toContain('c123...test');
  });

  it('skips mid if auth file contains invalid JSON', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(TEST_AUTH.mid, 'chat1', [msg('1', '1000')]);

    const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
    writeFileSync(join(authDir, 'badusr.json'), 'not-json');
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).not.toHaveBeenCalled();
  });

  it.each([
    ['incomplete', { mid: 'u123', accessToken: 'tok' }],
    ['mismatched', { ...TEST_AUTH, mid: 'u-other' }],
  ])('skips %s auth records through shared validation', async (_label, value) => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(TEST_AUTH.mid, 'chat1', [msg('1', '1000')]);
    const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
    writeFileSync(join(authDir, 'u123.json'), JSON.stringify(value));
    const makeClient = vi.fn();

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).not.toHaveBeenCalled();
  });

  it('does nothing when cache has no previously-accessed chats', async () => {
    const cache = new MessageCache(':memory:');
    const authDir = makeAuthDir(TEST_AUTH);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange: vi.fn() });

    await syncAll(cache, { authDir, makeClient });

    expect(makeClient).not.toHaveBeenCalled();
  });

  it('syncs each account against only its own owner-scoped chats', async () => {
    const cache = new MessageCache(':memory:');
    const ownerA: AuthData = { ...TEST_AUTH, mid: 'u-owner-a' };
    const ownerB: AuthData = { ...TEST_AUTH, mid: 'u-owner-b' };
    cache.upsertMessages('u-owner-a', 'c-a', [msg('1', '1000')]);
    cache.upsertMessages('u-owner-b', 'c-b', [msg('2', '2000')]);

    const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
    writeFileSync(join(authDir, 'u-owner-a.json'), JSON.stringify(ownerA));
    writeFileSync(join(authDir, 'u-owner-b.json'), JSON.stringify(ownerB));

    const seenByOwner: Record<string, string[]> = {};
    const makeClient = vi.fn().mockImplementation((authData: AuthData) => ({
      getMessagesInRange: vi.fn().mockImplementation(async (chatMid: string) => {
        (seenByOwner[authData.mid] ??= []).push(chatMid);
        return [];
      }),
    }));

    await syncAll(cache, { authDir, makeClient });

    expect(seenByOwner).toEqual({
      'u-owner-a': ['c-a'],
      'u-owner-b': ['c-b'],
    });
  });
});

describe('startSyncLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs syncAll immediately on start', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(TEST_AUTH.mid, 'chat1', [msg('1', '1000')]);
    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    const handle = startSyncLoop(cache, 100_000, { authDir, makeClient });
    // wait for the immediate async call to complete
    await new Promise(r => setTimeout(r, 50));
    clearInterval(handle);

    expect(getMessagesInRange).toHaveBeenCalled();
  });

  it('omits unexpected sync error text from logs', async () => {
    const errorText = 'injected unexpected credential-like error';
    const cache = { getDistinctChatMids: () => { throw new Error(errorText); } } as MessageCache;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const handle = startSyncLoop(cache, 100_000);
    await new Promise(r => setTimeout(r, 50));
    clearInterval(handle);

    const logs = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(logs).not.toContain(errorText);
  });
});
