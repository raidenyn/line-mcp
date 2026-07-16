import { describe, it, expect, afterEach, vi } from 'vitest';
import { getHistoricalRate } from './fx-rates';

describe('getHistoricalRate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the rate from a successful frankfurter.dev response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'USD', date: '2026-06-23', rates: { THB: 33.2 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-23', 'USD', 'THB');
    expect(rate).toBe(33.2);
    expect(mockFetch).toHaveBeenCalledWith('https://api.frankfurter.dev/v1/2026-06-23?from=USD&to=THB');
  });

  it('returns null when the response has no rates object (not found)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'not found' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2027-01-01', 'USD', 'ZZZ');
    expect(rate).toBeNull();
  });

  it('returns null when fetch rejects (network error)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-25', 'USD', 'THB');
    expect(rate).toBeNull();
  });

  it('returns null when the response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    const rate = await getHistoricalRate('2026-06-26', 'USD', 'THB');
    expect(rate).toBeNull();
  });

  it('caches a successful lookup and does not re-fetch for the same date/pair', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'EUR', date: '2026-05-01', rates: { GBP: 0.85 } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const first = await getHistoricalRate('2026-05-01', 'EUR', 'GBP');
    const second = await getHistoricalRate('2026-05-01', 'EUR', 'GBP');
    expect(first).toBe(0.85);
    expect(second).toBe(0.85);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed lookup (retries on next call)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    await getHistoricalRate('2026-05-02', 'EUR', 'JPY');
    await getHistoricalRate('2026-05-02', 'EUR', 'JPY');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});