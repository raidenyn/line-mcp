import type { Message } from './client';

/**
 * The generic message-fetching surface a message-cache wrapper needs. Any
 * client that can page through a chat's history (LINE's own client, an
 * export-file reader, a test double, ...) can be wrapped by
 * withMessageCache() below, as long as it implements this shape.
 */
export interface MessageReader {
  getMessages(chatMid: string, count?: number): Promise<Message[]>;
  getMessagesInRange(chatMid: string, sinceMs: number, pageSize?: number): Promise<Message[]>;
}

/**
 * The persistence surface a message-cache wrapper needs. This package never
 * implements it against a real store (that's `@raidenyn/line-client-sqlite`,
 * a separate workspace with its own better-sqlite3 dependency) — it only
 * depends on this interface, so `@raidenyn/line-client` itself never pulls in
 * SQLite.
 */
export interface ImportMessagesResult {
  imported: number;
}

export interface MessageCache {
  upsertMessages(ownerMid: string, chatMid: string, messages: Message[]): void;
  importMessages(ownerMid: string, chatMid: string, messages: Message[]): ImportMessagesResult;
  getMessages(ownerMid: string, chatMid: string, sinceMs?: number, untilMs?: number): Message[];
  latestTimestamp(ownerMid: string, chatMid: string): number | null;
  getDistinctChatMids(ownerMid: string): string[];
}

/**
 * Wraps a MessageReader with a MessageCache: only fetches messages newer than
 * the cache's latest known timestamp for (ownerMid, chatMid) from `client`,
 * tops up the cache with whatever came back, then always answers from the
 * cache so the full requested range is returned even when the live fetch
 * comes back empty.
 */
export function withMessageCache(
  client: MessageReader,
  cache: MessageCache,
  ownerMid: string,
): MessageReader {
  return {
    async getMessages(chatMid: string, count = 50): Promise<Message[]> {
      const latestMs = cache.latestTimestamp(ownerMid, chatMid);
      const live = await client.getMessagesInRange(chatMid, latestMs ?? 0);
      if (live.length > 0) cache.upsertMessages(ownerMid, chatMid, live);
      const all = cache.getMessages(ownerMid, chatMid);
      return all.slice(-count);
    },

    async getMessagesInRange(chatMid: string, sinceMs: number, pageSize = 200): Promise<Message[]> {
      const latestMs = cache.latestTimestamp(ownerMid, chatMid);
      const live = await client.getMessagesInRange(chatMid, latestMs ?? 0, pageSize);
      if (live.length > 0) cache.upsertMessages(ownerMid, chatMid, live);
      return cache.getMessages(ownerMid, chatMid, sinceMs);
    },
  };
}
