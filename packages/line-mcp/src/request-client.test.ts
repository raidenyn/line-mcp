import { describe, it, expect, vi } from 'vitest';

vi.mock('@raidenyn/line-client', async importOriginal => {
  const original = await importOriginal<typeof import('@raidenyn/line-client')>();
  return {
    ...original,
    createLineClient: vi.fn(() => ({
      getMessages: vi.fn(),
      getMessagesInRange: vi.fn(),
    })),
    withMessageCache: vi.fn((_api, _cache, ownerMid) => ({ ownerMid })),
  };
});

import { createLineClient } from '@raidenyn/line-client';
import { createRequestClientFactory } from './request-client';

describe('createRequestClientFactory gateway forwarding', () => {
  it('passes lineApiBaseUrl to each LINE client', async () => {
    const authData = {
      accessToken: 'access', refreshToken: 'refresh', certificate: 'certificate', mid: 'u-smoke',
      wrappedNonce: 'nonce', kdfParameter1: 'kdf1', kdfParameter2: 'kdf2',
    };
    const factory = createRequestClientFactory({
      cache: {
        getMessages: vi.fn().mockReturnValue([]),
        upsertMessages: vi.fn(),
        latestTimestamp: vi.fn().mockReturnValue(null),
        getDistinctChatMids: vi.fn().mockReturnValue([]),
      },
      resolveCredentials: vi.fn().mockResolvedValue(authData),
      lineApiBaseUrl: 'http://127.0.0.1:18200',
    });

    await factory({ provider: 'line', subject: authData.mid, mid: authData.mid, scopes: ['line'] });

    expect(createLineClient).toHaveBeenCalledWith(authData, {
      onAuthRefreshed: undefined,
      lineApiBaseUrl: 'http://127.0.0.1:18200',
    });
  });
});
