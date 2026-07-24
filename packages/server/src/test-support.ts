// Shared, offline test-only fixtures for the composition/isolation/trusted-
// tenant test suites in this package. Never imported by production code
// (server.ts/cli.ts/registrations.ts never reference this file) — it exists
// purely so composition.test.ts and trusted-tenant.test.ts can drive the REAL
// production registration wiring (`buildRegistrations`, the real
// `SqliteMessageCache`, the real `CategoryStore`/`TemplateStore`, the real
// `withMessageCache` binding) without ever making a live LINE network call.
// Only the raw LINE HTTP surface (`LineApiClient`) is faked; everything else
// downstream of it (caching, isolation-by-mid, sharing, tool/resource
// registration, the MCP protocol itself) is exercised for real.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { withMessageCache, type LineApiClient, type MessageCache } from '@raidenyn/line-client';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';
import { ImportService, type LineToolDeps, type LinePrincipal } from '@raidenyn/line-mcp';
import { CategoryStore, TemplateStore, PresetStore, RegexExecutor, type BankToolDeps } from '@raidenyn/bank-mcp';
import type { RequestLineClient } from './request-client';
import { buildRegistrations, type ComposedDeps } from './registrations';

export function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A LineApiClient stub that never touches the network — every LINE call site
 * used by the composed tools returns an empty/no-op result, so the ONLY data
 * a test observes comes from whatever was pre-seeded directly into the real
 * SqliteMessageCache. */
export function fakeLineApi(): LineApiClient {
  return {
    isAuthenticated: () => true,
    getCompletedAuth: () => null,
    getProfileDisplayName: async () => 'Test User',
    waitForPin: async () => null,
    waitForCompletion: async () => {},
    login: async () => ({ qrUrl: 'https://example.test/qr' }),
    listChats: async () => [],
    getMessages: async () => [],
    getMessagesInRange: async () => [],
    getImageBuffer: async () => {
      throw new Error('fakeLineApi: getImageBuffer is not exercised by this test fixture');
    },
  };
}

/**
 * A `createRequestClient` factory backed by a REAL cache: `api` is the network
 * stub above (uncached, per Step 2's contract); `messages` is the SAME
 * `withMessageCache` binding production uses, keyed by `principal.mid` — so
 * isolation between two principals is enforced by the real cache, exactly as
 * in production.
 */
export function fakeCreateRequestClient(cache: MessageCache) {
  return async (principal: LinePrincipal): Promise<RequestLineClient> => {
    const api = fakeLineApi();
    return { api, messages: withMessageCache(api, cache, principal.mid) };
  };
}

export interface ComposedFixture {
  dataRoot: string;
  cache: SqliteMessageCache;
  categories: CategoryStore;
  templates: TemplateStore;
  deps: ComposedDeps;
  cleanup(): Promise<void>;
}

/**
 * Builds the exact same `ComposedDeps` shape `createServer` assembles in
 * production (real cache, real shared category/template stores, real
 * `ImportService`), swapping in `fakeCreateRequestClient` as the ONLY
 * test-double seam. `buildRegistrations(fixture.deps)` then yields the real
 * production registration closures.
 */
export function buildComposedFixture(guideDir: string): ComposedFixture {
  const dataRoot = mkdtemp('server-composition-');
  const cacheInstance = new SqliteMessageCache({ dbPath: path.join(dataRoot, 'line', 'messages.db') });
  const categories = new CategoryStore(path.join(dataRoot, 'bank', 'bank.db'));
  const templates = new TemplateStore(path.join(dataRoot, 'templates'));
  const presets = new PresetStore();
  const regex = new RegexExecutor();

  const createRequestClient = fakeCreateRequestClient(cacheInstance);
  const importService = new ImportService({ basePath: '', cache: cacheInstance, createRequestClient });

  const line: LineToolDeps = { createRequestClient, importService };
  const bank: BankToolDeps<LinePrincipal> = {
    createMessageReader: async (principal) => (await createRequestClient(principal)).messages,
    templates,
    categories,
    presets,
    regex,
  };

  return {
    dataRoot,
    cache: cacheInstance,
    categories,
    templates,
    deps: { line, bank, guideDir },
    async cleanup(): Promise<void> {
      await regex.close();
      cacheInstance.close();
      categories.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

export { buildRegistrations };
