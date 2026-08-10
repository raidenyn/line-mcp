import { describe, it, expect, vi } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { ImportService, type ImportServiceOptions } from './import-service';
import type { LinePrincipal } from './auth/line-auth-provider';
import type { RequestLineClient } from './request-client';
import type { MessageCache, Message } from '@raidenyn/line-client';

function principal(mid: string): LinePrincipal {
  return { provider: 'line', subject: mid, mid, scopes: ['line'] };
}

function fakeCache(): MessageCache & {
  imports: Array<{ ownerMid: string; chatMid: string; messages: Message[] }>;
} {
  const imports: Array<{ ownerMid: string; chatMid: string; messages: Message[] }> = [];
  return {
    imports,
    upsertMessages: vi.fn(),
    importMessages: vi.fn((ownerMid: string, chatMid: string, messages: Message[]) => {
      imports.push({ ownerMid, chatMid, messages });
      return { imported: messages.length };
    }),
    getMessages: vi.fn(() => []),
    latestTimestamp: vi.fn(() => null),
    getDistinctChatMids: vi.fn(() => []),
  };
}

function fakeClientFactory(chats: Array<{ mid: string; name: string }>) {
  return vi.fn(async (): Promise<RequestLineClient> => ({
    api: {
      listChats: async () => chats,
    } as unknown as RequestLineClient['api'],
    messages: {} as RequestLineClient['messages'],
  }));
}

function makeService(overrides: Partial<ImportServiceOptions> = {}) {
  let now = 1_000_000;
  const cache = overrides.cache as ReturnType<typeof fakeCache> | undefined ?? fakeCache();
  const createRequestClient = overrides.createRequestClient ?? fakeClientFactory([{ mid: 'resolved-chat', name: 'Test Chat' }]);
  let idCounter = 0;
  const service = new ImportService({
    basePath: '',
    cache,
    createRequestClient,
    now: () => now,
    randomId: () => `id-${++idCounter}`,
    parseExportHeader: (content: string) => {
      const match = content.match(/^Chat history with (.+)$/m);
      if (!match) throw new Error('not an export');
      return match[1].trim();
    },
    parseExportFile: (content: string, chatMid: string) => {
      const count = (content.match(/^MSG /gm) ?? []).length;
      return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`,
        from: 'sender',
        to: chatMid,
        toType: 1,
        createdTime: String(1_000_000 + i),
        contentType: 0,
        text: `message ${i}`,
        hasContent: false,
      })) as Message[];
    },
    ...overrides,
  });
  return { service, cache, advance: (ms: number) => { now += ms; } };
}

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeFakeExpressRequest(): Parameters<ImportService['initiate']>[1] {
  return {
    protocol: 'http',
    get: (name: string) => (name === 'host' ? '127.0.0.1:9999' : undefined),
  } as Parameters<ImportService['initiate']>[1];
}

const SAMPLE_EXPORT = 'Chat history with Test Chat\nMSG 1\nMSG 2\nMSG 3\n';

describe('ImportService — canonical upload URLs', () => {
  it('builds an upload URL from the request protocol/host when no publicUrl override is set', () => {
    const { service } = makeService({ basePath: '/line-mcp' });
    const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
    expect(upload_url).toBe('http://127.0.0.1:9999/line-mcp/import-upload?token=id-1');
  });

  it('prefers an explicit publicUrl override, stripping a trailing slash', () => {
    const { service } = makeService({ basePath: '/line-mcp', publicUrl: 'https://public.example.com/' });
    const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
    expect(upload_url).toBe('https://public.example.com/line-mcp/import-upload?token=id-1');
  });
});

describe('ImportService — independently mounted upload route', () => {
  it('serves /import-upload when mountRoutes is called on a bare express app (no OAuth router involved)', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const res = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: SAMPLE_EXPORT,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.chat_name).toBe('Test Chat');
      expect(typeof body.file_ref_id).toBe('string');
    } finally {
      await close();
    }
  });
});

describe('ImportService — one-time / expiring capability tokens', () => {
  it('rejects a token that has never been issued', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/import-upload?token=nonexistent`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: SAMPLE_EXPORT,
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('consumes the upload token on first use — a second upload with the same token is rejected', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const first = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      expect(second.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('rejects an upload token after it has expired', async () => {
    const { service, advance } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      advance(16 * 60 * 1000); // past the 15-minute upload TTL
      const res = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('rejects complete() on a file_ref_id after the file TTL has expired', async () => {
    const { service, advance } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      advance(2 * 60 * 60 * 1000); // past the 1-hour file TTL
      const outcome = await service.complete(principal('u1'), { file_ref_id, timezone: 'UTC' });
      expect(outcome.kind).toBe('not_found_or_expired');
    } finally {
      await close();
    }
  });
});

describe('ImportService — cross-principal rejection', () => {
  it('rejects complete_import when principal B presents a file_ref_id from principal A\'s upload', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('user-a'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcomeForB = await service.complete(principal('user-b'), { file_ref_id, timezone: 'UTC', chat_mid: 'some-chat' });
      expect(outcomeForB.kind).toBe('wrong_owner');

      const outcomeForA = await service.complete(principal('user-a'), { file_ref_id, timezone: 'UTC', chat_mid: 'some-chat' });
      expect(outcomeForA.kind).toBe('success');
    } finally {
      await close();
    }
  });
});

describe('ImportService — owner-scoped completion writes', () => {
  it('writes imported messages into the cache under the completing principal\'s mid, never a value from the file', async () => {
    const { service, cache } = makeService();
    const outcome = await (async () => {
      const app = express();
      service.mountRoutes(app);
      const { url, close } = await listen(app);
      try {
        const { upload_url } = service.initiate(principal('owner-mid'), makeFakeExpressRequest());
        const token = new URL(upload_url).searchParams.get('token')!;
        const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
        });
        const { file_ref_id } = await uploadRes.json();
        return service.complete(principal('owner-mid'), { file_ref_id, timezone: 'UTC', chat_mid: 'target-chat' });
      } finally {
        await close();
      }
    })();

    expect(outcome.kind).toBe('success');
    expect(cache.imports).toHaveLength(1);
    expect(cache.imports[0].ownerMid).toBe('owner-mid');
    expect(cache.imports[0].chatMid).toBe('target-chat');
  });

  it('reports parsed rows separately from newly imported rows', async () => {
    const cache = fakeCache();
    vi.mocked(cache.importMessages).mockReturnValue({ imported: 1 });
    const { service } = makeService({ cache });
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('owner-mid'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcome = await service.complete(principal('owner-mid'), {
        file_ref_id,
        timezone: 'UTC',
        chat_mid: 'target-chat',
      });

      expect(outcome).toMatchObject({ kind: 'success', parsed: 3, imported: 1 });
    } finally {
      await close();
    }
  });

  it('rejects zero parsed messages without writing or consuming the pending file', async () => {
    const parseExportFile = vi.fn((_content: string, chatMid: string): Message[] => [{
      id: 'retry-message',
      from: 'sender',
      to: chatMid,
      toType: 1,
      createdTime: '1000000',
      contentType: 0,
      text: 'message after retry',
      hasContent: false,
    }]);
    parseExportFile.mockReturnValueOnce([]);
    const { service, cache } = makeService({ parseExportFile });
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);

    try {
      const { upload_url } = service.initiate(principal('owner-mid'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();
      const args = { file_ref_id, timezone: 'UTC', chat_mid: 'target-chat' };

      const first = await service.complete(principal('owner-mid'), args);

      expect(first).toEqual({
        kind: 'import_failed',
        error: 'No messages were found in the LINE chat export.',
      });
      expect(cache.importMessages).not.toHaveBeenCalled();

      const second = await service.complete(principal('owner-mid'), args);

      expect(second.kind).toBe('success');
      expect(cache.importMessages).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});

describe('ImportService — requesting-principal chat detection', () => {
  it('lists chats using the completing principal, not any principal baked into the uploaded file', async () => {
    const chats = [{ mid: 'resolved-chat', name: 'Test Chat' }];
    const createRequestClient = fakeClientFactory(chats);
    const { service } = makeService({ createRequestClient });
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('requester'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcome = await service.complete(principal('requester'), { file_ref_id, timezone: 'UTC' }); // no chat_mid: auto-detect
      expect(outcome.kind).toBe('success');
      expect(createRequestClient).toHaveBeenCalledWith(expect.objectContaining({ mid: 'requester' }));
    } finally {
      await close();
    }
  });

  it('reports needs_info with candidates when multiple chats share the export\'s chat name', async () => {
    const chats = [{ mid: 'chat-1', name: 'Test Chat' }, { mid: 'chat-2', name: 'Test Chat' }];
    const { service } = makeService({ createRequestClient: fakeClientFactory(chats) });
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcome = await service.complete(principal('u1'), { file_ref_id, timezone: 'UTC' });
      expect(outcome.kind).toBe('multiple_chat_matches');
      if (outcome.kind === 'multiple_chat_matches') {
        expect(outcome.candidates).toEqual([{ chat_mid: 'chat-1', name: 'Test Chat' }, { chat_mid: 'chat-2', name: 'Test Chat' }]);
      }
    } finally {
      await close();
    }
  });
});

describe('ImportService — complete() outcomes independent of HTTP', () => {
  it('returns not_found_or_expired for an unknown file_ref_id', async () => {
    const { service } = makeService();
    const outcome = await service.complete(principal('u1'), { file_ref_id: 'nonexistent' });
    expect(outcome.kind).toBe('not_found_or_expired');
  });

  it('returns needs_timezone when timezone is omitted for a real pending file', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcome = await service.complete(principal('u1'), { file_ref_id });
      expect(outcome.kind).toBe('needs_timezone');
    } finally {
      await close();
    }
  });

  it('returns invalid_timezone for a malformed IANA name', async () => {
    const { service } = makeService();
    const app = express();
    service.mountRoutes(app);
    const { url, close } = await listen(app);
    try {
      const { upload_url } = service.initiate(principal('u1'), makeFakeExpressRequest());
      const token = new URL(upload_url).searchParams.get('token')!;
      const uploadRes = await fetch(`${url}/import-upload?token=${token}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: SAMPLE_EXPORT,
      });
      const { file_ref_id } = await uploadRes.json();

      const outcome = await service.complete(principal('u1'), { file_ref_id, timezone: 'Not/AZone' });
      expect(outcome.kind).toBe('invalid_timezone');
    } finally {
      await close();
    }
  });
});

// ─── Regression guard: OAuth registration never mounts /import-upload or ──────
// imports the export parser. Static source scan — cheap, and fails loudly if
// either boundary is ever crossed by a future edit.
describe('OAuth router boundary (regression guard)', () => {
  const oauthRouterSource = fs.readFileSync(
    path.join(__dirname, 'auth', 'oauth-router.ts'),
    'utf8',
  );

  it('does not reference /import-upload', () => {
    expect(oauthRouterSource).not.toContain('import-upload');
  });

  it('does not import the export parser (parseExportFile/parseExportHeader)', () => {
    expect(oauthRouterSource).not.toContain('parseExportFile');
    expect(oauthRouterSource).not.toContain('parseExportHeader');
  });

  it('mounting OAuth routes on a bare app leaves /import-upload unhandled (404)', async () => {
    const { mountOAuthRoutes } = await import('./auth/oauth-router');
    const { FileCredentialStore } = await import('./auth/credential-store');
    const os = await import('os');
    const fsPromises = await import('fs');
    const dir = fsPromises.mkdtempSync(path.join(os.tmpdir(), 'import-boundary-'));
    const app = express();
    mountOAuthRoutes(app, {
      base: 'http://localhost:3000',
      origin: 'http://localhost:3000',
      basePath: '',
      requiredScopes: ['line'],
      authStoreDir: dir,
      credentialStore: new FileCredentialStore(dir),
      issueTokens: () => ({ access_token: 'a', refresh_token: 'r' }),
      issueFromRefresh: async () => null,
      recordRefreshedAuth: () => {},
    });
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/import-upload?token=whatever`, { method: 'POST', body: 'x' });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});
