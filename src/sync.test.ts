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
  it('calls getMessagesInRange for each previously-accessed chat', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);

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
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);

    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn()
      .mockRejectedValueOnce(new Error('LINE API error'))
      .mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    await expect(syncAll(cache, { authDir, makeClient })).resolves.not.toThrow();
    expect(getMessagesInRange).toHaveBeenCalledTimes(2);
  });

  it('skips mid if auth file contains invalid JSON', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);

    const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
    writeFileSync(join(authDir, 'badusr.json'), 'not-json');
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

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
});

describe('startSyncLoop', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs syncAll immediately on start', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    const authDir = makeAuthDir(TEST_AUTH);
    const getMessagesInRange = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ getMessagesInRange });

    const handle = startSyncLoop(cache, 100_000, { authDir, makeClient });
    // wait for the immediate async call to complete
    await new Promise(r => setTimeout(r, 50));
    clearInterval(handle);

    expect(getMessagesInRange).toHaveBeenCalled();
  });
});
