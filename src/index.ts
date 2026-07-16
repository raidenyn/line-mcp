import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import express from 'express';
import type { Request as ExpressRequest } from 'express';
import { join } from 'path';
import { AuthData } from '@raidenyn/line-client';
import {
  recordRefreshedAuth,
  LineAuthProvider,
  FileCredentialStore,
  publicEndpointConfig,
  registerLineTools,
  registerLineResources,
  ImportService,
  createRequestClientFactory,
  startSyncLoop,
  type LinePrincipal,
  type LineToolDeps,
  type RequestLineClient,
} from '@raidenyn/line-mcp';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';
import {
  CategoryStore,
  TemplateStore,
  PresetStore,
  registerBankTools,
  registerBankResources,
  type BankToolDeps,
} from '@raidenyn/bank-mcp';
import { dataDir, authDir, secretPath, templatesDir } from './data-dir';
import { bootstrapPersistence, type ActivePersistence } from './persistence-migration';
import { normalizeBasePath, type RequestContext } from '@raidenyn/mcp-runtime';
import fs from 'fs';

const SERVER_VERSION = '1.0.0';
const server = new McpServer({ name: 'line-mcp', version: SERVER_VERSION });
const requestStore = new AsyncLocalStorage<ExpressRequest>();
// Threads the resolved LINE principal through to the messenger AND bank tools'
// request-bound contexts — see lineToolContext / bankToolContext below.
const principalStore = new AsyncLocalStorage<LinePrincipal>();
let sharedCache: SqliteMessageCache;

// The messenger + bank tools/import-service/sync are constructed fresh inside
// every main() call (issue #75, Tasks 9–10) — these module-level `let`s are
// reassigned there, exactly like `sharedCache` above. registerLineTools() /
// registerBankTools() themselves run exactly ONCE at module load (below), and
// their closures read these mutable bindings — and the tool contexts' live
// getters — fresh on every actual tool invocation, so they always see the
// CURRENT main() call's wiring even across repeated main() calls in the same
// process (tests).
let currentCreateRequestClient: ((principal: LinePrincipal) => Promise<RequestLineClient>) | undefined;
let currentImportService: ImportService | undefined;
let currentCategoryStore: CategoryStore | undefined;
let currentTemplateStore: TemplateStore | undefined;

// Built-in bank presets ship inside @raidenyn/bank-mcp and resolve relative to
// that package, not the data root — so this store carries no per-generation
// state and is safe to construct once at module load. Constructing it performs
// no filesystem I/O (assets are read lazily on first use).
const presetStore = new PresetStore();

// The executable owns secret loading: importing @raidenyn/line-mcp never reads
// or creates data/secret. The signing key is loaded here and injected into
// LineAuthProvider.
function loadOrCreateSecret(dataRoot: string): string {
  const file = secretPath(dataRoot);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, secret, 'utf8');
    return secret;
  }
}

// The one live RequestContext<LinePrincipal> registerLineTools() is ever
// called with. Its fields are getters that read the CURRENT AsyncLocalStorage
// stores at the moment each messenger tool handler actually executes — never
// captured by value here at registration time. This is what lets ONE
// registerLineTools() call (at module load, matching every other tool
// registration in this file) work correctly against root's
// reuse-forever-server model today, unchanged when a later task switches the
// composed server to createMcpHost's fresh-context-per-request model.
const lineToolContext: RequestContext<LinePrincipal> = {
  get principal(): LinePrincipal {
    const principal = principalStore.getStore();
    if (!principal) throw new Error('No LINE principal in scope for this request');
    return principal;
  },
  get request(): ExpressRequest {
    const req = requestStore.getStore();
    if (!req) throw new Error('No request in scope for this call');
    return req;
  },
};

const lineToolDeps: LineToolDeps = {
  createRequestClient: (principal) => {
    if (!currentCreateRequestClient) {
      throw new Error('LINE request-client factory not initialized — main() must run before tools are invoked');
    }
    return currentCreateRequestClient(principal);
  },
  get importService(): ImportService {
    if (!currentImportService) {
      throw new Error('Import service not initialized — main() must run before tools are invoked');
    }
    return currentImportService;
  },
};

registerLineTools(server, lineToolContext, lineToolDeps);
registerLineResources(server); // messenger overview + list_chats/get_messages/get_image/initiate_import/complete_import guides

// Bank tools (manage_templates, manage_categories, sample_messages,
// get_transactions, summarize_transactions) share the SAME live principal/
// request context as the messenger tools — a separate object mirroring
// lineToolContext's getters, backed by the same principalStore/requestStore.
const bankToolContext: RequestContext<LinePrincipal> = {
  get principal(): LinePrincipal {
    const principal = principalStore.getStore();
    if (!principal) throw new Error('No LINE principal in scope for this request');
    return principal;
  },
  get request(): ExpressRequest {
    const req = requestStore.getStore();
    if (!req) throw new Error('No request in scope for this call');
    return req;
  },
};

// Mirrors lineToolDeps: createMessageReader indirects through the SAME
// per-request client factory main() reassigns (the reader is that client's
// cache-backed message surface), and the category/template stores are live
// getters over the module-level `let`s main() sets. Presets are package-relative
// and constructed once above.
const bankToolDeps: BankToolDeps<LinePrincipal> = {
  createMessageReader: async (principal) => {
    if (!currentCreateRequestClient) {
      throw new Error('LINE request-client factory not initialized — main() must run before tools are invoked');
    }
    const client = await currentCreateRequestClient(principal);
    return client.messages;
  },
  get templates(): TemplateStore {
    if (!currentTemplateStore) {
      throw new Error('Template store not initialized — main() must run before tools are invoked');
    }
    return currentTemplateStore;
  },
  get categories(): CategoryStore {
    if (!currentCategoryStore) {
      throw new Error('Category store not initialized — main() must run before tools are invoked');
    }
    return currentCategoryStore;
  },
  presets: presetStore,
};

registerBankTools(server, bankToolContext, bankToolDeps);
// includeOverview: false — @raidenyn/line-mcp's registerLineResources() already
// owns the shared `line://guide` overview URI above; bank contributes only its
// five tool guides so the two registrations stay additive.
registerBankResources(server, { includeOverview: false });

function seedTestToken(provider: LineAuthProvider): void {
  const testToken = process.env.TEST_TOKEN;
  const authRaw = process.env.LINE_AUTH_DATA;
  if (!testToken || !authRaw) return;
  try {
    const authData: AuthData = JSON.parse(authRaw);
    provider.seedTestToken(testToken, authData);
    process.stderr.write('[LINE] Test token seeded from TEST_TOKEN + LINE_AUTH_DATA\n');
  } catch {
    process.stderr.write('[LINE] Warning: failed to seed test token — LINE_AUTH_DATA is not valid JSON\n');
  }
}

export interface MainOptions {
  // Overrides process.env.DATA_DIR — used by tests to guarantee an isolated
  // root that bootstrapPersistence() migrates instead of the developer's
  // real data/ directory. Production always omits this and gets the
  // process-wide default.
  dataRoot?: string;
  // Overrides process.env.PORT / the 3000 default — tests bind to an
  // ephemeral port (0) so they never collide with a real running server.
  port?: number;
}

export interface MainResult {
  server: ReturnType<express.Express['listen']>;
  syncHandle: ReturnType<typeof startSyncLoop>;
  active: ActivePersistence;
}

// Startup order is the one cutover contract this function exists to enforce:
// bootstrap the committed generation, then open the two stores against its
// paths, then construct the auth provider, then start sync (which needs a
// request-client factory derived from that provider), then start listening.
// Nothing here may construct SqliteMessageCache/CategoryStore, or read/write
// persistence state, before bootstrapPersistence() has returned.
export async function main(options: MainOptions = {}): Promise<MainResult> {
  const dataRoot = options.dataRoot ?? dataDir();
  const active = bootstrapPersistence({ dataRoot });

  // Two separate DB files (Task 2) — line messages and bank/category data no
  // longer share a single SQLite file the way the pre-migration schema did.
  // The bank category + template stores (Task 10) are shared across every
  // principal on this data root — the explicit trusted-tenant model, unlike the
  // owner-scoped line-message cache.
  sharedCache = new SqliteMessageCache({ dbPath: active.lineDbPath });
  currentCategoryStore = new CategoryStore(active.bankDbPath);
  currentTemplateStore = new TemplateStore(templatesDir(dataRoot));

  const PORT = options.port ?? parseInt(process.env.PORT ?? '3000', 10);
  const basePath = normalizeBasePath(process.env.BASE_PATH);

  // Construct the typed LINE auth provider. The executable owns secret loading
  // and endpoint derivation; the provider owns tokens, routes, and credential
  // resolution.
  const authStoreDir = authDir(dataRoot);
  const secret = loadOrCreateSecret(dataRoot);
  const credentialStore = new FileCredentialStore(authStoreDir);
  const authProvider = new LineAuthProvider({
    secret,
    endpoints: publicEndpointConfig(PORT, basePath),
    credentialStore,
    authStoreDir,
  });
  seedTestToken(authProvider);

  // The SAME request-client factory backs both the messenger tools
  // (currentCreateRequestClient, read by lineToolDeps above) and the sync
  // loop below — one seam, one credential-resolution/cache-wrapping behavior.
  currentCreateRequestClient = createRequestClientFactory({
    cache: sharedCache,
    resolveCredentials: (principal) => authProvider.resolveCredentials(principal),
    onAuthRefreshed: (fresh) => recordRefreshedAuth(fresh, authStoreDir),
  });
  currentImportService = new ImportService({
    basePath,
    cache: sharedCache,
    createRequestClient: currentCreateRequestClient,
    publicUrl: process.env.PUBLIC_URL,
  });

  // Scoped to this generation's credentialStore/cache — never the
  // process-wide default when a caller (e.g. a test) has passed an explicit
  // dataRoot override.
  const syncHandle = startSyncLoop(
    { credentialStore, cache: sharedCache, createRequestClient: currentCreateRequestClient },
    24 * 60 * 60 * 1000,
  );

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  authProvider.mountRoutes(app);
  // Import-upload route: mounted independently of OAuth's routes, per the
  // import service's own contract (issue #75, Task 9).
  currentImportService.mountRoutes(app);

  app.get(`${basePath}/healthz`, (_req, res) => {
    res.status(200).json({ status: 'ok', version: SERVER_VERSION });
  });

  app.get(`${basePath}/`, (_req, res) => {
    // index.html moved to @raidenyn/line-mcp's own assets/ (issue #75, Task 9).
    // require.resolve() follows the package's "main" (dist/index.js) in both
    // ts-node and compiled-dist modes, so this resolves correctly either way.
    const packageEntry = require.resolve('@raidenyn/line-mcp');
    res.sendFile(join(packageEntry, '..', '..', 'assets', 'index.html'));
  });

  app.post(`${basePath}/mcp`, async (req, res) => {
    const principal = await authProvider.authenticate(req);
    const authData = principal ? await authProvider.resolveCredentials(principal) : null;

    if (!authData || !principal) {
      res.status(401).set('WWW-Authenticate', authProvider.challenge(req)).json({ error: 'invalid_token' });
      return;
    }

    // authData is resolved above only to gate the request (401 when the
    // account must reauthorize); the tools themselves re-resolve credentials
    // per request via createRequestClient / createMessageReader, so it is not
    // threaded through AsyncLocalStorage.
    await principalStore.run(principal, async () => {
      await requestStore.run(req, async () => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close().catch(() => {}); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    });
  });

  app.get(`${basePath}/mcp`, (_req, res) => {
    res.status(405).send('Use POST /mcp');
  });

  const httpServer = await new Promise<ReturnType<express.Express['listen']>>((resolvePromise) => {
    const s = app.listen(PORT, '0.0.0.0', () => {
      process.stderr.write(`LINE MCP server listening on http://localhost:${PORT}${basePath}/mcp\n`);
      process.stderr.write(`Add to Claude Code: claude mcp add --transport http --scope user line http://localhost:${PORT}${basePath}/mcp\n`);
      resolvePromise(s);
    });
  });

  return { server: httpServer, syncHandle, active };
}

// Only auto-starts when this file is the process entry point (`ts-node
// src/index.ts` / the compiled dist/index.js run directly) — never when
// imported as a module (e.g. by tests exercising main() directly against an
// isolated dataRoot).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}
