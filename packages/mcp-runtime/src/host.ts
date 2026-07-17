import express, { type Express, type Request as ExpressRequest } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * A generic, product-agnostic MCP-over-HTTP hosting layer.
 *
 * The one architectural guarantee this module exists to provide: every single
 * `POST /mcp` gets its OWN freshly constructed `McpServer` and transport, with
 * the resolved principal handed to registrations through an explicit
 * `RequestContext` — never through ambient `AsyncLocalStorage`. Authentication
 * runs strictly BEFORE any protocol object is constructed, so a rejected
 * request never allocates a server or a transport.
 */

/** The authenticated identity behind a single request. */
export interface Principal {
  readonly subject: string;
  readonly scopes: readonly string[];
}

/**
 * Everything the runtime needs to authenticate a request and mount whatever
 * auxiliary routes (OAuth discovery, `/authorize`, `/token`, …) the concrete
 * auth scheme requires. The runtime itself owns ONLY the `POST /mcp` route;
 * `mountRoutes` is where an implementation adds its own, separate routes.
 */
export interface AuthProvider<P extends Principal> {
  /** Mount the provider's own routes (discovery, authorize, token, …). */
  mountRoutes(app: Express): void;
  /** Resolve the principal for a request, or `null` to reject it. */
  authenticate(request: ExpressRequest): Promise<P | null>;
  /** The `WWW-Authenticate` header value to return on a 401. */
  challenge(request: ExpressRequest): string;
}

/** The explicit per-request context handed to every registration. */
export interface RequestContext<P extends Principal> {
  readonly principal: P;
  readonly request: ExpressRequest;
}

/**
 * A unit of MCP surface (tools, resources, prompts) registered against a
 * request-scoped server, with access to that request's principal.
 */
export type Registration<P extends Principal> = (
  server: McpServer,
  context: RequestContext<P>,
) => void;

/**
 * The minimal server surface the host drives. `McpServer` satisfies it; tests
 * may substitute a fake via `serverFactory`.
 */
export interface HostServer {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * The minimal transport surface the host drives. `StreamableHTTPServerTransport`
 * satisfies it; tests may substitute a fake via `transportFactory`.
 */
export interface HostTransport {
  onclose?: (() => void) | undefined;
  close(): Promise<void>;
  handleRequest(req: ExpressRequest, res: express.Response, body?: unknown): Promise<void>;
}

export interface McpHostOptions<P extends Principal> {
  readonly name: string;
  readonly version: string;
  readonly basePath: string;
  readonly authProvider: AuthProvider<P>;
  readonly registrations: readonly Registration<P>[];
  /**
   * Test seam — defaults to the real `McpServer` constructor. NOT for injecting
   * auth secrets/credentials; those belong entirely to the `AuthProvider`.
   */
  readonly serverFactory?: (info: { name: string; version: string }) => McpServer;
  /** Test seam — defaults to the real streamable-HTTP transport constructor. */
  readonly transportFactory?: () => HostTransport;
}

export interface McpHost {
  /** The Express app with auth routes + the `POST /mcp` route mounted. */
  readonly app: Express;
}

function defaultServerFactory(info: { name: string; version: string }): McpServer {
  return new McpServer(info);
}

function defaultTransportFactory(): HostTransport {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) as unknown as HostTransport;
}

export function createMcpHost<P extends Principal>(options: McpHostOptions<P>): McpHost {
  const {
    name,
    version,
    basePath,
    authProvider,
    registrations,
    serverFactory = defaultServerFactory,
    transportFactory = defaultTransportFactory,
  } = options;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // The auth provider owns its own routes (discovery/authorize/token/…),
  // separate from the /mcp route the runtime owns below.
  authProvider.mountRoutes(app);

  app.post(`${basePath}/mcp`, async (req, res) => {
    // 1. Authenticate FIRST — no protocol object exists yet.
    let principal: P | null;
    try {
      principal = await authProvider.authenticate(req);
    } catch {
      principal = null;
    }
    if (!principal) {
      res
        .status(401)
        .set('WWW-Authenticate', authProvider.challenge(req))
        .json({ error: 'invalid_token' });
      return;
    }

    // 2. Only on success: a fresh server + transport for THIS request.
    const server = serverFactory({ name, version });
    const transport = transportFactory();
    const context: RequestContext<P> = { principal, request: req };
    for (const register of registrations) {
      register(server, context);
    }

    // 3. One idempotent cleanup closure. Whichever of completion, disconnect,
    //    or exception fires first wins; later triggers are no-ops.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void Promise.resolve(transport.close()).catch(() => {});
      void Promise.resolve(server.close()).catch(() => {});
    };
    transport.onclose = cleanup; // transport disconnect
    res.on('close', cleanup); // request completion or client disconnect

    try {
      // The default transport is a full SDK `Transport`; the `HostTransport`
      // view only narrows the surface the host itself drives.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      cleanup(); // exception
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
      process.stderr.write(`[mcp-runtime] request handling failed: ${(err as Error).message}\n`);
    }
  });

  app.get(`${basePath}/mcp`, (_req, res) => {
    res.status(405).send('Use POST /mcp');
  });

  return { app };
}
