import { describe, it, expect, vi } from 'vitest';
import { CachingLineClient } from './caching-line-client';
import { MessageCache } from './message-cache';
import type { Message, LineClient } from './line-client';

const OWNER = 'owner1';

function msg(id: string, createdTime: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

function makeMockInner(liveMessages: Message[] = []) {
  return {
    getMessages: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
    getMessagesInRange: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
    listChats: vi.fn().mockResolvedValue([]),
    getImageBuffer: vi.fn().mockResolvedValue({ buffer: Buffer.from(''), mimeType: 'image/jpeg' }),
    waitForPin: vi.fn().mockResolvedValue(null),
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    getCompletedAuth: vi.fn().mockReturnValue(null),
  };
}

describe('CachingLineClient.getMessages', () => {
  it('calls getMessagesInRange on inner with latestTimestamp when cache has data', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    const inner = makeMockInner([msg('2', '2000')]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    await client.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 1000, true);
  });

  it('calls getMessagesInRange on inner with 0 when cache is empty', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    await client.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 0, true);
  });

  it('writes live messages to cache', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    await client.getMessages('chat1', 10);
    expect(cache.getMessages(OWNER, 'chat1').map(m => m.id)).toEqual(['1']);
  });

  it('skips upsert when live returns empty', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    const inner = makeMockInner([]);
    const upsertSpy = vi.spyOn(cache, 'upsertMessages');
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    await client.getMessages('chat1', 10);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('returns newest `count` messages from cache', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    const inner = makeMockInner([]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    const result = await client.getMessages('chat1', 2);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });

});

describe('CachingLineClient.getMessagesInRange', () => {
  it('fetches live from latestTimestamp and reads cache from sinceMs', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '3000')]);
    const inner = makeMockInner([msg('3', '5000')]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    const result = await client.getMessagesInRange('chat1', 2000);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 3000, true, 200);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });

  it('on empty cache fetches from 0', async () => {
    const cache = new MessageCache(':memory:');
    const inner = makeMockInner([msg('1', '1000')]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    await client.getMessagesInRange('chat1', 500);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 0, true, 200);
  });

  it('returns messages from sinceMs even when LINE returns nothing new', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000')]);
    const inner = makeMockInner([]);
    const client = new CachingLineClient(inner as unknown as LineClient, cache, OWNER);

    const result = await client.getMessagesInRange('chat1', 1500);
    expect(result.map(m => m.id)).toEqual(['2']);
  });

});

describe('CachingLineClient owner isolation', () => {
  it('does not leak another owner\'s cached rows for the same chat and message ids', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('owner-a', 'chat-shared', [msg('m1', '1000')]);
    const innerB = makeMockInner([]);
    const clientB = new CachingLineClient(innerB as unknown as LineClient, cache, 'owner-b');

    const result = await clientB.getMessages('chat-shared', 10);
    expect(result).toEqual([]);
  });

  it('scopes getMessagesInRange latestTimestamp lookups by owner', async () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('owner-a', 'chat-shared', [msg('m1', '9000')]);
    const innerB = makeMockInner([msg('m1', '9000')]);
    const clientB = new CachingLineClient(innerB as unknown as LineClient, cache, 'owner-b');

    // owner-b has no cached rows of its own, so it must re-fetch from 0,
    // not from owner-a's latestTimestamp of 9000.
    await clientB.getMessagesInRange('chat-shared', 0);
    expect(innerB.getMessagesInRange).toHaveBeenCalledWith('chat-shared', 0, true, 200);
  });
});

describe('CachingLineClient forwarded methods', () => {
  it('forwards listChats', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'), OWNER);
    await client.listChats();
    expect(inner.listChats).toHaveBeenCalledOnce();
  });

  it('forwards getImageBuffer', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'), OWNER);
    await client.getImageBuffer('http://example.com/img.jpg');
    expect(inner.getImageBuffer).toHaveBeenCalledWith('http://example.com/img.jpg');
  });

  it('forwards waitForPin', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'), OWNER);
    await client.waitForPin();
    expect(inner.waitForPin).toHaveBeenCalledOnce();
  });

  it('forwards waitForCompletion', async () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'), OWNER);
    await client.waitForCompletion();
    expect(inner.waitForCompletion).toHaveBeenCalledOnce();
  });

  it('forwards getCompletedAuth', () => {
    const inner = makeMockInner();
    const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'), OWNER);
    client.getCompletedAuth();
    expect(inner.getCompletedAuth).toHaveBeenCalledOnce();
  });
});
