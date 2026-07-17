import type { Message } from '@raidenyn/line-client';
import { expandUntilBound } from './transaction-parser';

export function parseSampleUntilBound(until: string): number {
  const monthOnly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(until);
  if (monthOnly) {
    return Date.UTC(Number(monthOnly[1]), Number(monthOnly[2]), 0, 23, 59, 59, 999);
  }
  return new Date(expandUntilBound(until)).getTime();
}

export function filterSampleMessages(messages: Message[], untilMs?: number): Message[] {
  return messages
    .filter((message) => message.contentType === 0 && message.text)
    .filter((message) => untilMs === undefined || parseInt(message.createdTime, 10) <= untilMs)
    .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
}
