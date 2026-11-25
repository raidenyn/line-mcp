import type { MessageCache } from './cached-message-reader';
import type { LineReadResult, MessageRangeOptions } from './client';

export interface MessageRangeRequest {
  sinceMs: number;
  untilMs: number;
  signal?: AbortSignal;
  rejectTruncated?: boolean;
}

const unavailable = (message: string): LineReadResult => ({
  ok: false,
  error: { kind: 'unavailable', message },
});

/**
 * Fetches [sinceMs, untilMs] from LINE and upserts it into the cache. Order of
 * checks: abort, failure, rejectTruncated, then write. Cache errors propagate.
 */
export async function fetchMessageRange(
  client: {
    getMessagesBetween(
      chatMid: string,
      sinceMs: number,
      untilMs: number,
      options?: MessageRangeOptions,
    ): Promise<LineReadResult>;
  },
  cache: Pick<MessageCache, 'upsertMessages'>,
  ownerMid: string,
  chatMid: string,
  { sinceMs, untilMs, signal, rejectTruncated }: MessageRangeRequest,
): Promise<LineReadResult> {
  const result = await client.getMessagesBetween(chatMid, sinceMs, untilMs, { signal });
  if (signal?.aborted) return unavailable('LINE unavailable: aborted');
  if (!result.ok) return result;
  if (rejectTruncated && result.value.coverage === 'truncated') {
    return unavailable('LINE unavailable: history walk truncated');
  }
  if (result.value.messages.length > 0) cache.upsertMessages(ownerMid, chatMid, result.value.messages);
  return result;
}
