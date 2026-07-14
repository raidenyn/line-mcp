import { describe, expect, it } from 'vitest';
import type { Message } from './line-client';
import { filterSampleMessages, parseSampleUntilBound } from './sample-messages';

function message(id: string, iso: string): Message {
  return {
    id,
    from: 'user',
    to: 'chat',
    toType: 1,
    createdTime: String(new Date(iso).getTime()),
    contentType: 0,
    text: id,
    hasContent: false,
  };
}

describe('sample message until bounds', () => {
  const messages = [
    message('midday', '2026-05-31T12:00:00.000Z'),
    message('june', '2026-06-01T00:00:00.000Z'),
    message('may-end', '2026-05-31T23:59:59.999Z'),
  ];

  it('keeps messages later on a date-only until boundary', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05-31'));
    expect(result.map((item) => item.id)).toEqual(['midday', 'may-end']);
  });

  it('expands a month-only until bound through the end of that month', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05'));
    expect(result.map((item) => item.id)).toEqual(['midday', 'may-end']);
  });

  it('keeps a complete ISO timestamp as an exact upper bound', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05-31T12:00:00.000Z'));
    expect(result.map((item) => item.id)).toEqual(['midday']);
  });
});
