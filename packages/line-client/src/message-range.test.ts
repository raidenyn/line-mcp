import { describe, expect, it, vi } from 'vitest';
import type { LineReadResult, Message } from './client';
import { fetchMessageRange } from './message-range';

const msgs = [{ id: 'a' }, { id: 'b' }] as unknown as Message[];
const ok = (messages: Message[], coverage: 'complete' | 'history_end' | 'truncated' = 'complete'): LineReadResult => ({
  ok: true,
  value: { messages, coverage, oldestReachedMs: null },
});
const fail = (kind: 'unavailable' | 'session_expired'): LineReadResult => ({
  ok: false,
  error: { kind, message: 'boom' },
});

function setup(result: LineReadResult | ((signal?: AbortSignal) => LineReadResult)) {
  const getMessagesBetween = vi.fn(async (_c: string, _s: number, _u: number, o?: { signal?: AbortSignal }) =>
    typeof result === 'function' ? result(o?.signal) : result,
  );
  const upsertMessages = vi.fn();
  const latestTimestamp = vi.fn();
  const cache = { upsertMessages, latestTimestamp };
  const run = (extra: { signal?: AbortSignal; rejectTruncated?: boolean } = {}) =>
    fetchMessageRange({ getMessagesBetween }, cache, 'owner', 'chat', { sinceMs: 1000, untilMs: 2000, ...extra });
  return { getMessagesBetween, upsertMessages, latestTimestamp, cache, run };
}

const aborted = { ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } };

describe('fetchMessageRange', () => {
  it('upserts the fetched range', async () => {
    const result = ok(msgs);
    const t = setup(result);
    expect(await t.run()).toBe(result);
    expect(t.upsertMessages).toHaveBeenCalledOnce();
    expect(t.upsertMessages).toHaveBeenCalledWith('owner', 'chat', msgs);
    expect(t.getMessagesBetween).toHaveBeenCalledWith('chat', 1000, 2000, { signal: undefined });
  });

  it('does not write an empty range', async () => {
    const t = setup(ok([]));
    await t.run();
    expect(t.upsertMessages).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'session_expired'] as const)('no write on %s failure', async (kind) => {
    const result = fail(kind);
    const t = setup(result);
    expect(await t.run()).toBe(result);
    expect(t.upsertMessages).not.toHaveBeenCalled();
  });

  it('no write after abort, and abort beats a failure', async () => {
    for (const result of [ok(msgs), fail('session_expired')]) {
      const ctl = new AbortController();
      const t = setup(() => {
        ctl.abort();
        return result;
      });
      expect(await t.run({ signal: ctl.signal })).toMatchObject(aborted);
      expect(t.upsertMessages).not.toHaveBeenCalled();
    }
  });

  it('rejectTruncated refuses a truncated walk only when asked', async () => {
    const t = setup(ok(msgs, 'truncated'));
    expect(await t.run({ rejectTruncated: true })).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: history walk truncated' },
    });
    expect(t.upsertMessages).not.toHaveBeenCalled();

    const result = ok(msgs, 'truncated');
    const u = setup(result);
    expect(await u.run()).toBe(result);
    expect(u.upsertMessages).toHaveBeenCalledOnce();

    const h = setup(ok(msgs, 'history_end'));
    await h.run({ rejectTruncated: true });
    expect(h.upsertMessages).toHaveBeenCalledOnce();
  });

  it('cache errors propagate', async () => {
    const t = setup(ok(msgs));
    t.upsertMessages.mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(t.run()).rejects.toThrow('disk full');
  });

  it('ignores the newest cached message', async () => {
    const t = setup(ok(msgs));
    await t.run();
    expect(t.latestTimestamp).not.toHaveBeenCalled();
  });
});
