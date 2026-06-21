import type { LineClient, Message } from './line-client';
import type { MessageCache } from './message-cache';

export class CachingLineClient {
  constructor(private inner: LineClient, private cache: MessageCache) {}

  async getMessages(chatMid: string, count = 50, resolveNames = true): Promise<Message[]> {
    const latestMs = this.cache.latestTimestamp(chatMid);
    const live = await this.inner.getMessagesInRange(chatMid, latestMs ?? 0, true);
    if (live.length > 0) this.cache.upsertMessages(chatMid, live);
    const all = this.cache.getMessages(chatMid);
    return all.slice(-count);
  }

  async getMessagesInRange(
    chatMid: string,
    sinceMs: number,
    resolveNames = true,
    pageSize = 200,
  ): Promise<Message[]> {
    const latestMs = this.cache.latestTimestamp(chatMid);
    const live = await this.inner.getMessagesInRange(chatMid, latestMs ?? 0, true, pageSize);
    if (live.length > 0) this.cache.upsertMessages(chatMid, live);
    return this.cache.getMessages(chatMid, sinceMs);
  }

  listChats() { return this.inner.listChats(); }
  getImageBuffer(url: string) { return this.inner.getImageBuffer(url); }
  waitForPin() { return this.inner.waitForPin(); }
  waitForCompletion() { return this.inner.waitForCompletion(); }
  getCompletedAuth() { return this.inner.getCompletedAuth(); }
}
