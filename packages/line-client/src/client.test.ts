import { describe, it, expect, vi } from 'vitest';

// Mock signer so no WASM is loaded
vi.mock('./signer', () => ({
  getHmac: vi.fn().mockResolvedValue('fake-hmac'),
  initStorageKey: vi.fn().mockResolvedValue(undefined),
  ensureStorageKey: vi.fn().mockResolvedValue(undefined),
  signForAccount: vi.fn().mockResolvedValue('fake-hmac'),
}));

import {
  LineClient,
  AuthData,
  LineHttpError,
  LineApiError,
  LineNotAuthenticatedError,
  classifyLineReadError,
  LineReadResult,
} from './client';
import { createLineClient } from './index';
import { getHmac, signForAccount } from './signer';

// JWT with exp 10 days from now so refreshIfExpired never triggers
function makeFakeJwt(expOffsetSec = 86400 * 10): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }),
  ).toString('base64url');
  return `header.${payload}.sig`;
}

const baseAuth: AuthData = {
  accessToken: makeFakeJwt(),
  refreshToken: 'rt',
  certificate: 'cert',
  mid: 'u123',
  wrappedNonce: 'wn',
  kdfParameter1: 'k1',
  kdfParameter2: 'k2',
};

// Auth whose JWT expires in 1 h, so every read triggers a token refresh. Use a
// unique mid per test: the static refresh lock is keyed by mid.
function soonAuth(mid: string): AuthData {
  const soonExp = Math.floor(Date.now() / 1000) + 3600;
  const soonJwt = `hdr.${Buffer.from(JSON.stringify({ exp: soonExp })).toString('base64url')}.sig`;
  return { ...baseAuth, mid, accessToken: soonJwt };
}

function apiOk(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function apiErr(code: number, message: string, data: unknown = null): Response {
  return new Response(JSON.stringify({ code, message, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function httpErr(status: number, body = 'error body'): Response {
  return new Response(body, { status });
}

type AuthenticateForRead = { authenticateForRead(): Promise<{ refreshFailedStatus: number | null }> };
function authenticateForRead(client: LineClient): Promise<{ refreshFailedStatus: number | null }> {
  return (client as unknown as AuthenticateForRead).authenticateForRead();
}

// ───────────────────────────────────────────────────────────
// Initial state
// ───────────────────────────────────────────────────────────

describe('LineClient — initial state', () => {
  it('isAuthenticated() returns false with no auth', () => {
    const client = new LineClient();
    expect(client.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated() returns true when auth is passed to constructor', () => {
    const client = new LineClient(baseAuth);
    expect(client.isAuthenticated()).toBe(true);
  });

  it('getCompletedAuth() returns null before login', () => {
    const client = new LineClient(baseAuth);
    expect(client.getCompletedAuth()).toBeNull();
  });

  it('waitForPin() resolves to null when no login is in progress', async () => {
    // No pending login promise — waitForPin returns the stored null promise
    const client = new LineClient(baseAuth);
    // loginPinPromise is null → waitForPin() returns it; await null resolves to null
    const result = await client.waitForPin();
    expect(result).toBeNull();
  });

  it('waitForCompletion() resolves immediately when no pending login', async () => {
    const client = new LineClient(baseAuth);
    await expect(client.waitForCompletion()).resolves.toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────
// getImageBuffer
// ───────────────────────────────────────────────────────────

describe('LineClient.getImageBuffer', () => {
  it('returns buffer and mimeType on success', async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(imageBytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getImageBuffer('https://example.com/img.jpg');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.buffer).toEqual(imageBytes);
  });

  it('strips charset from content-type', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from([1]), {
        status: 200,
        headers: { 'content-type': 'image/png; charset=utf-8' },
      }),
    );
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getImageBuffer('https://example.com/img.png');
    expect(result.mimeType).toBe('image/png');
  });

  it('defaults mimeType to image/jpeg when content-type header is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from([1]), { status: 200 }),
    );
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getImageBuffer('https://example.com/img');
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(httpErr(404));
    const client = new LineClient(baseAuth, mockFetch);
    await expect(client.getImageBuffer('https://example.com/img.jpg')).rejects.toThrow('404');
  });
});

// ───────────────────────────────────────────────────────────
// listChats
// ───────────────────────────────────────────────────────────

describe('LineClient.listChats', () => {
  function makeFetch(routes: Record<string, unknown>) {
    return vi.fn().mockImplementation((url: string) => {
      for (const [fragment, data] of Object.entries(routes)) {
        if (url.includes(fragment)) return Promise.resolve(apiOk(data));
      }
      return Promise.resolve(apiOk(null));
    });
  }

  it('returns groups and contacts merged', async () => {
    const mockFetch = makeFetch({
      getAllChatMids: { memberChatMids: ['g1'], invitedChatMids: [] },
      getAllContactIds: ['u1'],
      getChats: {
        chats: [{ chatMid: 'g1', chatName: 'Test Group', memberCount: 5, picturePath: null }],
      },
      getContactsV2: {
        contacts: {
          u1: { contact: { mid: 'u1', displayName: 'Alice', pictureStatus: null } },
        },
      },
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();

    expect(chats).toHaveLength(2);
    const group = chats.find((c) => c.type === 'group');
    const user = chats.find((c) => c.type === 'user');
    expect(group).toMatchObject({ mid: 'g1', name: 'Test Group', memberCount: 5 });
    expect(user).toMatchObject({ mid: 'u1', name: 'Alice' });
  });

  it('handles empty contacts list', async () => {
    const mockFetch = makeFetch({
      getAllChatMids: { memberChatMids: ['g1'], invitedChatMids: [] },
      getAllContactIds: [],
      getChats: { chats: [{ chatMid: 'g1', chatName: 'Solo Group', memberCount: 1 }] },
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].type).toBe('group');
  });

  it('handles empty groups list', async () => {
    const mockFetch = makeFetch({
      getAllChatMids: { memberChatMids: [], invitedChatMids: [] },
      getAllContactIds: ['u2'],
      getContactsV2: {
        contacts: {
          u2: { contact: { mid: 'u2', displayName: 'Bob' } },
        },
      },
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].type).toBe('user');
  });

  it('builds pictureUrl from picturePath for groups', async () => {
    const mockFetch = makeFetch({
      getAllChatMids: { memberChatMids: ['g1'], invitedChatMids: [] },
      getAllContactIds: [],
      getChats: {
        chats: [{ chatMid: 'g1', chatName: 'G', memberCount: 2, picturePath: '/pic/abc' }],
      },
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();
    expect(chats[0].pictureUrl).toBe('https://profile.line-scdn.net/pic/abc/preview');
  });

  it('builds pictureUrl from pictureStatus for contacts', async () => {
    const mockFetch = makeFetch({
      getAllChatMids: { memberChatMids: [], invitedChatMids: [] },
      getAllContactIds: ['u1'],
      getContactsV2: {
        contacts: {
          u1: { contact: { mid: 'u1', displayName: 'Alice', pictureStatus: 'pic123' } },
        },
      },
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();
    expect(chats[0].pictureUrl).toBe('https://profile.line-scdn.net/pic123/preview');
  });

  it('throws when LINE API returns non-zero code', async () => {
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(apiErr(401, 'not authed')));
    const client = new LineClient(baseAuth, mockFetch);
    await expect(client.listChats()).rejects.toThrow('LINE API error 401');
  });

  it('throws when HTTP response is non-ok', async () => {
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(httpErr(500)));
    const client = new LineClient(baseAuth, mockFetch);
    await expect(client.listChats()).rejects.toThrow('HTTP 500');
  });
});

// ───────────────────────────────────────────────────────────
// getMessages
// ───────────────────────────────────────────────────────────

describe('LineClient.getMessages', () => {
  const rawMessages = [
    {
      id: 'm1',
      from: 'u1',
      to: 'g1',
      toType: 2,
      createdTime: '1700000000000',
      contentType: 0,
      text: 'Hello',
      hasContent: false,
    },
    {
      id: 'm2',
      from: 'u2',
      to: 'g1',
      toType: 2,
      createdTime: '1700000001000',
      contentType: 1,
      hasContent: true,
      contentMetadata: {
        PREVIEW_URL: 'https://obs.line-cdn.net/preview/img.jpg',
        DOWNLOAD_URL: 'https://obs.line-cdn.net/img.jpg',
      },
    },
  ];

  function makeFetch(messages = rawMessages, contacts?: Record<string, unknown>) {
    return vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk(messages));
      if (url.includes('getContactsV2'))
        return Promise.resolve(
          apiOk({
            contacts: contacts ?? {
              u1: { contact: { mid: 'u1', displayName: 'Alice' } },
              u2: { contact: { mid: 'u2', displayName: 'Bob' } },
            },
          }),
        );
      return Promise.resolve(apiOk(null));
    });
  }

  it('resolves sender names from contacts', async () => {
    const client = new LineClient(baseAuth, makeFetch());
    const messages = await client.getMessages('g1', 50);
    expect(messages[0].senderName).toBe('Alice');
    expect(messages[1].senderName).toBe('Bob');
  });

  it('sets previewUrl and downloadUrl for image messages (contentType 1)', async () => {
    const client = new LineClient(baseAuth, makeFetch());
    const messages = await client.getMessages('g1', 50);
    const imgMsg = messages.find((m) => m.contentType === 1);
    expect(imgMsg?.previewUrl).toBe('https://obs.line-cdn.net/preview/img.jpg');
    expect(imgMsg?.downloadUrl).toBe('https://obs.line-cdn.net/img.jpg');
  });

  it('does not set previewUrl for non-image messages', async () => {
    const client = new LineClient(baseAuth, makeFetch());
    const messages = await client.getMessages('g1', 50);
    const textMsg = messages.find((m) => m.contentType === 0);
    expect(textMsg?.previewUrl).toBeUndefined();
    expect(textMsg?.downloadUrl).toBeUndefined();
  });

  it('returns empty array for empty response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(apiOk([]));
    const client = new LineClient(baseAuth, mockFetch);
    const messages = await client.getMessages('g1', 50);
    expect(messages).toHaveLength(0);
  });

  it('uses cached contact names and skips re-fetching', async () => {
    const mockFetch = makeFetch();
    const client = new LineClient(baseAuth, mockFetch);

    // First call populates the cache
    await client.getMessages('g1', 2);
    const callsAfterFirst = mockFetch.mock.calls.length;

    // Second call with the same senders should not fetch contacts again
    await client.getMessages('g1', 2);
    const callsAfterSecond = mockFetch.mock.calls.length;

    // Only getRecentMessagesV2 was called again, not getContactsV2
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });

  it('leaves senderName undefined when contact resolution fails', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk(rawMessages));
      if (url.includes('getContactsV2')) return Promise.resolve(apiOk({ contacts: {} }));
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const messages = await client.getMessages('g1', 50);
    expect(messages[0].senderName).toBeUndefined();
  });

  it('throws on LINE API error', async () => {
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(apiErr(500, 'internal')));
    const client = new LineClient(baseAuth, mockFetch);
    await expect(client.getMessages('g1', 10)).rejects.toThrow('LINE API error 500');
  });
});

// ───────────────────────────────────────────────────────────
// JWT expiry parsing
// ───────────────────────────────────────────────────────────

describe('LineClient — JWT expiry', () => {
  it('refreshes token when JWT exp is within 24 hours', async () => {
    const soonExp = Math.floor(Date.now() / 1000) + 3600; // 1h from now
    const soonJwt = `hdr.${Buffer.from(JSON.stringify({ exp: soonExp })).toString('base64url')}.sig`;

    const newToken = makeFakeJwt();
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('tokenRefresh'))
        return Promise.resolve(
          new Response(JSON.stringify({ accessToken: newToken }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (url.includes('getAllChatMids')) return Promise.resolve(apiOk({ memberChatMids: [], invitedChatMids: [] }));
      if (url.includes('getAllContactIds')) return Promise.resolve(apiOk([]));
      return Promise.resolve(apiOk(null));
    });

    const auth: AuthData = { ...baseAuth, accessToken: soonJwt };
    const onTokenRefreshed = vi.fn();
    const client = new LineClient(auth, mockFetch, onTokenRefreshed);
    await client.listChats();

    const refreshCall = mockFetch.mock.calls.find(([url]: string[]) => url.includes('tokenRefresh'));
    expect(refreshCall).toBeTruthy();
    // The fresh token is surfaced via the onTokenRefreshed callback as an
    // immutable snapshot — the caller's own `auth` object must NOT be mutated
    // in place (that used to be how callers picked up the refreshed token,
    // which meant refreshIfExpired() silently mutated shared caller state).
    expect(onTokenRefreshed).toHaveBeenCalledWith(expect.objectContaining({ accessToken: newToken }));
    expect(auth.accessToken).toBe(soonJwt);
  });

  it('does not refresh when JWT exp is more than 24 hours away', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getAllChatMids')) return Promise.resolve(apiOk({ memberChatMids: [], invitedChatMids: [] }));
      if (url.includes('getAllContactIds')) return Promise.resolve(apiOk([]));
      return Promise.resolve(apiOk(null));
    });

    const client = new LineClient(baseAuth, mockFetch);
    await client.listChats();

    const refreshCall = mockFetch.mock.calls.find(([url]: string[]) => url.includes('tokenRefresh'));
    expect(refreshCall).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────
// Contact name batching
// ───────────────────────────────────────────────────────────

describe('LineClient — contact batching in fetchContactsV2', () => {
  it('batches contacts into groups of 50', async () => {
    const mids = Array.from({ length: 110 }, (_, i) => `u${i}`);

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes('getAllChatMids')) return Promise.resolve(apiOk({ memberChatMids: [], invitedChatMids: [] }));
      if (url.includes('getAllContactIds')) return Promise.resolve(apiOk(mids));
      if (url.includes('getContactsV2')) {
        // Return only the mids requested in this batch
        const body = JSON.parse((opts?.body as string) ?? '[[]]');
        const batch: string[] = body[0]?.targetUserMids ?? [];
        const contacts: Record<string, unknown> = {};
        for (const mid of batch) contacts[mid] = { contact: { mid, displayName: mid } };
        return Promise.resolve(apiOk({ contacts }));
      }
      return Promise.resolve(apiOk(null));
    });

    const client = new LineClient(baseAuth, mockFetch);
    const chats = await client.listChats();

    const contactCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getContactsV2'),
    );
    // 110 contacts → ceil(110/50) = 3 batches
    expect(contactCalls.length).toBe(3);
    expect(chats.filter((c) => c.type === 'user')).toHaveLength(110);
  });
});

// ───────────────────────────────────────────────────────────
// getMessagesInRange
// ───────────────────────────────────────────────────────────

describe('LineClient.getMessagesInRange', () => {
  function rawMsg(id: string, createdTime: string, from = 'u1') {
    return { id, from, to: 'g1', toType: 2, createdTime, contentType: 0, text: 'txt', hasContent: false };
  }

  it('returns empty array when no messages exist', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk([]));
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false);
    expect(result).toHaveLength(0);
  });

  it('returns messages within range from a single page', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1700000002000'),
          rawMsg('m2', '1700000003000'),
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000001000, false);
    expect(result).toHaveLength(2);
    expect(result.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('filters out messages older than sinceMs', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000'), // before sinceMs
          rawMsg('m2', '1700000002000'), // after sinceMs
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m2');
  });

  it('paginates backwards and stops when oldest message is before sinceMs', async () => {
    // pageSize=2: first page is full → triggers pagination
    // second page contains one message before sinceMs → stops
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m3', '1700000003000'),
          rawMsg('m4', '1700000004000'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000'), // before sinceMs
          rawMsg('m2', '1700000002000'), // after sinceMs
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    // m1 filtered out; m2, m3, m4 kept
    expect(result).toHaveLength(3);
    expect(result.map(m => m.id).sort()).toEqual(['m2', 'm3', 'm4']);
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls).toHaveLength(1);
  });

  it('stops pagination when previous page is empty (end of history)', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1700000001000'),
          rawMsg('m2', '1700000002000'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    expect(result).toHaveLength(2);
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls).toHaveLength(1);
  });

  it('resolves contact names once across all pages', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m3', '1700000003000', 'u1'),
          rawMsg('m4', '1700000004000', 'u2'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000', 'u3'), // before sinceMs — filtered out
          rawMsg('m2', '1700000002000', 'u4'),
        ]));
      }
      if (url.includes('getContactsV2')) {
        return Promise.resolve(apiOk({
          contacts: {
            u1: { contact: { mid: 'u1', displayName: 'Alice' } },
            u2: { contact: { mid: 'u2', displayName: 'Bob' } },
            u4: { contact: { mid: 'u4', displayName: 'Dave' } },
          },
        }));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, true, 2);
    const contactCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getContactsV2'),
    );
    expect(contactCalls).toHaveLength(1); // one batch for all in-range messages
    expect(result.find(m => m.id === 'm4')?.senderName).toBe('Bob');
    expect(result.find(m => m.id === 'm2')?.senderName).toBe('Dave');
  });

  // Progress guard tests (issue #37): non-advancing pagination must terminate

  it('terminates when the boundary message is re-included by every previous-page call', async () => {
    // pageSize=2, first page is full and above sinceMs. The previous-page API
    // re-includes the boundary message (oldest of the current page) every call,
    // alongside genuinely older messages — so without a progress guard the
    // loop would re-request the same boundary forever.
    const recent = [
      rawMsg('m4', '1700000004000'),
      rawMsg('m3', '1700000003000'),
    ];
    // First previous-page call: re-includes m3 (the boundary) plus an older m2.
    // Second previous-page call: re-includes m2 (now the boundary) plus older m1.
    // Third previous-page call: re-includes m1 plus nothing newer → m1 is the
    // boundary again and the only returned message is m1 itself.
    const prevPages = [
      [rawMsg('m3', '1700000003000'), rawMsg('m2', '1700000002000')],
      [rawMsg('m2', '1700000002000'), rawMsg('m1', '1699999999000')],
      [rawMsg('m1', '1699999999000')],
    ];
    let prevCall = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk(recent));
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk(prevPages[prevCall++] ?? []));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    // No duplicates despite boundary re-inclusion.
    const ids = result.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // m1 (before sinceMs) filtered out; m2, m3, m4 kept.
    expect(ids.sort()).toEqual(['m2', 'm3', 'm4']);
    // Loop must terminate: at most prevPages.length previous-page calls.
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls.length).toBeLessThanOrEqual(prevPages.length);
  });

  it('terminates when a full page is returned at the same createdTime (clock tie)', async () => {
    // pageSize=2, first page is full and above sinceMs. The previous-page API
    // returns a full page whose every message shares the current oldest
    // createdTime (clock collision). Without a strict-backwards guard the
    // loop would never advance past that millisecond.
    const recent = [
      rawMsg('m4', '1700000004000'),
      rawMsg('m3', '1700000003000'),
    ];
    let prevCall = 0;
    const prevPages = [
      // Both at the same ms as m3 (the current oldest). Different ids, so a
      // naive dedupe-only guard would still loop forever.
      [rawMsg('m5', '1700000003000'), rawMsg('m6', '1700000003000')],
    ];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk(recent));
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk(prevPages[prevCall++] ?? []));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    // Loop terminates after the single non-advancing previous-page call.
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls).toHaveLength(1);
    // m3, m4 from the recent page are in range and kept.
    expect(result.map(m => m.id).sort()).toEqual(['m3', 'm4']);
  });
});

// ───────────────────────────────────────────────────────────
// getMessagesBetween
// ───────────────────────────────────────────────────────────

describe('LineClient.getMessagesBetween', () => {
  type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

  function raw(id: string, createdTime: number, from = 'u1') {
    return { id, from, to: 'g1', toType: 2, createdTime: String(createdTime), contentType: 0, text: 'txt', hasContent: false };
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  const flush = () => new Promise(r => setTimeout(r, 0));

  function refreshOk(accessToken = makeFakeJwt()): Response {
    return new Response(JSON.stringify({ accessToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function makeFetch(routes: { recent?: Route; previous?: Route; contacts?: Route; refresh?: Route } = {}) {
    return vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      const route: Route =
        url.includes('tokenRefresh') ? routes.refresh ?? (() => refreshOk())
        : url.includes('getRecentMessagesV2') ? routes.recent ?? (() => apiOk([]))
        : url.includes('getPreviousMessagesV2WithRequest') ? routes.previous ?? (() => apiOk([]))
        : url.includes('getContactsV2') ? routes.contacts ?? (() => apiOk({ contacts: {} }))
        : () => apiOk(null);
      return Promise.resolve(route(url, init));
    });
  }

  function callsTo(fetchFn: ReturnType<typeof makeFetch>, name: string) {
    return fetchFn.mock.calls.filter(([url]) => url.includes(name));
  }

  function boundary(init?: RequestInit): { messageId: string; deliveredTime: string } {
    const [req] = JSON.parse(String(init?.body)) as [{ endMessageId: { messageId: string; deliveredTime: string } }];
    return req.endMessageId;
  }

  function setPageSize(client: LineClient, size: number) {
    (client as unknown as { rangePageSize: number }).rangePageSize = size;
  }

  function value(result: LineReadResult) {
    if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`);
    return result.value;
  }

  const ids = (result: LineReadResult) => value(result).messages.map(m => m.id).sort();

  const ABORTED = { ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: aborted' } };

  // ── Range and coverage ────────────────────────────────────

  it('returns exactly the range across pages', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m5', 5000), raw('m6', 6000)]),
      previous: (_url, init) => {
        const { messageId } = boundary(init);
        if (messageId === 'm5') return apiOk([raw('m3', 3000), raw('m4', 4000)]);
        if (messageId === 'm3') return apiOk([raw('m1', 1000), raw('m2', 2000)]);
        throw new Error(`unexpected boundary ${messageId}`);
      },
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 2000, 4000);
    expect(ids(result)).toEqual(['m2', 'm3', 'm4']);
    expect(value(result).coverage).toBe('complete');
    expect(value(result).oldestReachedMs).toBe(1000);
  });

  it('includes both bounds', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m1', 1000), raw('m2', 2000), raw('m3', 3000), raw('m4', 4000)]),
    });
    const client = new LineClient(baseAuth, fetchFn);

    const result = await client.getMessagesBetween('g1', 2000, 3000);
    expect(ids(result)).toEqual(['m2', 'm3']);
    expect(value(result).coverage).toBe('complete');
  });

  it('empty range inside history', async () => {
    const fetchFn = makeFetch({ recent: () => apiOk([raw('m1', 1000), raw('m5', 5000)]) });
    const client = new LineClient(baseAuth, fetchFn);

    const result = await client.getMessagesBetween('g1', 2000, 4000);
    expect(value(result)).toEqual({ messages: [], coverage: 'complete', oldestReachedMs: 1000 });
  });

  it('inclusive pagination ends in history_end', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: (_url, init) => {
        const { messageId } = boundary(init);
        if (messageId === 'm3') return apiOk([raw('m2', 2000), raw('m3', 3000)]);
        if (messageId === 'm2') return apiOk([raw('m2', 2000)]);
        throw new Error(`unexpected boundary ${messageId}`);
      },
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(ids(result)).toEqual(['m2', 'm3', 'm4']);
    expect(value(result).coverage).toBe('history_end');
    expect(value(result).oldestReachedMs).toBe(2000);
  });

  it('short recent page is history_end', async () => {
    const fetchFn = makeFetch({ recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]) });
    const client = new LineClient(baseAuth, fetchFn);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(ids(result)).toEqual(['m3', 'm4']);
    expect(value(result).coverage).toBe('history_end');
    expect(value(result).oldestReachedMs).toBe(3000);
    expect(callsTo(fetchFn, 'getPreviousMessagesV2WithRequest')).toHaveLength(0);
  });

  it('empty chat', async () => {
    const fetchFn = makeFetch({ recent: () => apiOk([]) });
    const client = new LineClient(baseAuth, fetchFn);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(value(result)).toEqual({ messages: [], coverage: 'history_end', oldestReachedMs: null });
  });

  it('empty previous page is history_end', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: () => apiOk([]),
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(ids(result)).toEqual(['m3', 'm4']);
    expect(value(result).coverage).toBe('history_end');
    expect(value(result).oldestReachedMs).toBe(3000);
  });

  it('replayed full page is truncated', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(value(result).coverage).toBe('truncated');
  });

  it('short replay is truncated', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000), raw('m5', 5000)]),
      previous: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 3);

    const result = await client.getMessagesBetween('g1', 0, 6000);
    expect(value(result).coverage).toBe('truncated');
  });

  it('boundary-only previous page is history_end', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: () => apiOk([raw('m3', 3000)]),
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(value(result).coverage).toBe('history_end');
  });

  it('progress-guard stop keeps received messages', async () => {
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('a', 3000), raw('b', 3000)]),
      previous: () => apiOk([raw('c', 3000), raw('d', 3000)]),
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 1000, 4000);
    expect(ids(result)).toEqual(['a', 'b', 'c', 'd']);
    expect(value(result).coverage).toBe('truncated');
    expect(callsTo(fetchFn, 'getPreviousMessagesV2WithRequest')).toHaveLength(1);
  });

  function capFetch(lastPage?: (t: number) => ReturnType<typeof raw>[]) {
    let n = 0;
    return makeFetch({
      recent: () => apiOk([raw('x1', 2_000_000), raw('x2', 2_000_001)]),
      previous: (_url, init) => {
        n++;
        const t = parseInt(boundary(init).deliveredTime, 10);
        if (n === 1000 && lastPage) return apiOk(lastPage(t));
        return apiOk([raw(`p${n}a`, t - 2), raw(`p${n}b`, t - 1)]);
      },
    });
  }

  it('iteration cap is truncated', async () => {
    const fetchFn = capFetch();
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 3_000_000);
    expect(value(result).coverage).toBe('truncated');
    expect(value(result).messages).toHaveLength(2002);
    expect(callsTo(fetchFn, 'getPreviousMessagesV2WithRequest')).toHaveLength(1000);
  });

  it('terminal page on the last allowed request is history_end', async () => {
    const fetchFn = capFetch(t => [raw('last', t - 1)]);
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 0, 3_000_000);
    expect(value(result).coverage).toBe('history_end');
    expect(callsTo(fetchFn, 'getPreviousMessagesV2WithRequest')).toHaveLength(1000);
  });

  it('crossing sinceMs on the last allowed request is complete', async () => {
    const fetchFn = capFetch(t => [raw('old', 5), raw('last', t - 1)]);
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    const result = await client.getMessagesBetween('g1', 1000, 3_000_000);
    expect(value(result).coverage).toBe('complete');
    expect(value(result).oldestReachedMs).toBe(5);
  });

  it('rejects invalid arguments without a request', async () => {
    const fetchFn = makeFetch();
    const client = new LineClient(baseAuth, fetchFn);

    for (const [since, until] of [[5000, 4000], [-1, 10], [NaN, 10], [0, Infinity]]) {
      await expect(client.getMessagesBetween('g1', since, until)).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // ── Errors ────────────────────────────────────────────────

  it('maps 401 to session_expired', async () => {
    const fetchFn = makeFetch({ recent: () => httpErr(401) });
    const client = new LineClient(baseAuth, fetchFn);
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'session_expired', message: 'LINE session expired; log in again' },
    });
    expect(callsTo(fetchFn, 'tokenRefresh')).toHaveLength(0);
  });

  it('maps 500 to unavailable', async () => {
    const client = new LineClient(baseAuth, makeFetch({ recent: () => httpErr(500) }));
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: HTTP 500' },
    });
  });

  it('maps business error to unavailable', async () => {
    const client = new LineClient(baseAuth, makeFetch({ recent: () => apiErr(10004, 'x') }));
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: LINE error 10004' },
    });
  });

  it('maps rejected fetch to unavailable', async () => {
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => { throw new TypeError('fetch failed'); },
    }));
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: network error' },
    });
  });

  it('malformed business code is not leaked', async () => {
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => new Response(JSON.stringify({ code: 'eyJsecret', message: 'x', data: null }), { status: 200 }),
    }));
    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', message: 'LINE unavailable: LINE error' } });
    expect(JSON.stringify(result)).not.toContain('eyJsecret');
  });

  it('not authenticated is session_expired', async () => {
    const fetchFn = makeFetch();
    const client = new LineClient(null, fetchFn);
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'session_expired', message: 'LINE session expired; log in again' },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refresh 500 then 401 is unavailable', async () => {
    const client = new LineClient(soonAuth('between-refresh-500'), makeFetch({
      refresh: () => httpErr(500),
      recent: () => httpErr(401),
    }));
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: token refresh failed' },
    });
  });

  it('overlapping reads keep their own refresh outcome', async () => {
    const refreshA = deferred<Response>();
    const refreshAEntered = deferred<void>();
    const recentA = deferred<Response>();
    const recentAEntered = deferred<void>();
    let refreshCalls = 0;
    let recentCalls = 0;
    const fetchFn = makeFetch({
      refresh: () => {
        refreshCalls++;
        if (refreshCalls === 1) { refreshAEntered.resolve(); return refreshA.promise; }
        return refreshOk();
      },
      recent: () => {
        recentCalls++;
        if (recentCalls === 1) { recentAEntered.resolve(); return recentA.promise; }
        return apiOk([]);
      },
    });
    const client = new LineClient(soonAuth('between-overlap-outcome'), fetchFn);

    const a = client.getMessagesBetween('g1', 0, 5000);
    await refreshAEntered.promise;
    refreshA.resolve(httpErr(500));
    await recentAEntered.promise;

    const b = await client.getMessagesBetween('g1', 0, 5000);
    expect(b.ok).toBe(true);
    expect(refreshCalls).toBe(2);

    recentA.resolve(httpErr(401));
    expect(await a).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: token refresh failed' },
    });
  });

  it('refresh 401 is best-effort', async () => {
    const auth = soonAuth('between-refresh-401');
    const fetchFn = makeFetch({
      refresh: () => httpErr(401),
      recent: () => apiOk([raw('m1', 1000)]),
    });
    const client = new LineClient(auth, fetchFn);

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(ids(result)).toEqual(['m1']);
    const [[, init]] = callsTo(fetchFn, 'getRecentMessagesV2');
    expect((init?.headers as Record<string, string>)['x-line-access']).toBe(auth.accessToken);
  });

  it('header token matches the signed token during an overlapping refresh', async () => {
    const auth = soonAuth('between-header-token');
    const newToken = makeFakeJwt();
    let refreshCalls = 0;
    const fetchFn = makeFetch({
      refresh: () => (++refreshCalls === 1 ? httpErr(500) : refreshOk(newToken)),
      recent: () => apiOk([]),
    });
    const client = new LineClient(auth, fetchFn);
    const signerEntered = deferred<void>();
    const signerGate = deferred<string>();
    let signedToken: string | undefined;
    vi.mocked(signForAccount).mockImplementationOnce((_account, input) => {
      signedToken = input.accessToken;
      signerEntered.resolve();
      return signerGate.promise;
    });

    const a = client.getMessagesBetween('g1', 0, 5000);
    await signerEntered.promise;
    expect((await client.getMessagesBetween('g1', 0, 5000)).ok).toBe(true);
    expect(refreshCalls).toBe(2);
    signerGate.resolve('fake-hmac');
    expect((await a).ok).toBe(true);

    const headerTokens = callsTo(fetchFn, 'getRecentMessagesV2')
      .map(([, init]) => (init?.headers as Record<string, string>)['x-line-access']);
    expect(signedToken).toBe(auth.accessToken);
    // B sent the refreshed token; A must send the token it signed, not B's.
    expect(headerTokens.sort()).toEqual([signedToken, newToken].sort());
  });

  it('fails whole range when a later page fails', async () => {
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: () => httpErr(500),
    }));
    setPageSize(client, 2);
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: HTTP 500' },
    });
  });

  it('fails whole range when contacts fail', async () => {
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => apiOk([raw('m1', 1000)]),
      contacts: () => httpErr(500),
    }));
    expect(await client.getMessagesBetween('g1', 0, 5000)).toEqual({
      ok: false,
      error: { kind: 'unavailable', message: 'LINE unavailable: HTTP 500' },
    });
  });

  it('resolves sender names', async () => {
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => apiOk([raw('m1', 1000)]),
      contacts: () => apiOk({ contacts: { u1: { contact: { mid: 'u1', displayName: 'Alice' } } } }),
    }));
    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(value(result).messages[0].senderName).toBe('Alice');
  });

  // ── Abort ─────────────────────────────────────────────────

  it('already-aborted signal', async () => {
    const fetchFn = makeFetch();
    const client = new LineClient(baseAuth, fetchFn);
    const controller = new AbortController();
    controller.abort();

    expect(await client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal })).toEqual(ABORTED);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborts between pages', async () => {
    const controller = new AbortController();
    const fetchFn = makeFetch({
      recent: () => apiOk([raw('m3', 3000), raw('m4', 4000)]),
      previous: () => {
        controller.abort();
        return apiOk([raw('m1', 1000), raw('m2', 2000)]);
      },
    });
    const client = new LineClient(baseAuth, fetchFn);
    setPageSize(client, 2);

    expect(await client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal })).toEqual(ABORTED);
    await flush();
    expect(callsTo(fetchFn, 'getPreviousMessagesV2WithRequest')).toHaveLength(1);
  });

  it.each([
    { name: 'aborts while signing is blocked', stopPropagation: false },
    { name: 'abort seen despite stopImmediatePropagation', stopPropagation: true },
  ])('$name', async ({ stopPropagation }) => {
    const fetchFn = makeFetch();
    const client = new LineClient(baseAuth, fetchFn);
    const controller = new AbortController();
    if (stopPropagation) {
      controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    }
    const signerEntered = deferred<void>();
    const signerGate = deferred<string>();
    vi.mocked(signForAccount).mockImplementationOnce(() => {
      signerEntered.resolve();
      return signerGate.promise;
    });

    const read = client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal });
    await signerEntered.promise;
    controller.abort();
    expect(await read).toEqual(ABORTED);

    signerGate.resolve('fake-hmac');
    await flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a read that joined another read's refresh", async () => {
    const refreshEntered = deferred<void>();
    const refresh = deferred<Response>();
    const fetchFn = makeFetch({
      refresh: () => { refreshEntered.resolve(); return refresh.promise; },
      recent: () => apiOk([]),
    });
    const client = new LineClient(soonAuth('between-joined-refresh'), fetchFn);
    const controller = new AbortController();

    const a = client.getMessagesBetween('g1', 0, 5000);
    await refreshEntered.promise;
    let bSettled = false;
    const b = client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal })
      .finally(() => { bSettled = true; });
    await flush();
    expect(bSettled).toBe(false);
    expect(callsTo(fetchFn, 'tokenRefresh')).toHaveLength(1);
    expect(callsTo(fetchFn, 'getRecentMessagesV2')).toHaveLength(0);

    controller.abort();
    expect(await b).toEqual(ABORTED);

    refresh.resolve(refreshOk());
    expect((await a).ok).toBe(true);
    await flush();
    expect(callsTo(fetchFn, 'tokenRefresh')).toHaveLength(1);
    expect(callsTo(fetchFn, 'getRecentMessagesV2')).toHaveLength(1);
  });

  it('abort raised synchronously inside the refresh fetch', async () => {
    const controller = new AbortController();
    const refresh = deferred<Response>();
    const fetchFn = makeFetch({
      refresh: () => { controller.abort(); return refresh.promise; },
    });
    const client = new LineClient(soonAuth('u-sync-abort'), fetchFn);

    expect(await client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal })).toEqual(ABORTED);

    refresh.resolve(refreshOk());
    await flush();
    expect(callsTo(fetchFn, 'getRecentMessagesV2')).toHaveLength(0);
  });

  it('abort wins over a ready 401', async () => {
    const controller = new AbortController();
    const recentEntered = deferred<void>();
    const recent = deferred<Response>();
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => { recentEntered.resolve(); return recent.promise; },
    }));

    const read = client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal });
    await recentEntered.promise;
    controller.abort(new Error('deadline'));
    recent.resolve(httpErr(401));
    expect(await read).toEqual(ABORTED);
  });

  it('aborts during a hanging 401 body', async () => {
    const controller = new AbortController();
    const bodyEntered = deferred<void>();
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => ({
        ok: false,
        status: 401,
        text: () => { bodyEntered.resolve(); return new Promise<string>(() => {}); },
      }) as unknown as Response,
    }));

    const read = client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal });
    await bodyEntered.promise;
    controller.abort(new Error('deadline'));
    expect(await read).toEqual(ABORTED);
  });

  it('aborts during contact lookup', async () => {
    const controller = new AbortController();
    const contactsEntered = deferred<void>();
    const client = new LineClient(baseAuth, makeFetch({
      recent: () => apiOk([raw('m1', 1000)]),
      contacts: (_url, init) => {
        contactsEntered.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      },
    }));

    const read = client.getMessagesBetween('g1', 0, 5000, { signal: controller.signal });
    await contactsEntered.promise;
    controller.abort();
    expect(await read).toEqual(ABORTED);
  });
});

// ───────────────────────────────────────────────────────────
// Concurrent refresh deduplication
// ───────────────────────────────────────────────────────────

describe('LineClient — concurrent refresh deduplication', () => {
  function makeSoonAuth(mid: string): AuthData {
    const soonExp = Math.floor(Date.now() / 1000) + 3600;
    const soonJwt = `hdr.${Buffer.from(JSON.stringify({ exp: soonExp })).toString('base64url')}.sig`;
    return { ...baseAuth, mid, accessToken: soonJwt };
  }

  function makeRefreshFetch() {
    return vi.fn().mockImplementation((url: string) => {
      if (url.includes('tokenRefresh'))
        return Promise.resolve(new Response(JSON.stringify({ accessToken: makeFakeJwt() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      if (url.includes('getAllChatMids')) return Promise.resolve(apiOk({ memberChatMids: [], invitedChatMids: [] }));
      if (url.includes('getAllContactIds')) return Promise.resolve(apiOk([]));
      return Promise.resolve(apiOk(null));
    });
  }

  it('two instances with the same mid fire only one tokenRefresh call', async () => {
    const auth = makeSoonAuth('concurrent-mid-1');
    const mockFetch = makeRefreshFetch();
    const client1 = new LineClient(auth, mockFetch);
    const client2 = new LineClient(auth, mockFetch);

    await Promise.all([client1.listChats(), client2.listChats()]);

    const refreshCalls = mockFetch.mock.calls.filter(([url]: string[]) => url.includes('tokenRefresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('calls onTokenRefreshed exactly once after a successful refresh', async () => {
    const auth = makeSoonAuth('callback-mid-1');
    const mockFetch = makeRefreshFetch();
    const callback = vi.fn();
    const client = new LineClient(auth, mockFetch, callback);

    await client.listChats();

    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('LineClient — authenticateForRead', () => {
  it('no auth → LineNotAuthenticatedError', async () => {
    const mockFetch = vi.fn();
    const client = new LineClient(null, mockFetch);

    const err = await authenticateForRead(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineNotAuthenticatedError);
    expect((err as Error).message).toBe('Not authenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refresh failure is returned to each joined caller', async () => {
    const soonExp = Math.floor(Date.now() / 1000) + 3600;
    const soonJwt = `hdr.${Buffer.from(JSON.stringify({ exp: soonExp })).toString('base64url')}.sig`;
    let resolveRefresh: ((r: Response) => void) | undefined;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('tokenRefresh')) {
        return new Promise<Response>(resolve => { resolveRefresh = resolve; });
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient({ ...baseAuth, mid: 'read-refresh-fail-mid', accessToken: soonJwt }, mockFetch);

    const first = authenticateForRead(client);
    const second = authenticateForRead(client);
    await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));
    resolveRefresh!(httpErr(500));

    await expect(first).resolves.toEqual({ refreshFailedStatus: 500 });
    await expect(second).resolves.toEqual({ refreshFailedStatus: 500 });
    const refreshCalls = mockFetch.mock.calls.filter(([url]: string[]) => url.includes('tokenRefresh'));
    expect(refreshCalls).toHaveLength(1);
    expect((client as unknown as { auth: AuthData }).auth.accessToken).toBe(soonJwt);
  });
});

describe('LineClient QR login', () => {
  function makeLoginFetch(verifyResponse: Response) {
    const calls: Array<{ url: string; body: unknown[]; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '[]')) as unknown[];
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, body, headers });
      if (url.includes('createSession')) return apiOk({ authSessionId: 'session-1' });
      if (url.includes('createQrCode')) return apiOk({
        callbackUrl: 'https://line.me/R/nv/QRLogin?sid=session-1',
        longPollingMaxCount: 1,
        longPollingIntervalSec: 1,
      });
      if (url.includes('checkQrCodeVerified')) return apiOk({});
      if (url.includes('verifyCertificate')) return verifyResponse;
      if (url.includes('createPinCode')) return apiOk({ pinCode: '123456' });
      if (url.includes('checkPinCodeVerified')) return apiOk({});
      if (url.includes('qrCodeLoginV2')) return apiOk({
        certificate: 'replacement-cert',
        tokenV3IssueResult: { accessToken: makeFakeJwt(), refreshToken: 'new-refresh' },
        mid: 'u123',
      });
      if (url.includes('getEncryptedIdentityV3')) return apiOk({
        wrappedNonce: 'new-nonce',
        kdfParameter1: 'new-kdf1',
        kdfParameter2: 'new-kdf2',
      });
      return apiOk({});
    });
    return { fetchFn, calls };
  }

  it('uses an explicit certificate, keeps QR bootstrap unauthenticated, and skips PIN when accepted', async () => {
    const { fetchFn, calls } = makeLoginFetch(apiOk({}));
    const client = new LineClient(baseAuth, fetchFn);
    vi.mocked(getHmac).mockClear();

    await client.login('saved-cert');
    await expect(client.waitForPin()).resolves.toBeNull();
    await client.waitForCompletion();

    const bootstrap = calls.filter(call =>
      call.url.includes('createSession') || call.url.includes('createQrCode'));
    expect(bootstrap.every(call => call.headers['x-line-access'] === undefined)).toBe(true);
    expect(vi.mocked(getHmac).mock.calls.slice(0, 2).every(([input]) => input.accessToken === '')).toBe(true);
    const verify = calls.find(call => call.url.includes('verifyCertificate'))!;
    expect(verify.body).toEqual([{ authSessionId: 'session-1', certificate: 'saved-cert' }]);
    expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
    expect(calls.some(call => call.url.includes('checkPinCodeVerified'))).toBe(false);
  });

  it('falls back to one PIN flow for LINE certificate rejection status', async () => {
    const { fetchFn, calls } = makeLoginFetch(apiErr(10051, 'rejected', { code: 2 }));
    const client = new LineClient(null, fetchFn);

    await client.login('stale-cert');
    await expect(client.waitForPin()).resolves.toBe('123456');
    await client.waitForCompletion();

    expect(calls.filter(call => call.url.includes('createPinCode'))).toHaveLength(1);
    expect(calls.filter(call => call.url.includes('checkPinCodeVerified'))).toHaveLength(1);
    expect(client.getCompletedAuth()?.certificate).toBe('replacement-cert');
  });

  it('delivers a rejected-certificate PIN without writing it to stderr', async () => {
    const pinCode = '123456';
    const { fetchFn } = makeLoginFetch(apiErr(10051, 'rejected', { code: 2 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new LineClient(null, fetchFn);

    await client.login('stale-cert');
    await expect(client.waitForPin()).resolves.toBe(pinCode);
    await client.waitForCompletion();

    const logs = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(logs).not.toContain(pinCode);
  });

  it('falls back to the PIN flow when real LINE reports certificate rejection as HTTP 400', async () => {
    // Real LINE answers verifyCertificate with HTTP 400 carrying the business
    // envelope ({ code: 10051, data: { code: 2 } }), unlike the mock which
    // returns the same envelope with HTTP 200.
    const { fetchFn, calls } = makeLoginFetch(httpErr(400, JSON.stringify({
      code: 10051,
      message: 'RESPONSE_ERROR',
      data: {
        name: 'SecondaryQrCodeException',
        message: 'SecondaryQrCodeException',
        code: 2,
        alertMessage: 'The verification code you entered is incorrect.',
      },
    })));
    const client = new LineClient(null, fetchFn);

    await client.login('stale-cert');
    await expect(client.waitForPin()).resolves.toBe('123456');
    await client.waitForCompletion();

    expect(calls.filter(call => call.url.includes('createPinCode'))).toHaveLength(1);
    expect(client.getCompletedAuth()?.certificate).toBe('replacement-cert');
  });

  it('fails login instead of entering PIN on a verifyCertificate server failure', async () => {
    const { fetchFn, calls } = makeLoginFetch(httpErr(500));
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await client.waitForPin();
    await expect(client.waitForCompletion()).rejects.toThrow('HTTP 500');
    expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
  });

  it('fails login instead of entering PIN on a verifyCertificate API server error', async () => {
    const { fetchFn, calls } = makeLoginFetch(apiErr(500, 'internal server error'));
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await client.waitForPin();
    await expect(client.waitForCompletion()).rejects.toThrow('LINE API error 500');
    expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
  });

  it('fails login instead of entering PIN on an unrelated verifyCertificate client error', async () => {
    const { fetchFn, calls } = makeLoginFetch(apiErr(400, 'bad request'));
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await client.waitForPin();
    await expect(client.waitForCompletion()).rejects.toThrow('LINE API error 400');
    expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
  });

  it('omits remote error text from login diagnostics', async () => {
    const remoteErrorText = 'access-token-secret refresh-token-secret certificate-secret identity-secret';
    const { fetchFn } = makeLoginFetch(httpErr(500, remoteErrorText));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await client.waitForPin();
    await expect(client.waitForCompletion()).rejects.toThrow('HTTP 500');

    const logs = stderr.mock.calls.map(([message]) => String(message)).join('');
    expect(logs).not.toContain(remoteErrorText);
    expect(logs).toContain('[LINE] HTTP 500');
  });

  it('PIN pending → throws without waiting', async () => {
    const { fetchFn: baseFetch, calls } = makeLoginFetch(apiErr(10051, 'rejected', { code: 2 }));
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('checkPinCodeVerified')) {
        calls.push({ url, body: [], headers: {} });
        return new Promise<Response>(() => {});
      }
      return baseFetch(url, init);
    });
    const client = new LineClient(null, fetchFn);

    await client.login('stale-cert');
    await expect(client.waitForPin()).resolves.toBe('123456');

    const err = await authenticateForRead(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineNotAuthenticatedError);
    expect((err as Error).message).toBe('Login in progress');
    expect(calls.some(call => call.url.includes('getRecentMessagesV2'))).toBe(false);
  });

  it('login failed keeps cause', async () => {
    const { fetchFn } = makeLoginFetch(httpErr(500));
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await expect(client.waitForCompletion()).rejects.toThrow('HTTP 500');

    const err = await authenticateForRead(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LineNotAuthenticatedError);
    expect((err as Error).message).toBe('Login failed');
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(LineHttpError);
    expect((cause as LineHttpError).status).toBe(500);
  });

  it('getMessagesBetween: PIN pending is session_expired', async () => {
    const { fetchFn: baseFetch, calls } = makeLoginFetch(apiErr(10051, 'rejected', { code: 2 }));
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('checkPinCodeVerified')) return new Promise<Response>(() => {});
      return baseFetch(url, init);
    });
    const client = new LineClient(null, fetchFn);

    await client.login('stale-cert');
    await expect(client.waitForPin()).resolves.toBe('123456');

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'session_expired', message: 'LINE session expired; log in again' },
    });
    expect(calls.some(call => call.url.includes('getRecentMessagesV2'))).toBe(false);
  });

  it('getMessagesBetween: failed login on HTTP 500 is session_expired', async () => {
    const { fetchFn, calls } = makeLoginFetch(httpErr(500));
    const client = new LineClient(null, fetchFn);

    await client.login('saved-cert');
    await expect(client.waitForCompletion()).rejects.toThrow('HTTP 500');

    const result = await client.getMessagesBetween('g1', 0, 5000);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'session_expired', message: 'LINE session expired; log in again' },
    });
    expect(calls.some(call => call.url.includes('getRecentMessagesV2'))).toBe(false);
  });

  it('keeps a newer QR bootstrap unauthenticated when a superseded login completes', async () => {
    let resolveFirstPoll: (() => void) | undefined;
    let resolveSecondSession: (() => void) | undefined;
    const calls: Array<{ url: string; body: unknown[]; headers: Record<string, string> }> = [];
    let sessionCount = 0;
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? '[]')) as unknown[];
      calls.push({ url, body, headers });
      if (url.includes('createSession')) {
        sessionCount += 1;
        if (sessionCount === 2) {
          return new Promise<Response>(resolve => {
            resolveSecondSession = () => resolve(apiOk({ authSessionId: 'session-2' }));
          });
        }
        return Promise.resolve(apiOk({ authSessionId: 'session-1' }));
      }
      if (url.includes('createQrCode')) {
        const authSessionId = (body[0] as { authSessionId: string }).authSessionId;
        return Promise.resolve(apiOk({
          callbackUrl: `https://line.me/R/nv/QRLogin?sid=${authSessionId}`,
          longPollingMaxCount: 1,
          longPollingIntervalSec: 1,
        }));
      }
      if (url.includes('checkQrCodeVerified')) {
        return new Promise<Response>(resolve => {
          resolveFirstPoll = () => resolve(apiOk({}));
        });
      }
      if (url.includes('verifyCertificate')) return Promise.resolve(apiOk({}));
      if (url.includes('qrCodeLoginV2')) {
        return Promise.resolve(apiOk({
          certificate: 'replacement-cert',
          tokenV3IssueResult: { accessToken: makeFakeJwt(), refreshToken: 'new-refresh' },
          mid: 'u123',
        }));
      }
      if (url.includes('getEncryptedIdentityV3')) return Promise.resolve(apiOk({
        wrappedNonce: 'new-nonce',
        kdfParameter1: 'new-kdf1',
        kdfParameter2: 'new-kdf2',
      }));
      return Promise.resolve(apiOk({}));
    });
    const client = new LineClient(null, fetchFn);
    vi.mocked(getHmac).mockClear();

    await client.login('certificate-a');
    const secondLogin = client.login('certificate-b');
    await vi.waitFor(() => expect(resolveSecondSession).toBeTypeOf('function'));
    resolveFirstPoll!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(client.getCompletedAuth()).toBeNull();
    resolveSecondSession!();
    await secondLogin;

    const secondBootstrap = calls.filter(call =>
      call.url.includes('createSession') || call.url.includes('createQrCode'),
    ).slice(-2);
    expect(secondBootstrap).toHaveLength(2);
    expect(secondBootstrap.every(call => call.headers['x-line-access'] === undefined)).toBe(true);
    const secondBootstrapHmacs = vi.mocked(getHmac).mock.calls
      .filter(([input]) => input.path.includes('createSession') || input.path.includes('createQrCode'))
      .slice(-2);
    expect(secondBootstrapHmacs.every(([input]) => input.accessToken === '')).toBe(true);
  });
});

describe('LineClient profile', () => {
  it('returns the authenticated account display name', async () => {
    const fetchFn = vi.fn().mockResolvedValue(apiOk({
      mid: baseAuth.mid,
      displayName: 'Personal LINE',
    }));
    const client = new LineClient(baseAuth, fetchFn);
    await expect(client.getProfileDisplayName()).resolves.toBe('Personal LINE');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual([2]);
  });

  it.each([
    [{ mid: baseAuth.mid, displayName: '' }, 'missing display name'],
    [{ mid: 'u-other', displayName: 'Wrong Account' }, 'profile MID mismatch'],
  ])('rejects an invalid authenticated profile', async (profile, message) => {
    const client = new LineClient(baseAuth, vi.fn().mockResolvedValue(apiOk(profile)));
    await expect(client.getProfileDisplayName()).rejects.toThrow(message);
  });
});

describe('LineClient gateway base URL', () => {
  it('keeps the production gateway by default', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    await new LineClient(baseAuth, fetchFn).listChats();
    expect(fetchFn.mock.calls.every(([url]) =>
      url.startsWith('https://line-chrome-gw.line-apps.com/api/'),
    )).toBe(true);
  });

  it('uses and normalizes a custom gateway for ordinary requests', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new LineClient(baseAuth, fetchFn, undefined, 'http://127.0.0.1:18181/');

    await client.listChats();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [url] of fetchFn.mock.calls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:18181\/api\//);
      expect(url).not.toContain('18181//api');
    }
  });

  it('forwards the public createLineClient option', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = createLineClient(baseAuth, {
      fetch: fetchFn,
      lineApiBaseUrl: 'http://127.0.0.1:18184',
    });

    await client.listChats();

    expect(fetchFn.mock.calls.every(([url]) =>
      url.startsWith('http://127.0.0.1:18184/api/'),
    )).toBe(true);
  });

  it('createLineClient exposes getMessagesBetween', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return apiOk([{ id: 'm1', from: 'u1', to: 'g1', toType: 2, createdTime: '2000', contentType: 0, text: 'hi', hasContent: false }]);
      }
      if (url.includes('getContactsV2')) return apiOk({ contacts: {} });
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = createLineClient(baseAuth, { fetch: fetchFn });

    const result = await client.getMessagesBetween('g1', 1000, 3000);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messages).toHaveLength(1);
  });

  it('uses the same custom gateway for token refresh', async () => {
    const soonAuth = { ...baseAuth, accessToken: makeFakeJwt(3600) };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/tokenRefresh')) {
        return new Response(JSON.stringify({ accessToken: makeFakeJwt(), refreshToken: 'rotated' }));
      }
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new LineClient(soonAuth, fetchFn, undefined, 'http://127.0.0.1:18182');

    await client.listChats();

    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:18182/api/auth/tokenRefresh');
  });

  it('does not rewrite an absolute image URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(Buffer.from([1]), {
      headers: { 'content-type': 'image/jpeg' },
    }));
    const client = new LineClient(baseAuth, fetchFn, undefined, 'http://127.0.0.1:18183');

    await client.getImageBuffer('http://127.0.0.1:19191/fixture.jpg');

    expect(fetchFn).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:19191/fixture.jpg');
  });
});

describe('classifyLineReadError', () => {
  const EXPIRED = 'LINE session expired; log in again';
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );

  it.each<[string, () => unknown, { refreshFailedTransiently?: boolean } | undefined, string, string]>([
    ['401', () => new LineHttpError(401, '/p'), undefined, 'session_expired', EXPIRED],
    [
      '401 transient refresh',
      () => new LineHttpError(401, '/p'),
      { refreshFailedTransiently: true },
      'unavailable',
      'LINE unavailable: token refresh failed',
    ],
    ['500', () => new LineHttpError(500, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 500'],
    ['503', () => new LineHttpError(503, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 503'],
    ['429', () => new LineHttpError(429, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 429'],
    ['400', () => new LineHttpError(400, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 400'],
    ['403', () => new LineHttpError(403, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 403'],
    ['404', () => new LineHttpError(404, '/p'), undefined, 'unavailable', 'LINE unavailable: HTTP 404'],
    [
      'non-integer status',
      () => new LineHttpError('eyJsecret' as unknown as number, '/p'),
      undefined,
      'unavailable',
      'LINE unavailable: HTTP error',
    ],
    ['api error', () => new LineApiError(10051, '/p'), undefined, 'unavailable', 'LINE unavailable: LINE error 10051'],
    [
      'api error non-integer',
      () => new LineApiError('eyJsecret' as unknown as number, '/p'),
      undefined,
      'unavailable',
      'LINE unavailable: LINE error',
    ],
    ['TypeError', () => new TypeError('fetch failed'), undefined, 'unavailable', 'LINE unavailable: network error'],
    ['not authenticated', () => new LineNotAuthenticatedError('Not authenticated'), undefined, 'session_expired', EXPIRED],
    ['login in progress', () => new LineNotAuthenticatedError('Login in progress'), undefined, 'session_expired', EXPIRED],
    [
      'NotAuth any cause',
      () => new LineNotAuthenticatedError('x', { cause: new LineHttpError(500, '/p') }),
      undefined,
      'session_expired',
      EXPIRED,
    ],
    [
      'NotAuth TypeError cause',
      () => new LineNotAuthenticatedError('x', { cause: new TypeError() }),
      undefined,
      'session_expired',
      EXPIRED,
    ],
    ['SyntaxError', () => new SyntaxError('x'), undefined, 'unavailable', 'LINE unavailable: unexpected error'],
    ['string', () => 'a string', undefined, 'unavailable', 'LINE unavailable: unexpected error'],
    ['undefined', () => undefined, undefined, 'unavailable', 'LINE unavailable: unexpected error'],
    ['null-proto', () => Object.create(null), undefined, 'unavailable', 'LINE unavailable: unexpected error'],
    ['throwing proxy', () => proxy, undefined, 'unavailable', 'LINE unavailable: unexpected error'],
  ])('%s', (_name, make, context, kind, message) => {
    const err = make();
    const result = classifyLineReadError(err, context);
    expect(result.kind).toBe(kind);
    expect(result.message).toBe(message);
    expect(result.cause).toBe(err);
  });

  it('never copies error text into message', () => {
    const result = classifyLineReadError(new Error('Bearer eyJsecret.token'));
    expect(result.message).not.toContain('eyJsecret');
  });

  it('cause is not serialized', () => {
    const result = classifyLineReadError(new LineApiError('eyJsecret' as unknown as number, '/p'));
    expect(JSON.stringify(result)).not.toContain('eyJsecret');
    expect(Object.keys(result)).not.toContain('cause');
  });
});
