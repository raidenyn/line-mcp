import { describe, expect, it } from 'vitest';
import { LedgerError } from './errors';
import {
  LABEL_MAX,
  defaultReviewFrom,
  normalizeCurrency,
  normalizeTimezone,
  optionalIdempotencyKey,
  optionalNullableString,
  optionalRevision,
  optionalString,
  parseLineSourceId,
  parseReviewFrom,
} from './validation';

function expectInvalid(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    const ledgerError = error as LedgerError;
    expect(ledgerError.code).toBe('invalid_argument');
    expect(ledgerError.details).toMatchObject({ field });
    return;
  }
  throw new Error(`Expected invalid_argument for ${field}`);
}

describe('validation — currency', () => {
  it('uppercases a known currency', () => {
    expect(normalizeCurrency('thb', 'base_currency')).toBe('THB');
    expect(normalizeCurrency('USD', 'base_currency')).toBe('USD');
  });

  it('refuses a code no currency table knows', () => {
    expectInvalid(() => normalizeCurrency('ABC', 'base_currency'), 'base_currency');
    expectInvalid(() => normalizeCurrency('TH', 'base_currency'), 'base_currency');
    expectInvalid(() => normalizeCurrency(5, 'base_currency'), 'base_currency');
    expectInvalid(() => normalizeCurrency(null, 'base_currency'), 'base_currency');
  });
});

describe('validation — timezone', () => {
  it('returns the runtime canonical name', () => {
    expect(normalizeTimezone('asia/bangkok', 'owner_timezone')).toBe('Asia/Bangkok');
    expect(normalizeTimezone('UTC', 'owner_timezone')).toBe('UTC');
  });

  it('treats link names and their canonical target as equal', () => {
    expect(normalizeTimezone('Asia/Kolkata', 'owner_timezone')).toBe(
      normalizeTimezone('Asia/Calcutta', 'owner_timezone'),
    );
  });

  it('refuses fixed offsets and unknown zones', () => {
    expectInvalid(() => normalizeTimezone('+07:00', 'owner_timezone'), 'owner_timezone');
    expectInvalid(() => normalizeTimezone('Mars/Base', 'owner_timezone'), 'owner_timezone');
    expectInvalid(() => normalizeTimezone('', 'owner_timezone'), 'owner_timezone');
  });
});

describe('validation — review_from', () => {
  it('accepts a real calendar date', () => {
    expect(parseReviewFrom('2026-02-28', 'review_from')).toBe('2026-02-28');
    expect(parseReviewFrom('2024-02-29', 'review_from')).toBe('2024-02-29');
  });

  it('refuses an impossible or badly written date', () => {
    expectInvalid(() => parseReviewFrom('2026-02-30', 'review_from'), 'review_from');
    expectInvalid(() => parseReviewFrom('2026-2-1', 'review_from'), 'review_from');
    expectInvalid(() => parseReviewFrom('20260101', 'review_from'), 'review_from');
    expectInvalid(() => parseReviewFrom('2025-02-29', 'review_from'), 'review_from');
  });
});

describe('validation — LINE source id', () => {
  it('accepts the chat MID shape', () => {
    expect(parseLineSourceId('c0123abc_-')).toBe('c0123abc_-');
  });

  it('refuses an id a template could not address', () => {
    expectInvalid(() => parseLineSourceId('a/b'), 'source_id');
    expectInvalid(() => parseLineSourceId(''), 'source_id');
    expectInvalid(() => parseLineSourceId('x'.repeat(101)), 'source_id');
    expectInvalid(() => parseLineSourceId(7), 'source_id');
  });
});

describe('validation — optional strings', () => {
  it('passes undefined through and refuses null and other types', () => {
    expect(optionalString(undefined, 'label', LABEL_MAX)).toBeUndefined();
    expect(optionalString('ok', 'label', LABEL_MAX)).toBe('ok');
    expectInvalid(() => optionalString('x'.repeat(LABEL_MAX + 1), 'label', LABEL_MAX), 'label');
    expectInvalid(() => optionalString(null, 'label', LABEL_MAX), 'label');
  });

  it('lets null clear a value where update allows it', () => {
    expect(optionalNullableString(null, 'label', LABEL_MAX)).toBeNull();
    expect(optionalNullableString(undefined, 'label', LABEL_MAX)).toBeUndefined();
    expect(optionalNullableString('x', 'label', LABEL_MAX)).toBe('x');
    expectInvalid(() => optionalNullableString(5, 'label', LABEL_MAX), 'label');
  });

  it('checks the write-key bounds', () => {
    expect(optionalIdempotencyKey(undefined)).toBeUndefined();
    expect(optionalIdempotencyKey('k')).toBe('k');
    expectInvalid(() => optionalIdempotencyKey(''), 'idempotency_key');
    expectInvalid(() => optionalIdempotencyKey('x'.repeat(201)), 'idempotency_key');
    expectInvalid(() => optionalIdempotencyKey(5), 'idempotency_key');
  });
});

describe('validation — expected_revision', () => {
  it('accepts a positive integer only', () => {
    expect(optionalRevision(undefined)).toBeUndefined();
    expect(optionalRevision(3)).toBe(3);
    expectInvalid(() => optionalRevision(0), 'expected_revision');
    expectInvalid(() => optionalRevision(1.5), 'expected_revision');
    expectInvalid(() => optionalRevision('1'), 'expected_revision');
  });
});

describe('validation — default review start', () => {
  it('is three calendar months back with the day clamped', () => {
    expect(defaultReviewFrom(Date.parse('2026-05-31T12:00:00Z'), 'UTC')).toBe('2026-02-28');
    expect(defaultReviewFrom(Date.parse('2024-05-31T12:00:00Z'), 'UTC')).toBe('2024-02-29');
  });

  it('uses the calendar date in the given timezone', () => {
    // 20:00Z on 15 January is already 16 January in Bangkok.
    expect(defaultReviewFrom(Date.parse('2026-01-15T20:00:00Z'), 'Asia/Bangkok')).toBe('2025-10-16');
  });

  it('crosses the year boundary', () => {
    expect(defaultReviewFrom(Date.parse('2026-01-15T12:00:00Z'), 'UTC')).toBe('2025-10-15');
  });
});

describe('validation — malformed Unicode and early years', () => {
  it('accepts a valid date below year 100', () => {
    expect(parseReviewFrom('0099-02-28', 'review_from')).toBe('0099-02-28');
    expectInvalid(() => parseReviewFrom('0099-02-29', 'review_from'), 'review_from');
  });

  it('refuses a lone surrogate in a label or an idempotency key', () => {
    expectInvalid(() => optionalString('x\uD800y', 'label', LABEL_MAX), 'label');
    expectInvalid(() => optionalIdempotencyKey('key\uDC00', ), 'idempotency_key');
    expect(optionalString('Card 🥇', 'label', LABEL_MAX)).toBe('Card 🥇');
    expect(optionalIdempotencyKey('key-🥇')).toBe('key-🥇');
  });
});
