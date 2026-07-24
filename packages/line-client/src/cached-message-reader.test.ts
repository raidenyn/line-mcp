import { describe, it, expect, vi } from 'vitest';
import { withMessageCache, type MessageCache, type MessageReader } from './cached-message-reader';
import type { Message } from './client';

// Proves that @raidenyn/line-client's caching logic depends only on the
// MessageCache *interface*, never on a concrete (SQLite-backed) store — this
// fake is a plain in-memory Map, so this test file would fail to compile or
// run if withMessageCache() reached for better-sqlite3 or any other real
// storage implementation.
class FakeMessageCache implements MessageCache {
  private rows: Array<{ ownerMid: string; chatMid: string; message: Message }> = [];

  upsertMessages(ownerMid: string, chatMid: string, messages: Message[]): void {
    for (const message of messages) {
      const idx = this.rows.findIndex(
        r => r.ownerMid === ownerMid && r.chatMid === chatMid && r.message.id === message.id,
      );
      if (idx >= 0) this.rows[idx] = { ownerMid, chatMid, message };
      else this.rows.push({ ownerMid, chatMid, message });
    }
  }

  importMessages(ownerMid: string, chatMid: string, messages: Message[]): { imported: number } {
    const before = this.rows.length;
    this.upsertMessages(ownerMid, chatMid, messages);
    return { imported: this.rows.length - before };
  }

  getMessages(ownerMid: string, chatMid: string, sinceMs?: number, untilMs?: number): Message[] {
    return this.rows
      .filter(r => r.ownerMid === ownerMid && r.chatMid === chatMid)
      .map(r => r.message)
      .filter(m => (sinceMs == null || parseInt(m.createdTime, 10) >= sinceMs))
      .filter(m => (untilMs == null || parseInt(m.createdTime, 10) <= untilMs))
      .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
  }

  latestTimestamp(ownerMid: string, chatMid: string): number | null {
    const times = this.rows
      .filter(r => r.ownerMid === ownerMid && r.chatMid === chatMid)
      .map(r => parseInt(r.message.createdTime, 10));
    return times.length > 0 ? Math.max(...times) : null;
  }

  getDistinctChatMids(ownerMid: string): string[] {
    return [...new Set(this.rows.filter(r => r.ownerMid === ownerMid).map(r => r.chatMid))];
  }
}

const OWNER = 'owner1';

function msg(id: string, createdTime: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

function makeMockInner(liveMessages: Message[] = []): MessageReader {
  return {
    getMessages: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
    getMessagesInRange: vi.fn<() => Promise<Message[]>>().mockResolvedValue(liveMessages),
  };
}

describe('withMessageCache — getMessages', () => {
  it('fetches from the cache\'s latest timestamp when the cache has data', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    const inner = makeMockInner([msg('2', '2000')]);
    const reader = withMessageCache(inner, cache, OWNER);

    await reader.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 1000);
  });

  it('fetches from 0 when the cache is empty', async () => {
    const cache = new FakeMessageCache();
    const inner = makeMockInner([msg('1', '1000')]);
    const reader = withMessageCache(inner, cache, OWNER);

    await reader.getMessages('chat1', 10);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 0);
  });

  it('writes live messages into the cache', async () => {
    const cache = new FakeMessageCache();
    const inner = makeMockInner([msg('1', '1000')]);
    const reader = withMessageCache(inner, cache, OWNER);

    await reader.getMessages('chat1', 10);
    expect(cache.getMessages(OWNER, 'chat1').map(m => m.id)).toEqual(['1']);
  });

  it('skips the cache write when the live fetch returns nothing new', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    const inner = makeMockInner([]);
    const upsertSpy = vi.spyOn(cache, 'upsertMessages');
    const reader = withMessageCache(inner, cache, OWNER);

    await reader.getMessages('chat1', 10);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('returns the newest `count` messages from the cache', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    const inner = makeMockInner([]);
    const reader = withMessageCache(inner, cache, OWNER);

    const result = await reader.getMessages('chat1', 2);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });
});

describe('withMessageCache — getMessagesInRange', () => {
  it('fetches live from the latest timestamp and reads the cache from sinceMs', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '3000')]);
    const inner = makeMockInner([msg('3', '5000')]);
    const reader = withMessageCache(inner, cache, OWNER);

    const result = await reader.getMessagesInRange('chat1', 2000);
    expect(inner.getMessagesInRange).toHaveBeenCalledWith('chat1', 3000, 200);
    expect(result.map(m => m.id)).toEqual(['2', '3']);
  });

  it('returns messages from sinceMs even when the live fetch returns nothing new', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000')]);
    const inner = makeMockInner([]);
    const reader = withMessageCache(inner, cache, OWNER);

    const result = await reader.getMessagesInRange('chat1', 1500);
    expect(result.map(m => m.id)).toEqual(['2']);
  });
});

describe('withMessageCache — owner isolation', () => {
  it('does not leak another owner\'s cached rows for the same chat and message ids', async () => {
    const cache = new FakeMessageCache();
    cache.upsertMessages('owner-a', 'chat-shared', [msg('m1', '1000')]);
    const innerB = makeMockInner([]);
    const readerB = withMessageCache(innerB, cache, 'owner-b');

    const result = await readerB.getMessages('chat-shared', 10);
    expect(result).toEqual([]);
  });
});
