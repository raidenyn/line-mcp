import { describe, expect, it } from 'vitest';
import { resolveRegexTimeoutMs } from './cli';

describe('resolveRegexTimeoutMs', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['not-a-number', Number.NaN],
    ['0', 0],
    ['250', 250],
    ['1001', 1001],
  ])('maps %s to %s', (raw, expected) => {
    const actual = resolveRegexTimeoutMs(raw);
    if (Number.isNaN(expected)) expect(actual).toBeNaN();
    else if (expected === undefined) expect(actual).toBeUndefined();
    else expect(actual).toBe(expected);
  });
});