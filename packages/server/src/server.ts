import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type express from 'express';
import { createMcpHost, normalizeBasePath, type McpHost } from '@raidenyn/mcp-runtime';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';
import {
  LineAuthProvider,
  publicEndpointConfig,
  FileCredentialStore,
  ImportService,
  startSyncLoop,
  type LinePrincipal,
  type LineToolDeps,
} from '@raidenyn/line-mcp';
import type { AuthData } from '@raidenyn/line-client';
import { CategoryStore, TemplateStore, PresetStore, type BankToolDeps } from '@raidenyn/bank-mcp';
import { resolveDataLayout } from './data-layout';
import { bootstrapPersistence, type ActivePersistence } from './persistence-migration';
import { createServerRequestClientFactory } from './request-client';
import { buildRegistrations } from './registrations';

const SERVER_VERSION = '1.0.0';

// The executable owns secret loading: importing @raidenyn/line-mcp never reads
// or creates data/secret. The signing key is loaded here and injected into
// LineAuthProvider.
function loadOrCreateSecret(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, 'utf8');
    return secret;
  }
}

export interface ServerOptions {
  /** Explicit data root — the executable (cli.ts) resolves DATA_DIR/process.cwd(); this factory never does. */
  dataRoot: string;
  port?: number;
  basePath?: string;
  /** Overrides the auto-derived public base URL used in import upload links. */
  publicUrl?: string;
  lineApiBaseUrl?: string;
  /**
   * e2e-test-only bearer bypass. Never set in production; cli.ts is the only
   * caller that reads the TEST_TOKEN / LINE_AUTH_DATA environment variables
   * that populate this, keeping this factory itself free of that env read.
   */
  testAuth?: ReadonlyArray<{ token: string; authData: AuthData }>;
}

export interface StartResult {
  /** The bound port (useful when `port: 0` was requested). */
  port: number;
  /** The committed persistence generation this boot is running against. */
  active: ActivePersistence;
}

export interface ComposedServer {
  start(): Promise<StartResult>;
  stop(): Promise<void>;
}

/**
 * Builds the fully composed LINE + bank transaction MCP server: one
 * `LineAuthProvider`, one owner-scoped message cache, one shared (trusted-
 * tenant) category/template store pair, one import service, one request-client
 * factory, one sync loop — all wired through `createMcpHost` from
 * `@raidenyn/mcp-runtime`, which hands every registration a genuinely fresh
 * `McpServer` + `RequestContext` per request. Constructing this object has NO
 * side effects; nothing is created, opened, migrated, or listened on until
 * `.start()` is called.
 */
export function createServer(options: ServerOptions): ComposedServer {
  const dataRoot = options.dataRoot;
  const basePath = normalizeBasePath(options.basePath ?? process.env.BASE_PATH);
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10);

  let cache: SqliteMessageCache | undefined;
  // CategoryStore owns its own better-sqlite3 connection (separate from the
  // line cache); retained here so stop() can close it before resolving, the
  // same way cache.close() releases the messages DB.
  let categoryStore: CategoryStore | undefined;
  // SyncLoopHandle.stop() awaits the in-flight run before resolving, so the
  // line cache is never closed underneath a still-running sync.
  let syncHandle: ReturnType<typeof startSyncLoop> | undefined;
  let httpServer: ReturnType<express.Express['listen']> | undefined;

  return {
    async start(): Promise<StartResult> {
      // The composed server performs legacy migration before opening either
      // store — bootstrapPersistence() must run BEFORE SqliteMessageCache or
      // CategoryStore ever touch a database file.
      const active = bootstrapPersistence({ dataRoot });
      const layout = resolveDataLayout(dataRoot);

      // Two separate DB files (Task 2) — line messages and bank/category data
      // no longer share a single SQLite file the way the pre-migration schema
      // did. The bank category + template stores (Task 10) are shared across
      // every principal on this data root — the explicit trusted-tenant model,
      // unlike the owner-scoped line-message cache.
      cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
      const categories = new CategoryStore(active.bankDbPath);
      categoryStore = categories;
      const templates = new TemplateStore(layout.templatesDir);
      // Built-in bank presets ship inside @raidenyn/bank-mcp and resolve
      // relative to that package, not the data root — constructing this
      // performs no filesystem I/O (assets are read lazily on first use).
      const presets = new PresetStore();

      const secret = loadOrCreateSecret(layout.secretPath);
      const credentialStore = new FileCredentialStore(layout.authDir);
      // Endpoint config derives issuer/audience from the *requested* port. With
      // `port: 0` (ephemeral, tests-only), the OAuth discovery docs and token
      // claims embed `:0` while the server actually listens elsewhere — token
      // verification stays self-consistent (same codec config both sides), but
      // any client dereferencing the advertised metadata URL will fail. Tests
      // using `port: 0` do not rely on externally dereferencable metadata.
      const authProvider = new LineAuthProvider({
        secret,
        endpoints: publicEndpointConfig(port, basePath),
        credentialStore,
        authStoreDir: layout.authDir,
        lineApiBaseUrl: options.lineApiBaseUrl,
      });
      for (const { token, authData } of options.testAuth ?? []) {
        authProvider.seedTestToken(token, authData);
      }

      // The SAME request-client factory backs the messenger tools, the bank
      // tools' message reader, and the sync loop below — one seam, one
      // credential-resolution/cache-wrapping behavior.
      const createRequestClient = createServerRequestClientFactory({
        cache,
        resolveCredentials: (principal) => authProvider.resolveCredentials(principal),
        authStoreDir: layout.authDir,
        lineApiBaseUrl: options.lineApiBaseUrl,
      });

      const importService = new ImportService({
        basePath,
        cache,
        createRequestClient,
        publicUrl: options.publicUrl ?? process.env.PUBLIC_URL,
      });

      const lineToolDeps: LineToolDeps = { createRequestClient, importService };
      const bankToolDeps: BankToolDeps<LinePrincipal> = {
        createMessageReader: async (principal) => (await createRequestClient(principal)).messages,
        templates,
        categories,
        presets,
      };

      const host: McpHost = createMcpHost<LinePrincipal>({
        name: 'line-mcp',
        version: SERVER_VERSION,
        basePath,
        authProvider,
        registrations: buildRegistrations({ line: lineToolDeps, bank: bankToolDeps, guideDir: layout.guideDir }),
      });

      // Import-upload route: mounted independently of OAuth's routes, per the
      // import service's own contract (issue #75, Task 9).
      importService.mountRoutes(host.app);

      host.app.get(`${basePath}/healthz`, (_req, res) => {
        res.status(200).json({ status: 'ok', version: SERVER_VERSION });
      });

      host.app.get(`${basePath}/`, (_req, res) => {
        // index.html ships inside @raidenyn/line-mcp's own assets/ (issue #75,
        // Task 9). require.resolve() follows the package's "main" (dist/index.js)
        // in both ts-node and compiled dist modes, so this resolves correctly
        // either way.
        const packageEntry = require.resolve('@raidenyn/line-mcp');
        res.sendFile(path.join(packageEntry, '..', '..', 'assets', 'index.html'));
      });

      // Scoped to this generation's credentialStore/cache — never the
      // process-wide default when a caller (e.g. a test) has passed an
      // explicit dataRoot override.
      syncHandle = startSyncLoop({ credentialStore, cache, createRequestClient }, 24 * 60 * 60 * 1000);

      httpServer = await new Promise<ReturnType<express.Express['listen']>>((resolvePromise) => {
        const s = host.app.listen(port, '0.0.0.0', () => {
          process.stderr.write(`LINE MCP server listening on http://localhost:${port}${basePath}/mcp\n`);
          process.stderr.write(`Add to Claude Code: claude mcp add --transport http --scope user line http://localhost:${port}${basePath}/mcp\n`);
          resolvePromise(s);
        });
      });
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;

      return { port: actualPort, active };
    },

    async stop(): Promise<void> {
      // Stop the sync loop FIRST and await its in-flight run, so the cache
      // and category store are never closed while a sync is still using them.
      await syncHandle?.stop();
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
      // Close both DB-backed stores the composed server owns: the line-message
      // cache and the bank/category store. CategoryStore opens its own
      // better-sqlite3 connection (separate from the cache's), so without an
      // explicit close() the bank DB handle would outlive stop() and leak
      // across repeated start/stop cycles (e.g. tests).
      categoryStore?.close();
      cache?.close();
    },
  };
}
