import { describe, expect, it } from 'vitest';
import { requestHash } from './request-hash';

describe('requestHash', () => {
  it('does not depend on member order', () => {
    expect(requestHash({ b: 2, a: 1 })).toBe(requestHash({ a: 1, b: 2 }));
    expect(requestHash({ outer: { z: 1, a: 2 } })).toBe(requestHash({ outer: { a: 2, z: 1 } }));
  });

  it('ignores the idempotency key', () => {
    expect(requestHash({ action: 'add_source', idempotency_key: 'k1' })).toBe(
      requestHash({ action: 'add_source', idempotency_key: 'k2' }),
    );
    expect(requestHash({ action: 'add_source', idempotency_key: 'k1' })).toBe(
      requestHash({ action: 'add_source' }),
    );
  });

  it('changes when an argument changes', () => {
    expect(requestHash({ label: 'a' })).not.toBe(requestHash({ label: 'b' }));
  });
});
