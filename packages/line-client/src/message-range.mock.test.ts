import { createServer, type AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
// Built package via a re-export outside src (design D5): one signer instance.
import { createLineClient, fetchMessageRange, type Message } from '../../../tests/support/line-client-built';
import { createMockLineServer, type MockLineServer } from '../../../tests/support/mock-line-server/server';
import { MOCK_GROUP_MID, makeMockLineJwt } from '../../../tests/support/mock-line-server/fixtures';

const now = Math.floor(Date.now() / 1000);

function memoryCache() {
  const byId = new Map<string, Message>();
  return {
    upsertMessages(_owner: string, _chat: string, messages: Message[]): void {
      for (const m of messages) byId.set(m.id, m);
    },
    getMessages(_owner: string, _chat: string): Message[] {
      return [...byId.values()].sort((a, b) => Number(a.createdTime) - Number(b.createdTime));
    },
  };
}

const ids = (messages: readonly Message[]): string[] => messages.map(m => m.id).sort();
const historyIds = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `group-history-${String(from + i).padStart(3, '0')}`);

// Cases build on each other: shared cache, refresh count and refreshed token.
describe.sequential('fetchMessageRange against the LINE mock', () => {
  let mock: MockLineServer;
  let origin: string;
  let api: ReturnType<typeof createLineClient>;
  let owner: string;
  const cache = memoryCache();

  const fixture = (id: string): Message => {
    const raw = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID].find(m => m.id === id);
    if (!raw) throw new Error(`no fixture ${id}`);
    const { id: messageId, from, to, toType, createdTime, contentType, text, hasContent, contentMetadata } = raw;
    return { id: messageId, from, to, toType, createdTime, contentType, text, hasContent, contentMetadata };
  };
  const t = (id: string): number => Number(fixture(id).createdTime);

  beforeAll(async () => {
    mock = createMockLineServer({ port: 0, controlToken: 't' });
    ({ origin } = await mock.start());
    mock.state.configure({
      scenarioId: 'range',
      mode: 'seeded',
      epochSeconds: now,
      expectedRefreshCount: 1,
      expectedLoginBranches: [],
      expectedRejections: { unknown_access_token: 1 },
    });
    owner = mock.state.fixtures.seededAuth.mid;
    api = createLineClient(mock.state.fixtures.seededAuth, { lineApiBaseUrl: origin });
  });

  afterAll(async () => {
    await mock.stop({ verify: false });
  });

  it('fetches an older range below newer cached messages', async () => {
    cache.upsertMessages(owner, MOCK_GROUP_MID, ['group-debit', 'group-credit', 'group-image'].map(fixture));

    const result = await fetchMessageRange(api, cache, owner, MOCK_GROUP_MID, {
      sinceMs: t('group-history-005'),
      untilMs: t('group-history-010'),
    });

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(ids(result.value.messages)).toEqual(historyIds(5, 10));
    expect(result.value.coverage).toBe('complete');
    expect(ids(cache.getMessages(owner, MOCK_GROUP_MID))).toEqual(
      [...historyIds(5, 10), 'group-debit', 'group-credit', 'group-image'].sort(),
    );
    const report = mock.state.report();
    expect(report.routeCounts.previous).toBeGreaterThanOrEqual(1);
    expect(report.refreshCount).toBe(1);
  });

  it('reports history_end at the start of history', async () => {
    const result = await fetchMessageRange(api, cache, owner, MOCK_GROUP_MID, {
      sinceMs: t('group-history-000'),
      untilMs: t('group-history-010'),
    });

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(ids(result.value.messages)).toEqual(historyIds(0, 10));
    expect(result.value.coverage).toBe('history_end');
    expect(result.value.oldestReachedMs).toBe(t('group-history-000'));
  });

  it('reports session_expired for a token LINE rejects', async () => {
    const before = ids(cache.getMessages(owner, MOCK_GROUP_MID));
    const rejected = createLineClient(
      { ...mock.state.fixtures.seededAuth, accessToken: makeMockLineJwt('unknown', now - 60, now + 86400 * 10) },
      { lineApiBaseUrl: origin },
    );

    const result = await fetchMessageRange(rejected, cache, owner, MOCK_GROUP_MID, {
      sinceMs: t('group-history-005'),
      untilMs: t('group-history-010'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('session_expired');
    expect(ids(cache.getMessages(owner, MOCK_GROUP_MID))).toEqual(before);
    expect(mock.state.report().observedExpectedRejections.unknown_access_token).toBe(1);
  });

  it('reports unavailable when LINE cannot be reached', async () => {
    // A listener that resets every connection: a real network failure with no
    // window for another process to take a released port.
    const dead = createServer(socket => socket.resetAndDestroy());
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
    const deadOrigin = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    onTestFinished(() => new Promise<void>(resolve => dead.close(() => resolve())));
    const before = ids(cache.getMessages(owner, MOCK_GROUP_MID));
    const spy = vi.fn<typeof globalThis.fetch>((input, init) => globalThis.fetch(input, init));
    const unreachable = createLineClient(
      { ...mock.state.fixtures.seededAuth, accessToken: makeMockLineJwt('far', now - 60, now + 86400 * 10) },
      { lineApiBaseUrl: deadOrigin, fetch: spy },
    );

    const result = await fetchMessageRange(unreachable, cache, owner, MOCK_GROUP_MID, {
      sinceMs: t('group-history-005'),
      untilMs: t('group-history-010'),
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'unavailable', message: 'LINE unavailable: network error' }) });
    const urls = spy.mock.calls.map(([input]) => String(input));
    expect(urls.some(u => u.startsWith(deadOrigin) && u.includes('getRecentMessagesV2'))).toBe(true);
    expect(ids(cache.getMessages(owner, MOCK_GROUP_MID))).toEqual(before);
  });
});
