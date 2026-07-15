import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  bootstrapPersistence,
  resolveGenerationPaths,
  validateMigrationCounts,
  recoverQuarantinedMessages,
  type ActivePersistence,
  type FailPoint,
  type MigrationReport,
} from './persistence-migration';
import { MessageCache } from './message-cache';

// ─── Fixture builders ─────────────────────────────────────────────────────────

interface LegacyMessageInput {
  chatMid: string;
  messageId: string;
  createdTime: number;
  text?: string;
}

interface LegacyCategoryInput {
  id: number;
  name: string;
  pattern: string;
}

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-persistence-'));
}

// Builds a pre-Task-1 (un-owned) legacy cache/messages.db, exactly matching
// the schema MessageCache used before the owner-scoping change: no
// owner_mid column, PRIMARY KEY (chat_mid, message_id), plus the categories
// table that historically shared the same file.
function buildLegacyDb(
  dataRoot: string,
  messages: LegacyMessageInput[],
  categories: LegacyCategoryInput[],
): void {
  const dbPath = path.join(dataRoot, 'cache', 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      chat_mid     TEXT    NOT NULL,
      message_id   TEXT    NOT NULL,
      created_time INTEGER NOT NULL,
      raw_json     TEXT    NOT NULL,
      PRIMARY KEY (chat_mid, message_id)
    );
    CREATE INDEX idx_messages_chat_time ON messages (chat_mid, created_time);
    CREATE TABLE categories (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE,
      pattern TEXT NOT NULL
    );
  `);
  const insertMsg = db.prepare(
    'INSERT INTO messages (chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?)',
  );
  for (const m of messages) {
    const raw = JSON.stringify({
      id: m.messageId, from: m.chatMid, to: m.chatMid, toType: 1,
      createdTime: String(m.createdTime), contentType: 0, hasContent: false, text: m.text ?? 'hi',
    });
    insertMsg.run(m.chatMid, m.messageId, m.createdTime, raw);
  }
  const insertCat = db.prepare('INSERT INTO categories (id, name, pattern) VALUES (?, ?, ?)');
  for (const c of categories) insertCat.run(c.id, c.name, c.pattern);
  db.close();
}

function writeValidAuthRecord(dataRoot: string, mid: string): void {
  const dir = path.join(dataRoot, 'auth');
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    accessToken: `access-${mid}`, refreshToken: `refresh-${mid}`, certificate: `cert-${mid}`,
    mid, wrappedNonce: `nonce-${mid}`, kdfParameter1: 'k1', kdfParameter2: 'k2',
  };
  fs.writeFileSync(path.join(dir, `${mid}.json`), JSON.stringify(record));
}

function writeInvalidAuthRecord(dataRoot: string, filename: string): void {
  const dir = path.join(dataRoot, 'auth');
  fs.mkdirSync(dir, { recursive: true });
  // Missing required fields — structurally invalid, not just "unknown".
  fs.writeFileSync(path.join(dir, filename), JSON.stringify({ mid: filename.replace(/\.json$/, '') }));
}

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Only still-unresolved rows count as "quarantined" from a caller's
// perspective — every pre-recovery test in this file only ever produces
// unresolved rows (resolution_owner_mid is always NULL at that point), so this
// filter changes nothing for them. Task 3's recovery tests rely on it to
// assert that a *resolved* row is no longer counted as quarantined, while a
// raw, unfiltered query (used separately by the recovery tests) still proves
// the underlying row itself was retained rather than deleted.
function quarantineRows(quarantineDbPath: string): Array<Record<string, unknown>> {
  const db = new Database(quarantineDbPath, { readonly: true });
  try {
    return db.prepare(
      'SELECT * FROM legacy_messages WHERE resolution_owner_mid IS NULL ORDER BY source_key ASC',
    ).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function rawQuarantineRow(quarantineDbPath: string, sourceKey: string): Record<string, unknown> | undefined {
  const db = new Database(quarantineDbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM legacy_messages WHERE source_key = ?').get(sourceKey) as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
}

function readReport(reportPath: string): MigrationReport {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as MigrationReport;
}

// ─── Ownership decision matrix (Step 1) ──────────────────────────────────────

type FixtureCase =
  | 'fresh-root'
  | 'single-valid-auth'
  | 'zero-auth'
  | 'invalid-auth'
  | 'valid-plus-invalid-auth'
  | 'multiple-valid-auth'
  | 'imported-only-history'
  | 'overlapping-chat'
  | 'categories-only'
  | 'messages-only'
  | 'corrupt-source';

interface FixtureExpectation {
  sourceMessages: number;
  sourceCategories: number;
  expectedOwner: string | false;
}

const OWNER = 'u-owner-a';
const OTHER_OWNER = 'u-owner-b';

// Builds each named fixture under a fresh temp dataRoot and returns what the
// decision matrix must produce. `corrupt-source` is handled separately below
// (bootstrapPersistence must throw, not produce a report).
function buildFixture(kind: FixtureCase, dataRoot: string): FixtureExpectation {
  switch (kind) {
    case 'fresh-root':
      // No cache/messages.db, no auth dir at all.
      return { sourceMessages: 0, sourceCategories: 0, expectedOwner: false };

    case 'single-valid-auth':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: OWNER };

    case 'zero-auth':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      // Auth dir intentionally left absent — zero candidates.
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: false };

    case 'invalid-auth':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeInvalidAuthRecord(dataRoot, 'u-broken.json');
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: false };

    case 'valid-plus-invalid-auth':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      writeInvalidAuthRecord(dataRoot, 'u-broken.json');
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: false };

    case 'multiple-valid-auth':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      writeValidAuthRecord(dataRoot, OTHER_OWNER);
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: false };

    case 'imported-only-history':
      // Synthetic import-flow message ids (see export-parser.ts), same shape
      // otherwise — migration must not special-case them.
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'export-abc123', createdTime: 1000 },
        { chatMid: 'c1', messageId: 'export-def456', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: OWNER };

    case 'overlapping-chat':
      // Both rows share the same chat_mid — proves attribution never keys
      // off chat_mid grouping, only the single-valid-auth rule.
      buildLegacyDb(dataRoot, [
        { chatMid: 'c-shared', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c-shared', messageId: 'm2', createdTime: 2000 },
      ], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      return { sourceMessages: 2, sourceCategories: 2, expectedOwner: OWNER };

    case 'categories-only':
      // No messages at all; a valid auth candidate is present but must be
      // irrelevant since there is nothing to attribute.
      buildLegacyDb(dataRoot, [], [
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
      writeValidAuthRecord(dataRoot, OWNER);
      return { sourceMessages: 0, sourceCategories: 2, expectedOwner: false };

    case 'messages-only':
      buildLegacyDb(dataRoot, [
        { chatMid: 'c1', messageId: 'm1', createdTime: 1000 },
        { chatMid: 'c2', messageId: 'm2', createdTime: 2000 },
      ], []);
      writeValidAuthRecord(dataRoot, OWNER);
      return { sourceMessages: 2, sourceCategories: 0, expectedOwner: OWNER };

    case 'corrupt-source':
      throw new Error('corrupt-source is built directly by its own test, not via buildFixture');
  }
}

describe('persistence-migration: ownership decision matrix', () => {
  let dataRoot: string;

  beforeEach(() => { dataRoot = mkdtemp(); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  const cases: FixtureCase[] = [
    'fresh-root',
    'single-valid-auth',
    'zero-auth',
    'invalid-auth',
    'valid-plus-invalid-auth',
    'multiple-valid-auth',
    'imported-only-history',
    'overlapping-chat',
    'categories-only',
    'messages-only',
  ];

  for (const kind of cases) {
    it(`decides ownership correctly for fixture "${kind}"`, () => {
      const expected = buildFixture(kind, dataRoot);
      const active = bootstrapPersistence({ dataRoot });
      const report = readReport(active.reportPath);

      expect(report.counts).toEqual({
        sourceMessages: expected.sourceMessages,
        attributedMessages: expected.expectedOwner ? expected.sourceMessages : 0,
        quarantinedMessages: expected.expectedOwner ? 0 : expected.sourceMessages,
        sourceCategories: expected.sourceCategories,
        copiedCategories: expected.sourceCategories,
      });

      if (expected.expectedOwner) {
        expect(report.ownerMid).toBe(expected.expectedOwner);
        expect(report.quarantineReason).toBeNull();
      } else {
        expect(report.ownerMid).toBeNull();
        if (expected.sourceMessages > 0) {
          expect(report.quarantineReason).toBeTruthy();
        }
      }
    });
  }

  it('attributed messages are readable through the normal owner-scoped MessageCache API', () => {
    buildFixture('single-valid-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    const cache = new MessageCache(active.lineDbPath);
    try {
      expect(cache.getMessages(OWNER, 'c1').map(m => m.id)).toEqual(['m1']);
      expect(cache.getMessages(OWNER, 'c2').map(m => m.id)).toEqual(['m2']);
      // No other owner can see these rows either.
      expect(cache.getMessages('someone-else', 'c1')).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it('quarantined rows are queryable in legacy_messages with reason/audit-stable source_key set, and unresolved', () => {
    buildFixture('multiple-valid-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    const rows = quarantineRows(active.quarantineDbPath);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.source_key).sort()).toEqual(['c1/m1', 'c2/m2'].sort());
    for (const row of rows) {
      expect(typeof row.reason).toBe('string');
      expect((row.reason as string).length).toBeGreaterThan(0);
      expect(row.resolution_owner_mid).toBeNull();
      expect(row.resolved_at).toBeNull();
    }
  });

  it('quarantined rows are physically invisible through the normal MessageCache API', () => {
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    // Nothing prevents a caller from mistakenly pointing MessageCache at the
    // quarantine file; the *schema* itself (no `messages` table) is the
    // guarantee that no rows are readable through the normal API.
    const cache = new MessageCache(active.quarantineDbPath);
    try {
      expect(cache.getMessages(OWNER, 'c1')).toEqual([]);
      expect(cache.getMessages(OWNER, 'c2')).toEqual([]);
      expect(cache.getDistinctChatMids(OWNER)).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it('copies categories into the bank db with explicit ids preserved', () => {
    buildFixture('single-valid-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    const db = new Database(active.bankDbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, name, pattern FROM categories ORDER BY id ASC').all();
      expect(rows).toEqual([
        { id: 1, name: 'groceries', pattern: 'Store' },
        { id: 2, name: 'transport', pattern: 'Taxi' },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('persistence-migration: corrupt legacy source', () => {
  let dataRoot: string;

  beforeEach(() => { dataRoot = mkdtemp(); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  it('throws instead of guessing, and leaves the corrupt file untouched with no pointer published', () => {
    const dbPath = path.join(dataRoot, 'cache', 'messages.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a sqlite database file at all');
    const hashBefore = hashFile(dbPath);

    expect(() => bootstrapPersistence({ dataRoot })).toThrow();

    expect(hashFile(dbPath)).toBe(hashBefore);
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);
    const gensDir = path.join(dataRoot, 'persistence-generations');
    expect(fs.existsSync(gensDir) ? fs.readdirSync(gensDir) : []).toEqual([]);
  });
});

// ─── Interruption + pointer-authority matrix (Step 2) ────────────────────────

describe('persistence-migration: interruption and pointer authority', () => {
  let dataRoot: string;

  beforeEach(() => { dataRoot = mkdtemp(); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  const failPoints: FailPoint[] = [
    'after-line',
    'after-bank',
    'after-quarantine',
    'after-validation',
    'before-pointer-rename',
    'after-pointer-rename',
  ];

  const pointerCommittedAt: Record<FailPoint, boolean> = {
    'after-line': false,
    'after-bank': false,
    'after-quarantine': false,
    'after-validation': false,
    'before-pointer-rename': false,
    'after-pointer-rename': true,
  };

  function generationsOnDisk(root: string): string[] {
    const dir = path.join(root, 'persistence-generations');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  function pointerGeneration(root: string): string | null {
    const file = path.join(root, 'persistence-current.json');
    if (!fs.existsSync(file)) return null;
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { generation: string }).generation;
  }

  for (const failAt of failPoints) {
    it(`recovers deterministically from a crash injected at "${failAt}"`, () => {
      buildFixture('single-valid-auth', dataRoot);
      const dbPath = path.join(dataRoot, 'cache', 'messages.db');
      const sourceHashBefore = hashFile(dbPath);

      // 1. Simulate the crash: bootstrapPersistence throws at the injection point.
      expect(() => bootstrapPersistence({ dataRoot, failAt })).toThrow();

      const pointerWasPublished = pointerCommittedAt[failAt];
      expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(pointerWasPublished);

      // "No normal store can open a staging generation": the only public way
      // to discover which generation is active is the pointer file — before
      // publication it does not exist, so nothing can name the interrupted
      // generation as authoritative.
      const interruptedGeneration = pointerWasPublished
        ? pointerGeneration(dataRoot)!
        : (() => {
            const onDisk = generationsOnDisk(dataRoot);
            expect(onDisk).toHaveLength(1); // exactly the interrupted staging generation
            return onDisk[0];
          })();

      expect(hashFile(dbPath)).toBe(sourceHashBefore); // never mutated by staging or the crash

      // 2. Restart: call bootstrapPersistence again with no failAt.
      const restart: { active: ActivePersistence } = { active: bootstrapPersistence({ dataRoot }) };

      expect(restart.active.generation).toBe(
        pointerWasPublished ? interruptedGeneration : restart.active.generation,
      );
      if (pointerWasPublished) {
        // Crash after publication converges on the named generation.
        expect(restart.active.generation).toBe(interruptedGeneration);
      } else {
        // Crash before publication: the interrupted staging generation is
        // discarded and rebuilt fresh, never silently adopted.
        expect(restart.active.generation).not.toBe(interruptedGeneration);
        expect(generationsOnDisk(dataRoot)).toEqual([restart.active.generation]);
      }

      expect(hashFile(dbPath)).toBe(sourceHashBefore);

      // Whichever generation ends up active, it must be fully valid and readable.
      const report = readReport(restart.active.reportPath);
      expect(report.ownerMid).toBe(OWNER);
      expect(report.counts.attributedMessages).toBe(2);
      const cache = new MessageCache(restart.active.lineDbPath);
      try {
        expect(cache.getMessages(OWNER, 'c1').map(m => m.id)).toEqual(['m1']);
      } finally {
        cache.close();
      }
    });
  }

  it('a steady-state restart after publication never re-reads the legacy source', () => {
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });

    // Corrupt/remove the legacy source now that the pointer is committed —
    // per the plan, the legacy db is a pre-cutover recovery snapshot only
    // and must never be consulted again once a generation is active.
    fs.rmSync(path.join(dataRoot, 'cache', 'messages.db'));

    const second = bootstrapPersistence({ dataRoot });
    expect(second.generation).toBe(first.generation);
    expect(second).toEqual(first);
  });

  it('rejects a pointer naming a path-traversal generation id rather than escaping dataRoot', () => {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, 'persistence-current.json'),
      JSON.stringify({ generation: '../../../etc', publishedAt: new Date().toISOString() }),
    );

    // An unsafe pointer must be treated as "no pointer" (never trusted), so
    // bootstrapPersistence proceeds to build a fresh, safely-scoped generation
    // instead of throwing or resolving outside dataRoot.
    const active = bootstrapPersistence({ dataRoot });
    expect(active.lineDbPath.startsWith(path.resolve(dataRoot) + path.sep)).toBe(true);
    expect(active.bankDbPath.startsWith(path.resolve(dataRoot) + path.sep)).toBe(true);
    expect(active.quarantineDbPath.startsWith(path.resolve(dataRoot) + path.sep)).toBe(true);
  });
});

// ─── Quarantine recovery (Task 3, Step 1) ────────────────────────────────────

describe('persistence-migration: quarantine recovery', () => {
  let dataRoot: string;

  beforeEach(() => { dataRoot = mkdtemp(); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  it('recovers a fully-mapped quarantine set, marking every row resolved (full)', () => {
    buildFixture('zero-auth', dataRoot); // c1/m1, c2/m2 quarantined; no auth candidates yet
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER); // operator's account is registered after the fact

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': OWNER, 'c2/m2': OWNER },
    });

    expect(result).toEqual({ recovered: 2, unresolved: 0, conflicts: 0 });

    const cache = new MessageCache(active.lineDbPath);
    try {
      expect(cache.getMessages(OWNER, 'c1')).toHaveLength(1);
      expect(cache.getMessages(OWNER, 'c2')).toHaveLength(1);
    } finally {
      cache.close();
    }
    expect(quarantineRows(active.quarantineDbPath)).toHaveLength(0);
  });

  it('recovers a partial mapping, leaving the unmapped row quarantined (partial)', () => {
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER);

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': OWNER },
    });

    expect(result).toEqual({ recovered: 1, unresolved: 1, conflicts: 0 });

    const cache = new MessageCache(active.lineDbPath);
    try {
      expect(cache.getMessages(OWNER, 'c1')).toHaveLength(1);
    } finally {
      cache.close();
    }
    const remaining = quarantineRows(active.quarantineDbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source_key).toBe('c2/m2');
    expect(remaining[0].resolution_owner_mid).toBeNull();
    expect(remaining[0].resolved_at).toBeNull();

    // The resolved row itself is retained (updated in place), not deleted —
    // proven by a raw, unfiltered query for its exact source_key.
    const resolvedRow = rawQuarantineRow(active.quarantineDbPath, 'c1/m1');
    expect(resolvedRow).toBeTruthy();
    expect(resolvedRow!.resolution_owner_mid).toBe(OWNER);
    expect(typeof resolvedRow!.resolved_at).toBe('string');
    expect(Number.isFinite(new Date(resolvedRow!.resolved_at as string).getTime())).toBe(true);
  });

  it('refuses a mapping to an owner mid with no stored auth record (invalid-MID)', () => {
    buildFixture('zero-auth', dataRoot); // deliberately no auth records at all
    const active = bootstrapPersistence({ dataRoot });

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': 'unknown-mid-with-no-record' },
    });

    expect(result).toEqual({ recovered: 0, unresolved: 2, conflicts: 0 });

    const cache = new MessageCache(active.lineDbPath);
    try {
      // Never silently creates a new owner out of an unvalidated mapping.
      expect(cache.getMessages('unknown-mid-with-no-record', 'c1')).toEqual([]);
    } finally {
      cache.close();
    }
    expect(quarantineRows(active.quarantineDbPath)).toHaveLength(2);
  });

  it('retains a conflicting-row mapping for audit instead of overwriting (conflicting-row)', () => {
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER);

    // Simulate the owner having independently re-synced this exact message
    // under the new owner-scoped schema after cutover, before recovery ran.
    const preseed = new MessageCache(active.lineDbPath);
    preseed.upsertMessages(OWNER, 'c1', [{
      id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '9999',
      contentType: 0, hasContent: false, text: 'already synced independently',
    }]);
    preseed.close();

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': OWNER, 'c2/m2': OWNER },
    });

    expect(result).toEqual({ recovered: 1, unresolved: 0, conflicts: 1 });

    const cache = new MessageCache(active.lineDbPath);
    try {
      const c1Messages = cache.getMessages(OWNER, 'c1');
      expect(c1Messages).toHaveLength(1);
      expect(c1Messages[0].text).toBe('already synced independently'); // untouched, not overwritten
      expect(cache.getMessages(OWNER, 'c2')).toHaveLength(1); // the non-conflicting row still recovered
    } finally {
      cache.close();
    }

    const remaining = quarantineRows(active.quarantineDbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source_key).toBe('c1/m1');
    expect(remaining[0].resolution_owner_mid).toBeNull(); // conflict never marked resolved
  });

  it('accumulates recovery counts in the report across multiple calls', () => {
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER);

    recoverQuarantinedMessages(active, { messages: { 'c1/m1': OWNER } });
    recoverQuarantinedMessages(active, { messages: { 'c2/m2': OWNER } });

    const report = readReport(active.reportPath);
    expect(report.recovery?.recoveredTotal).toBe(2);
    expect(report.recovery?.conflictsTotal).toBe(0);
    expect(typeof report.recovery?.lastRunAt).toBe('string');
    expect(Number.isFinite(new Date(report.recovery!.lastRunAt).getTime())).toBe(true);
  });

  it('leaves rows with no mapping entry at all untouched and unresolved', () => {
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER);

    const result = recoverQuarantinedMessages(active, { messages: {} });

    expect(result).toEqual({ recovered: 0, unresolved: 2, conflicts: 0 });
    expect(quarantineRows(active.quarantineDbPath)).toHaveLength(2);
  });
});

// ─── Generation path resolution safety ────────────────────────────────────────

describe('resolveGenerationPaths', () => {
  it('resolves all paths beneath dataRoot for a well-formed generation id', () => {
    const dataRoot = mkdtemp();
    try {
      const active = resolveGenerationPaths(dataRoot, 'gen-abc123-def456');
      const root = path.resolve(dataRoot) + path.sep;
      expect(active.lineDbPath.startsWith(root)).toBe(true);
      expect(active.bankDbPath.startsWith(root)).toBe(true);
      expect(active.quarantineDbPath.startsWith(root)).toBe(true);
      expect(active.reportPath.startsWith(root)).toBe(true);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects generation ids containing path separators or traversal segments', () => {
    const dataRoot = mkdtemp();
    try {
      expect(() => resolveGenerationPaths(dataRoot, '../escape')).toThrow();
      expect(() => resolveGenerationPaths(dataRoot, 'a/b')).toThrow();
      expect(() => resolveGenerationPaths(dataRoot, '/etc/passwd')).toThrow();
      expect(() => resolveGenerationPaths(dataRoot, '')).toThrow();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

// ─── Count validation guard ───────────────────────────────────────────────────

describe('validateMigrationCounts', () => {
  it('accepts counts where attributed+quarantined equal source and categories match', () => {
    expect(() => validateMigrationCounts({
      sourceMessages: 3, attributedMessages: 2, quarantinedMessages: 1,
      sourceCategories: 1, copiedCategories: 1,
    })).not.toThrow();
  });

  it('refuses when attributed+quarantined does not equal source messages', () => {
    expect(() => validateMigrationCounts({
      sourceMessages: 3, attributedMessages: 1, quarantinedMessages: 1,
      sourceCategories: 0, copiedCategories: 0,
    })).toThrow(/attributedMessages/);
  });

  it('refuses when copied categories does not equal source categories', () => {
    expect(() => validateMigrationCounts({
      sourceMessages: 0, attributedMessages: 0, quarantinedMessages: 0,
      sourceCategories: 2, copiedCategories: 1,
    })).toThrow(/copiedCategories/);
  });
});

// ─── Pointer file mechanics ────────────────────────────────────────────────────

describe('persistence-migration: pointer file mechanics', () => {
  let dataRoot: string;

  beforeEach(() => { dataRoot = mkdtemp(); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  it('publishes persistence-current.json with mode 0600', () => {
    buildFixture('fresh-root', dataRoot);
    bootstrapPersistence({ dataRoot });
    const file = path.join(dataRoot, 'persistence-current.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves no stray temp files behind after a successful publish', () => {
    buildFixture('single-valid-auth', dataRoot);
    bootstrapPersistence({ dataRoot });
    const entries = fs.readdirSync(dataRoot);
    expect(entries.some(name => name.includes('.tmp'))).toBe(false);
  });
});
