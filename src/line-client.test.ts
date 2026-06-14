import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ltsm so no WASM is loaded
vi.mock('./ltsm', () => ({
  getHmac: vi.fn().mockResolvedValue('fake-hmac'),
  initStorageKey: vi.fn().mockResolvedValue(undefined),
  ensureStorageKey: vi.fn().mockResolvedValue(undefined),
}));

import { LineClient, AuthData } from './line-client';

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

function apiOk(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function apiErr(code: number, message: string): Response {
  return new Response(JSON.stringify({ code, message, data: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function httpErr(status: number): Response {
  return new Response('error body', { status });
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
    const client = new LineClient(auth, mockFetch);
    await client.listChats();

    const refreshCall = mockFetch.mock.calls.find(([url]: string[]) => url.includes('tokenRefresh'));
    expect(refreshCall).toBeTruthy();
    expect(auth.accessToken).toBe(newToken);
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
