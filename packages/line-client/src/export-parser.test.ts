import { describe, it, expect } from 'vitest';
import { parseExportHeader, parseExportFile } from './export-parser';

const MINIMAL = `Chat history with Test Bot
Saved on: 6/21/2026, 17:00

Thu, 6/12/2025
17:09\tTest Bot\tHello world`;

const NON_LF_LINE_ENDINGS = [
  ['CRLF', '\r\n'],
  ['CR', '\r'],
] as const;

describe('parseExportHeader', () => {
  it('extracts chat name', () => {
    expect(parseExportHeader(MINIMAL)).toBe('Test Bot');
  });

  it('throws on invalid format', () => {
    expect(() => parseExportHeader('not a LINE export')).toThrow('LINE chat export');
  });

  it.each(NON_LF_LINE_ENDINGS)('accepts %s line endings', (_name, lineEnding) => {
    const text = MINIMAL.replace(/\n/g, lineEnding);

    expect(parseExportHeader(text)).toBe('Test Bot');
  });
});

describe('parseExportFile', () => {
  const MID = 'u123abc';
  const TZ = 'Asia/Bangkok';

  it('parses a single message', () => {
    const msgs = parseExportFile(MINIMAL, MID, TZ);
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.text).toBe('Hello world');
    expect(m.senderName).toBe('Test Bot');
    expect(m.from).toBe('export:Test Bot');
    expect(m.to).toBe(MID);
    expect(m.contentType).toBe(0);
    expect(m.toType).toBe(0);
    expect(m.hasContent).toBe(false);
    expect(m.id).toMatch(/^export-[0-9a-f]{24}$/);
  });

  it('converts Bangkok timestamp to correct UTC epoch', () => {
    const msgs = parseExportFile(MINIMAL, MID, TZ);
    // 2025-06-12 17:09 Asia/Bangkok (UTC+7) = 2025-06-12 10:09 UTC
    const expected = new Date('2025-06-12T10:09:00.000Z').getTime();
    expect(parseInt(msgs[0].createdTime, 10)).toBe(expected);
  });

  it('joins continuation lines with newline, trimming trailing whitespace', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
10:00\tBot\tFirst line
Second line
Third line`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('First line\nSecond line\nThird line');
  });

  it('preserves blank lines within multi-line messages', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
10:00\tBot\tLine one

Line three`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Line one\n\nLine three');
  });

  it('generates deterministic IDs (re-import is idempotent)', () => {
    const a = parseExportFile(MINIMAL, MID, TZ);
    const b = parseExportFile(MINIMAL, MID, TZ);
    expect(a[0].id).toBe(b[0].id);
  });

  it('generates unique IDs for different message texts at the same timestamp', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tFirst message
09:00\tBot\tSecond message`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).not.toBe(msgs[1].id);
  });

  it('parses messages across multiple days', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tFirst

Tue, 1/2/2024
11:00\tBot\tSecond`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('First');
    expect(msgs[1].text).toBe('Second');
  });

  it('gives identical same-minute lines distinct deterministic IDs', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tRepeated
09:00\tBot\tRepeated`;

    const first = parseExportFile(text, MID, TZ);
    const second = parseExportFile(text, MID, TZ);

    expect(first).toHaveLength(2);
    expect(first[0].id).not.toBe(first[1].id);
    expect(first.map(message => message.id)).toEqual(second.map(message => message.id));
  });

  it('frames sender and text fields so ambiguous boundaries do not collide', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tA\tBC
09:00\tAB\tC`;

    const messages = parseExportFile(text, MID, TZ);

    expect(messages[0].id).not.toBe(messages[1].id);
  });

  it('does not shift duplicate IDs when an unrelated message is inserted', () => {
    const base = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tRepeated
09:00\tBot\tRepeated`;
    const withUnrelated = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tRepeated
09:00\tBot\tDifferent
09:00\tBot\tRepeated`;

    const baseIds = parseExportFile(base, MID, TZ).map(message => message.id);
    const relatedIds = parseExportFile(withUnrelated, MID, TZ)
      .filter(message => message.text === 'Repeated')
      .map(message => message.id);

    expect(relatedIds).toEqual(baseIds);
  });

  it.each(NON_LF_LINE_ENDINGS)('parses %s exports identically to LF', (_name, lineEnding) => {
    const text = MINIMAL.replace(/\n/g, lineEnding);

    expect(parseExportFile(text, MID, TZ)).toEqual(parseExportFile(MINIMAL, MID, TZ));
  });

  it.each(NON_LF_LINE_ENDINGS)('normalizes %s continuation lines to LF', (_name, lineEnding) => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
10:00\tBot\tFirst line
Second line`.replace(/\n/g, lineEnding);

    expect(parseExportFile(text, MID, TZ)[0].text).toBe('First line\nSecond line');
  });
});
