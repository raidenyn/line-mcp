import type { Message } from './line-client';
import { expandUntilBound } from './transaction-parser';

export function parseSampleUntilBound(until: string): number {
  return new Date(expandUntilBound(until)).getTime();
}

export function filterSampleMessages(messages: Message[], untilMs?: number): Message[] {
  return messages
    .filter((message) => message.contentType === 0 && message.text)
    .filter((message) => untilMs === undefined || parseInt(message.createdTime, 10) <= untilMs)
    .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
}
