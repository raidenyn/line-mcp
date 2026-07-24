import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import * as persistenceMigrationModule from './persistence-migration';
import * as lineClientSqliteModule from '@raidenyn/line-client-sqlite';
import * as bankMcpModule from '@raidenyn/bank-mcp';
import * as lineMcpModule from '@raidenyn/line-mcp';
import { createServer, type ComposedServer, type StartResult } from './server';

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Startup order (mirrors the pre-Task-11 root src/index.ts e2e suite) ─────
//
// Runs createServer(...).start() in-process against an isolated temp
// dataRoot — no spawned child, no .line-auth.json required. Spies wrap the
// exact functions/classes server.ts's start() calls (bootstrapPersistence,
// SqliteMessageCache, CategoryStore, startSyncLoop) and call through to the
// real implementation, so this observes the real construction points, not a
// decoupled log.
describe('composed server — startup order', () => {
  let tempDataRoot: string;
  let events: string[];
  let server: ComposedServer | undefined;

  beforeEach(() => {
    tempDataRoot = mkdtemp('server-startup-');
    events = [];
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
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

    const OriginalCategoryStore = bankMcpModule.CategoryStore;
    vi.spyOn(bankMcpModule, 'CategoryStore').mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof OriginalCategoryStore>
    ) {
      events.push('open-bank-store');
      return new OriginalCategoryStore(...args);
    } as unknown as typeof OriginalCategoryStore);

    const OriginalRegexExecutor = bankMcpModule.RegexExecutor;
    vi.spyOn(bankMcpModule, 'RegexExecutor').mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof OriginalRegexExecutor>
    ) {
      events.push('create-regex-executor');
      return new OriginalRegexExecutor(...args);
    } as unknown as typeof OriginalRegexExecutor);

    const originalStartSync = lineMcpModule.startSyncLoop;
    vi.spyOn(lineMcpModule, 'startSyncLoop').mockImplementation(
      (...args: Parameters<typeof originalStartSync>) => {
        events.push('start-sync');
        return originalStartSync(...args);
      },
    );

    server = createServer({ dataRoot: tempDataRoot, port: 0 });
    const result: StartResult = await server.start();
    // start()'s returned promise only resolves inside the real app.listen()
    // success callback (see server.ts) — there is no other path to
    // resolution, so recording this here is sequenced by the real event.
    events.push('listen');

    expect(events).toEqual([
      'bootstrap-persistence',
      'open-line-cache',
      'open-bank-store',
      'create-regex-executor',
      'start-sync',
      'listen',
    ]);

    // Confirms the spied constructors really were the ones server.ts used
    // (not a coincidental unrelated call): the active generation's DB files
    // must actually exist on disk afterwards.
    expect(fs.existsSync(result.active.lineDbPath)).toBe(true);
    expect(fs.existsSync(result.active.bankDbPath)).toBe(true);
  });

  it('stop() is idempotent — a second close of the regex executor does not reject', async () => {
    const createdExecutors: InstanceType<typeof bankMcpModule.RegexExecutor>[] = [];
    const OriginalRegexExecutor = bankMcpModule.RegexExecutor;
    vi.spyOn(bankMcpModule, 'RegexExecutor').mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof OriginalRegexExecutor>
    ) {
      const instance = new OriginalRegexExecutor(...args);
      createdExecutors.push(instance);
      return instance;
    } as unknown as typeof OriginalRegexExecutor);

    server = createServer({ dataRoot: tempDataRoot, port: 0 });
    await server.start();
    expect(createdExecutors).toHaveLength(1);
    const executor = createdExecutors[0];
    const closeSpy = vi.spyOn(executor, 'close');

    await server.stop();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Second stop() must not reject — executor close is idempotent.
    await expect(server.stop()).resolves.toBeUndefined();
    server = undefined; // prevent afterEach from calling stop() again
  });
});

// ─── Old-volume startup ───────────────────────────────────────────────────────
//
// A legacy (pre-owner-scoped) cache/messages.db + a single valid auth record
// is the exact shape bootstrapPersistence() auto-attributes. Boots the
// composed server in-process against it and asserts it actually starts
// against the migrated generation, not the legacy file.
describe('composed server — old volume migration', () => {
  let tempDataRoot: string;
  let server: ComposedServer | undefined;

  beforeEach(() => {
    tempDataRoot = mkdtemp('server-oldvol-');
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
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

    server = createServer({ dataRoot: tempDataRoot, port: 0 });
    const result = await server.start();

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
