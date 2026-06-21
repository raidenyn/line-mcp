import { describe, it, expect } from 'vitest';
import { MessageCache } from './message-cache';
import type { Message } from './line-client';

function msg(id: string, createdTime: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false };
}

describe('MessageCache.getMessages', () => {
  it('returns empty array for unknown chat', () => {
    const cache = new MessageCache(':memory:');
    expect(cache.getMessages('chat1')).toEqual([]);
  });

  it('returns messages oldest-first', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('2', '2000'), msg('1', '1000')]);
    expect(cache.getMessages('chat1').map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by sinceMs (inclusive)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', 2000).map(m => m.id)).toEqual(['2', '3']);
  });

  it('filters by untilMs (inclusive)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', undefined, 2000).map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by both sinceMs and untilMs', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages('chat1', 1500, 2500).map(m => m.id)).toEqual(['2']);
  });

  it('isolates messages by chatMid', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '2000')]);
    expect(cache.getMessages('chat1').map(m => m.id)).toEqual(['1']);
    expect(cache.getMessages('chat2').map(m => m.id)).toEqual(['2']);
  });
});

describe('MessageCache.upsertMessages', () => {
  it('deduplicates on re-insert (same message_id)', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    expect(cache.getMessages('chat1')).toHaveLength(1);
  });

  it('no-ops on empty array', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', []);
    expect(cache.getMessages('chat1')).toEqual([]);
  });
});

describe('MessageCache.latestTimestamp', () => {
  it('returns null for empty cache', () => {
    const cache = new MessageCache(':memory:');
    expect(cache.latestTimestamp('chat1')).toBeNull();
  });

  it('returns highest createdTime as number', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000'), msg('3', '3000'), msg('2', '2000')]);
    expect(cache.latestTimestamp('chat1')).toBe(3000);
  });

  it('is scoped per chatMid', () => {
    const cache = new MessageCache(':memory:');
    cache.upsertMessages('chat1', [msg('1', '1000')]);
    cache.upsertMessages('chat2', [msg('2', '9000')]);
    expect(cache.latestTimestamp('chat1')).toBe(1000);
  });
});
