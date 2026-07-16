import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type express from 'express';
import { createMcpHost, normalizeBasePath, type McpHost } from '@raidenyn/mcp-runtime';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';
import { LineAuthProvider, publicEndpointConfig, type LinePrincipal } from './auth/line-auth-provider';
import { FileCredentialStore, recordRefreshedAuth } from './auth/credential-store';
import { registerLineTools } from './tools';
import { registerLineResources } from './resources';
import { ImportService } from './import-service';
import { createRequestClientFactory } from './request-client';
import { startSyncLoop } from './sync';

// ─── Explicit, standalone-owned path derivation ─────────────────────────────
// This factory NEVER reads process.cwd() — every path derives from the
// `dataRoot` the caller (cli.ts) passes in explicitly.

function authDirOf(dataRoot: string): string {
  return path.join(dataRoot, 'auth');
}

function legacyCacheDbPath(dataRoot: string): string {
  return path.join(dataRoot, 'cache', 'messages.db');
}

/**
 * Dedicated path for a fresh standalone-layout database — never the legacy
 * monolith's `cache/messages.db`, and never `persistence-generations/...`
 * (that tree is the composed server's migration output). Keeping this
 * distinct from `legacyCacheDbPath` is what lets `hasUnmigratedLegacyDatabase`
 * keep meaning "a real legacy monolith database exists" even after this
 * standalone server has run (and persisted its own data) many times.
 */
function standaloneLineDbPath(dataRoot: string): string {
  return path.join(dataRoot, 'line-mcp', 'messages.db');
}

function pointerPath(dataRoot: string): string {
  return path.join(dataRoot, 'persistence-current.json');
}

function secretPath(dataRoot: string): string {
  return path.join(dataRoot, 'secret');
}

function loadOrCreateSecret(dataRoot: string): string {
  const file = secretPath(dataRoot);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, 'utf8');
    return secret;
  }
}

const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Detects a database layout this factory refuses to touch: a legacy combined
 * `cache/messages.db` with NO committed `persistence-current.json` pointer.
 * That shape only exists pre-migration (issue #75, Task 3) and mixes line
 * messages with bank/category data the standalone server knows nothing about
 * — migrating it is the composed server's job, not this factory's.
 */
function hasUnmigratedLegacyDatabase(dataRoot: string): boolean {
  return !fs.existsSync(pointerPath(dataRoot)) && fs.existsSync(legacyCacheDbPath(dataRoot));
}

/** Resolves the line-messages DB path for this data root: pointer-committed generation if present, else a fresh standalone layout. */
function resolveLineDbPath(dataRoot: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(pointerPath(dataRoot), 'utf8')) as { generation?: string };
    if (typeof manifest.generation === 'string' && GENERATION_ID_PATTERN.test(manifest.generation)) {
      return path.join(dataRoot, 'persistence-generations', manifest.generation, 'line', 'messages.db');
    }
  } catch {
    // No pointer, or an unreadable one — treat as a fresh standalone layout.
  }
  return standaloneLineDbPath(dataRoot);
}

export interface StandaloneOptions {
  /** Explicit data root — never defaulted to process.cwd() here; cli.ts resolves it. */
  dataRoot: string;
  port?: number;
  basePath?: string;
  /** Overrides the auto-derived public base URL used in import upload links. */
  publicUrl?: string;
}

export interface StandaloneServer {
  /** Starts listening and returns the bound port (useful when `port: 0` was requested). */
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

/**
 * Builds a fully-wired standalone LINE messenger MCP server: its own
 * `LineAuthProvider`, its own `SqliteMessageCache`, its own `ImportService`,
 * and its own sync loop — composed through `createMcpHost` from
 * `@raidenyn/mcp-runtime`. Constructing this object has NO side effects;
 * nothing is created, opened, or listened on until `.start()` is called.
 */
export function createStandaloneServer(options: StandaloneOptions): StandaloneServer {
  const dataRoot = options.dataRoot;
  const basePath = normalizeBasePath(options.basePath ?? process.env.BASE_PATH);
  const port = options.port ?? parseInt(process.env.PORT ?? '3000', 10);

  let cache: SqliteMessageCache | undefined;
  let syncHandle: ReturnType<typeof setInterval> | undefined;
  let httpServer: ReturnType<express.Express['listen']> | undefined;

  return {
    async start(): Promise<{ port: number }> {
      if (hasUnmigratedLegacyDatabase(dataRoot)) {
        throw new Error(
          'Detected a legacy combined database at cache/messages.db with no persistence-current.json pointer. ' +
          'This standalone LINE MCP server never migrates bank/category data itself — ' +
          'run the composed server once first (its startup performs the one-time persistence migration), ' +
          'then restart this standalone server.',
        );
      }

      const lineDbPath = resolveLineDbPath(dataRoot);
      cache = new SqliteMessageCache({ dbPath: lineDbPath });

      const authStoreDir = authDirOf(dataRoot);
      const secret = loadOrCreateSecret(dataRoot);
      const credentialStore = new FileCredentialStore(authStoreDir);
      const authProvider = new LineAuthProvider({
        secret,
        endpoints: publicEndpointConfig(port, basePath),
        credentialStore,
        authStoreDir,
      });

      const createRequestClient = createRequestClientFactory({
        cache,
        resolveCredentials: (principal) => authProvider.resolveCredentials(principal),
        onAuthRefreshed: (fresh) => recordRefreshedAuth(fresh, authStoreDir),
      });

      const importService = new ImportService({
        basePath,
        cache,
        createRequestClient,
        publicUrl: options.publicUrl ?? process.env.PUBLIC_URL,
      });

      const host: McpHost = createMcpHost<LinePrincipal>({
        name: 'line-mcp-standalone',
        version: '1.0.0',
        basePath,
        authProvider,
        registrations: [
          (server, context) => registerLineTools(server, context, { createRequestClient, importService }),
          (server) => registerLineResources(server),
        ],
      });
      importService.mountRoutes(host.app);

      syncHandle = startSyncLoop({ credentialStore, cache, createRequestClient });

      httpServer = await new Promise<ReturnType<express.Express['listen']>>((resolvePromise) => {
        const s = host.app.listen(port, '0.0.0.0', () => resolvePromise(s));
      });
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { port: actualPort };
    },

    async stop(): Promise<void> {
      if (syncHandle) clearInterval(syncHandle);
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
      cache?.close();
    },
  };
}
