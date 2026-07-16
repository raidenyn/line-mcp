import { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import Database from 'better-sqlite3';
import { spawn, ChildProcess } from 'child_process';
import { main as startMain, type MainResult } from '../src/index';
import * as persistenceMigrationModule from '../src/persistence-migration';
import * as lineClientSqliteModule from '@raidenyn/line-client-sqlite';
import * as categoryStoreModule from '../src/category-store';
import * as syncModule from '../src/sync';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 13117; // Fixed port for tests to avoid collisions
const MCP_URL = new URL(`http://localhost:${PORT}/mcp`);

let mcpClient: Client;
let transport: StreamableHTTPClientTransport;
let serverProcess: ChildProcess;
let authJson: string;
let testToken: string;
let isolatedDataDir: string;
let firstChatMid: string;
let imagePreviewUrl: string | null = null;

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function stopMain(result: MainResult | undefined): Promise<void> {
  if (!result) return;
  clearInterval(result.syncHandle);
  await new Promise<void>((resolve) => result.server.close(() => resolve()));
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function extractText(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/.well-known/oauth-authorization-server`, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Server did not become ready in time');
}

// This suite spawns the real compiled server against a genuine LINE account
// (via .line-auth.json) — kept in its own describe with its own beforeAll/
// afterAll so the startup-order and old-volume suites below (which run
// in-process against isolated temp roots and need neither a LINE account nor
// a spawned child process) are never gated behind it, and a `-t` filter that
// only matches those suites never triggers this one's setup.
describe('LINE MCP server e2e (real account)', () => {
  beforeAll(async () => {
    authJson = fs.readFileSync(path.join(PROJECT_ROOT, '.line-auth.json'), 'utf8');
    testToken = crypto.randomBytes(32).toString('hex');
    // Isolated DATA_DIR: since the server now runs bootstrapPersistence() on
    // every boot (Task 3 cutover), the spawned child must never be allowed to
    // migrate the developer's real data/ directory.
    isolatedDataDir = mkdtemp('line-mcp-e2e-data-');

    serverProcess = spawn(
      'npx',
      ['ts-node', path.join(PROJECT_ROOT, 'src', 'index.ts')],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PORT: String(PORT),
          LINE_AUTH_DATA: authJson,
          TEST_TOKEN: testToken,
          DATA_DIR: isolatedDataDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true, // spawn as process group leader so we can kill the whole group
      },
    );

    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk}`);
    });

    await waitForServer(`http://localhost:${PORT}`, 30_000);

    transport = new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: { headers: { Authorization: `Bearer ${testToken}` } },
    });
    mcpClient = new Client({ name: 'e2e-test', version: '1.0.0' });
    await mcpClient.connect(transport);
  }, 60_000);

  afterAll(async () => {
    // Categories are global (not per-chat) and persist in the isolated data dir — always
    // clean up test-created categories so this suite never leaks state across runs.
    try {
      await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'E2E-Test-Category' } });
      await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'E2E-Catchall' } });
    } catch {
      // best-effort cleanup
    }
    await transport?.close().catch(() => {});
    try {
      // Kill the whole process group (npx → ts-node → node) so nothing lingers on the port
      process.kill(-serverProcess.pid!, 'SIGTERM');
    } catch {
      serverProcess.kill();
    }
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  });

  it('list_chats returns at least one chat with a mid', async () => {
    const result = await mcpClient.callTool({ name: 'list_chats', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = extractText(result);
    expect(text).toMatch(/\[(?:GROUP|USER)\]/);
    const mids = [...text.matchAll(/^\s+mid:\s+(\S+)/gm)].map((m) => m[1]);
    expect(mids.length).toBeGreaterThan(0);
    firstChatMid = mids[0];
    (globalThis as Record<string, unknown>).__allChatMids = mids;
  });

  it('get_messages returns messages for a valid chatMid', async () => {
    const allMids: string[] = ((globalThis as Record<string, unknown>).__allChatMids as string[]) ?? [firstChatMid];
    let messagesText: string | null = null;
    for (const mid of allMids) {
      const result = await mcpClient.callTool({
        name: 'get_messages',
        arguments: { chatMid: mid, count: 20 },
      });
      if (result.isError) continue;
      const text = extractText(result);
      if (text === 'No messages found.') continue;
      messagesText = text;
      firstChatMid = mid;
      break;
    }
    if (!messagesText) {
      console.warn('No chat with messages found — skipping timestamp assertion');
      return;
    }
    expect(messagesText).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const previewMatch = messagesText.match(/\(preview:\s+(https?:\/\/\S+)\)/);
    if (previewMatch) imagePreviewUrl = previewMatch[1];
  });

  it('get_messages rejects count > 200', async () => {
    expect(firstChatMid).toBeTruthy();
    const result = await mcpClient.callTool({
      name: 'get_messages',
      arguments: { chatMid: firstChatMid, count: 999 },
    });
    expect(result.isError).toBe(true);
  });

  it('get_image returns a base64 image when a previewUrl is available', async ({ skip }) => {
    if (!imagePreviewUrl) {
      skip();
    }
    const result = await mcpClient.callTool({
      name: 'get_image',
      arguments: { url: imagePreviewUrl },
    });
    expect(result.isError).toBeFalsy();
    const item = result.content[0];
    expect(item.type).toBe('image');
    if (item.type === 'image') {
      expect(item.mimeType).toMatch(/^image\//);
      expect(Buffer.from(item.data, 'base64').length).toBeGreaterThan(0);
    }
  });

  it('get_image returns isError for a bad URL', async () => {
    const result = await mcpClient.callTool({
      name: 'get_image',
      arguments: { url: 'https://invalid.example.test/no-such.jpg' },
    });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toMatch(/Failed to fetch image/);
  });

  it('summarize_transactions accepts chatMid directly', async () => {
    expect(firstChatMid).toBeTruthy();
    const result = await mcpClient.callTool({
      name: 'summarize_transactions',
      arguments: { chatMid: firstChatMid, group_by: 'month' },
    });
    // Either a valid summary or "no saved templates" — both prove the new interface is wired
    const text = extractText(result);
    const isValidSummary = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
    const isNoTemplatesError = text.includes('No templates') || text.includes('no saved templates');
    expect(isValidSummary || isNoTemplatesError).toBe(true);
  });

  it('manage_categories upsert/list/delete round-trip', async () => {
    const upsertResult = await mcpClient.callTool({
      name: 'manage_categories',
      arguments: { action: 'upsert', category: { name: 'E2E-Test-Category', pattern: 'DOES_NOT_MATCH_ANYTHING_XYZ123' } },
    });
    expect(upsertResult.isError).toBeFalsy();

    const listAfterUpsert = extractText(await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'list' } }));
    const categoriesAfterUpsert = JSON.parse(listAfterUpsert) as Array<{ name: string; pattern: string }>;
    expect(categoriesAfterUpsert.find((c) => c.name === 'E2E-Test-Category')?.pattern).toBe('DOES_NOT_MATCH_ANYTHING_XYZ123');

    const deleteResult = await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'E2E-Test-Category' } });
    expect(deleteResult.isError).toBeFalsy();

    const listAfterDelete = extractText(await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'list' } }));
    const categoriesAfterDelete = listAfterDelete.startsWith('[') ? (JSON.parse(listAfterDelete) as Array<{ name: string }>) : [];
    expect(categoriesAfterDelete.find((c) => c.name === 'E2E-Test-Category')).toBeUndefined();
  });

  it('get_transactions stamps a category on every transaction it returns', async () => {
    // Catchall pattern matches merchant/rawText on any transaction, proving categorize()
    // runs against real parsed data end-to-end — not just unit-level mocked transactions.
    const upsertResult = await mcpClient.callTool({
      name: 'manage_categories',
      arguments: { action: 'upsert', category: { name: 'E2E-Catchall', pattern: '.' } },
    });
    expect(upsertResult.isError).toBeFalsy();

    // firstChatMid is picked for message presence, not saved-template presence — search all
    // known chats for one that actually has templates, so this test exercises real transaction
    // data whenever any chat in the account has saved templates.
    const allMids: string[] = ((globalThis as Record<string, unknown>).__allChatMids as string[]) ?? [firstChatMid];
    let transactions: Array<{ category?: string }> | null = null;
    for (const mid of allMids) {
      const result = await mcpClient.callTool({ name: 'get_transactions', arguments: { chatMid: mid } });
      const parsed = (() => { try { return JSON.parse(extractText(result)) as Array<{ category?: string }>; } catch { return null; } })();
      if (parsed !== null) {
        transactions = parsed;
        break;
      }
    }

    if (transactions === null) {
      // No chat in the account has saved templates — categorization has nothing to run
      // against. Still proves the tool is wired; parsing/categorizing logic is unit-tested.
      console.warn('No chat with saved templates found — skipping category-value assertions');
    } else {
      expect(transactions.length).toBeGreaterThan(0);
      for (const tx of transactions) {
        expect(typeof tx.category).toBe('string');
        expect(tx.category!.length).toBeGreaterThan(0);
      }
    }

    await mcpClient.callTool({ name: 'manage_categories', arguments: { action: 'delete', name: 'E2E-Catchall' } });
  });

  it('summarize_transactions accepts group_by: category', async () => {
    expect(firstChatMid).toBeTruthy();
    const result = await mcpClient.callTool({
      name: 'summarize_transactions',
      arguments: { chatMid: firstChatMid, group_by: 'category' },
    });
    const text = extractText(result);
    const isValidSummary = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
    const isNoTemplatesError = text.includes('No templates') || text.includes('no saved templates');
    expect(isValidSummary || isNoTemplatesError).toBe(true);
  });

  it('resources/list returns all 11 guide URIs', async () => {
    const result = await mcpClient.listResources();
    const uris = result.resources.map((r) => r.uri);
    const expected = [
      'line://guide',
      'line://guide/tools/list_chats',
      'line://guide/tools/get_messages',
      'line://guide/tools/get_image',
      'line://guide/tools/sample_messages',
      'line://guide/tools/manage_templates',
      'line://guide/tools/manage_categories',
      'line://guide/tools/get_transactions',
      'line://guide/tools/summarize_transactions',
      'line://guide/tools/initiate_import',
      'line://guide/tools/complete_import',
    ];
    for (const uri of expected) {
      expect(uris).toContain(uri);
    }
  });

  it('resources/read returns non-empty markdown for line://guide', async () => {
    const result = await mcpClient.readResource({ uri: 'line://guide' });
    expect(result.contents).toHaveLength(1);
    const item = result.contents[0];
    expect(item.mimeType).toBe('text/markdown');
    expect('text' in item).toBe(true);
    if ('text' in item) {
      expect(item.text.length).toBeGreaterThan(0);
    }
  });
});

// ─── Startup order (Task 3, Step 2) ──────────────────────────────────────────
//
// Runs main() in-process against an isolated temp dataRoot — no spawned
// child, no .line-auth.json required. Spies wrap the exact functions/classes
// src/index.ts's main() calls (bootstrapPersistence, SqliteMessageCache,
// CategoryStore, startSyncLoop) and call through to the real implementation,
// so this observes the real construction points, not a decoupled log.
describe('startup order', () => {
  let tempDataRoot: string;
  let events: string[];
  let result: MainResult | undefined;

  beforeEach(() => {
    tempDataRoot = mkdtemp('line-mcp-startup-');
    events = [];
  });

  afterEach(async () => {
    await stopMain(result);
    result = undefined;
    vi.restoreAllMocks();
    fs.rmSync(tempDataRoot, { recursive: true, force: true });
  });

  it('boots in the committed order: bootstrap-persistence, open-line-cache, open-bank-store, start-sync, listen', async () => {
    const originalBootstrap = persistenceMigrationModule.bootstrapPersistence;
    vi.spyOn(persistenceMigrationModule, 'bootstrapPersistence').mockImplementation(
      (...args: Parameters<typeof originalBootstrap>) => {
        events.push('bootstrap-persistence');
        return originalBootstrap(...args);
      },
    );

    const OriginalMessageCache = lineClientSqliteModule.SqliteMessageCache;
    vi.spyOn(lineClientSqliteModule, 'SqliteMessageCache').mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof OriginalMessageCache>
    ) {
      events.push('open-line-cache');
      return new OriginalMessageCache(...args);
    } as unknown as typeof OriginalMessageCache);

    const OriginalCategoryStore = categoryStoreModule.CategoryStore;
    vi.spyOn(categoryStoreModule, 'CategoryStore').mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof OriginalCategoryStore>
    ) {
      events.push('open-bank-store');
      return new OriginalCategoryStore(...args);
    } as unknown as typeof OriginalCategoryStore);

    const originalStartSync = syncModule.startSyncLoop;
    vi.spyOn(syncModule, 'startSyncLoop').mockImplementation(
      (...args: Parameters<typeof originalStartSync>) => {
        events.push('start-sync');
        return originalStartSync(...args);
      },
    );

    result = await startMain({ dataRoot: tempDataRoot, port: 0 });
    // main()'s returned promise only resolves inside the real app.listen()
    // success callback (see src/index.ts) — there is no other path to
    // resolution, so recording this here is sequenced by the real event.
    events.push('listen');

    expect(events).toEqual([
      'bootstrap-persistence',
      'open-line-cache',
      'open-bank-store',
      'start-sync',
      'listen',
    ]);

    // Confirms the spied constructors really were the ones index.ts used
    // (not a coincidental unrelated call): the active generation's DB files
    // must actually exist on disk afterwards.
    expect(fs.existsSync(result.active.lineDbPath)).toBe(true);
    expect(fs.existsSync(result.active.bankDbPath)).toBe(true);
  });
});

// ─── Old-volume startup (Task 3, Step 2) ─────────────────────────────────────
//
// A legacy (pre-Task-1, un-owned) cache/messages.db + a single valid auth
// record is the exact shape bootstrapPersistence() auto-attributes. Boots
// main() in-process against it and asserts the compiled server actually
// starts against the migrated generation, not the legacy file.
describe('old volume migration', () => {
  let tempDataRoot: string;
  let result: MainResult | undefined;

  beforeEach(() => {
    tempDataRoot = mkdtemp('line-mcp-oldvol-');
  });

  afterEach(async () => {
    await stopMain(result);
    result = undefined;
    fs.rmSync(tempDataRoot, { recursive: true, force: true });
  });

  it('starts successfully against a pre-owner-scoped legacy data root and migrates it on first boot', async () => {
    const dbPath = path.join(tempDataRoot, 'cache', 'messages.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE messages (
        chat_mid     TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        created_time INTEGER NOT NULL,
        raw_json     TEXT    NOT NULL,
        PRIMARY KEY (chat_mid, message_id)
      );
      CREATE TABLE categories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL UNIQUE,
        pattern TEXT NOT NULL
      );
    `);
    legacyDb.prepare(
      'INSERT INTO messages (chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?)',
    ).run(
      'c1', 'm1', 1000,
      JSON.stringify({
        id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '1000',
        contentType: 0, hasContent: false, text: 'hi',
      }),
    );
    legacyDb.close();

    const legacyAuthDir = path.join(tempDataRoot, 'auth');
    fs.mkdirSync(legacyAuthDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAuthDir, 'u-legacy-owner.json'), JSON.stringify({
      accessToken: 'a', refreshToken: 'r', certificate: 'c', mid: 'u-legacy-owner',
      wrappedNonce: 'n', kdfParameter1: 'k1', kdfParameter2: 'k2',
    }));

    result = await startMain({ dataRoot: tempDataRoot, port: 0 });

    expect(fs.existsSync(path.join(tempDataRoot, 'persistence-current.json'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(result.active.reportPath, 'utf8')) as {
      legacySourcePresent: boolean;
      ownerMid: string | null;
      counts: { attributedMessages: number };
    };
    expect(report.legacySourcePresent).toBe(true);
    expect(report.ownerMid).toBe('u-legacy-owner');
    expect(report.counts.attributedMessages).toBe(1);

    const cache = new lineClientSqliteModule.SqliteMessageCache({ dbPath: result.active.lineDbPath });
    try {
      expect(cache.getMessages('u-legacy-owner', 'c1')).toHaveLength(1);
    } finally {
      cache.close();
    }

    // The legacy source file is a read-only recovery snapshot — never mutated.
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
