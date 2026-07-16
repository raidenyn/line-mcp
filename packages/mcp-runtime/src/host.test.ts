import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import {
  createMcpHost,
  type AuthProvider,
  type Principal,
  type RequestContext,
  type Registration,
  type HostServer,
  type HostTransport,
} from './host';

// A simple test principal.
interface TestPrincipal extends Principal {
  readonly subject: string;
  readonly scopes: readonly string[];
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

let serverSeq = 0;
function makeFakeServer(): HostServer & { id: number; closeCount: number } {
  serverSeq += 1;
  const server = {
    id: serverSeq,
    closeCount: 0,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {
      server.closeCount += 1;
    }),
  };
  return server;
}

let transportSeq = 0;
type FakeTransport = HostTransport & {
  id: number;
  closeCount: number;
  handleRequest: ReturnType<typeof vi.fn>;
};
function makeFakeTransport(
  onHandle?: (t: FakeTransport, res: ExpressResponse) => void,
): FakeTransport {
  transportSeq += 1;
  const transport: FakeTransport = {
    id: transportSeq,
    closeCount: 0,
    onclose: undefined,
    close: vi.fn(async () => {
      transport.closeCount += 1;
    }),
    handleRequest: vi.fn(async (_req: unknown, res: ExpressResponse) => {
      if (onHandle) onHandle(transport, res);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, transport: transport.id }));
    }),
  };
  return transport;
}

// A barrier that only releases once `n` participants have arrived, forcing
// genuine overlap between concurrent requests.
function makeBarrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

async function startHost(host: { app: import('express').Express }) {
  const server = host.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createMcpHost — per-request lifecycle', () => {
  it('creates a distinct server, transport, and principal context per concurrent POST', async () => {
    const barrier = makeBarrier(2);
    const authenticate = vi.fn(async (req: ExpressRequest): Promise<TestPrincipal | null> => {
      const subject = req.header('x-principal') ?? '';
      await barrier(); // overlap: both requests block here until both arrive
      return { subject, scopes: ['line'] };
    });

    const createdServers: Array<ReturnType<typeof makeFakeServer>> = [];
    const createdTransports: FakeTransport[] = [];
    const observed = new Map<string, { server: HostServer; request: ExpressRequest }>();

    const authProvider: AuthProvider<TestPrincipal> = {
      mountRoutes: () => {},
      authenticate,
      challenge: () => 'Bearer error="invalid_token"',
    };

    const registration: Registration<TestPrincipal> = (server, ctx: RequestContext<TestPrincipal>) => {
      observed.set(ctx.principal.subject, { server: server as unknown as HostServer, request: ctx.request });
    };

    const host = createMcpHost<TestPrincipal>({
      name: 'test',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: [registration],
      serverFactory: () => {
        const s = makeFakeServer();
        createdServers.push(s);
        return s as unknown as HostServer;
      },
      transportFactory: () => {
        const t = makeFakeTransport();
        createdTransports.push(t);
        return t;
      },
    });

    const { url, close } = await startHost(host);
    try {
      const [a, b] = await Promise.all([
        fetch(url, { method: 'POST', headers: { 'x-principal': 'alice', 'content-type': 'application/json' }, body: '{}' }),
        fetch(url, { method: 'POST', headers: { 'x-principal': 'bob', 'content-type': 'application/json' }, body: '{}' }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    } finally {
      // handled below, but ensure server shuts even on failure
      void close;
    }

    // Two independent authentications, servers, transports, principals.
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(createdServers).toHaveLength(2);
    expect(createdTransports).toHaveLength(2);
    expect(createdServers[0]).not.toBe(createdServers[1]);
    expect(createdTransports[0]).not.toBe(createdTransports[1]);
    expect([...observed.keys()].sort()).toEqual(['alice', 'bob']);
    expect(observed.get('alice')!.server).not.toBe(observed.get('bob')!.server);
    expect(observed.get('alice')!.request).not.toBe(observed.get('bob')!.request);

    // Cleanup fires exactly once per request (completion trigger).
    await vi.waitFor(() => {
      for (const t of createdTransports) expect(t.closeCount).toBe(1);
      for (const s of createdServers) expect(s.closeCount).toBe(1);
    });

    await close();
  });

  it('runs the cleanup closure exactly once even when two triggers fire', async () => {
    const authProvider: AuthProvider<TestPrincipal> = {
      mountRoutes: () => {},
      authenticate: async () => ({ subject: 'x', scopes: ['line'] }),
      challenge: () => 'Bearer',
    };

    let theServer: ReturnType<typeof makeFakeServer> | undefined;
    let theTransport: FakeTransport | undefined;

    const host = createMcpHost<TestPrincipal>({
      name: 'test',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: [],
      serverFactory: () => {
        theServer = makeFakeServer();
        return theServer as unknown as HostServer;
      },
      // handleRequest triggers the disconnect path (onclose) AND then completes
      // the response — two of the three cleanup triggers for the same request.
      transportFactory: () => {
        theTransport = makeFakeTransport((t, res) => {
          if (t.onclose) t.onclose();
          void res;
        });
        return theTransport;
      },
    });

    const { url, close } = await startHost(host);
    const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(resp.status).toBe(200);

    await vi.waitFor(() => {
      expect(theTransport!.closeCount).toBe(1);
      expect(theServer!.closeCount).toBe(1);
    });
    // Give any late trigger a chance to (wrongly) double-fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(theTransport!.closeCount).toBe(1);
    expect(theServer!.closeCount).toBe(1);

    await close();
  });

  it('does not construct a server or transport when authentication fails', async () => {
    const serverFactory = vi.fn(() => makeFakeServer() as unknown as HostServer);
    const transportFactory = vi.fn(() => makeFakeTransport());
    const registration = vi.fn();

    const authProvider: AuthProvider<TestPrincipal> = {
      mountRoutes: () => {},
      authenticate: async () => null, // reject
      challenge: () => 'Bearer error="invalid_token", realm="line"',
    };

    const host = createMcpHost<TestPrincipal>({
      name: 'test',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: [registration],
      serverFactory,
      transportFactory,
    });

    const { url, close } = await startHost(host);
    const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    expect(resp.status).toBe(401);
    expect(resp.headers.get('www-authenticate')).toBe('Bearer error="invalid_token", realm="line"');
    expect(serverFactory).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
    expect(registration).not.toHaveBeenCalled();

    await close();
  });

  it('lets the AuthProvider mount its own routes alongside the /mcp route', async () => {
    const authProvider: AuthProvider<TestPrincipal> = {
      mountRoutes: (app) => {
        app.get('/whoami', (_req, res) => {
          res.json({ ok: true });
        });
      },
      authenticate: async () => ({ subject: 'x', scopes: [] }),
      challenge: () => 'Bearer',
    };

    const host = createMcpHost<TestPrincipal>({
      name: 'test',
      version: '0.0.0',
      basePath: '',
      authProvider,
      registrations: [],
      serverFactory: () => makeFakeServer() as unknown as HostServer,
      transportFactory: () => makeFakeTransport(),
    });

    const server = host.app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}/whoami`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
