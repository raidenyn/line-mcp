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
  __setFsOps,
  type ActivePersistence,
  type FailPoint,
  type MigrationReport,
} from './persistence-migration';
import { SqliteMessageCache } from '@raidenyn/line-client-sqlite';

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

// ─── Injectable fs-ops recording seam ─────────────────────────────────────────

// A recording wrapper around the production fsOps seam. Each call is recorded
// as an ordered event with full path context (fd→path resolved for fsync).
// The wrapper delegates to the real fs via the module's default realFsOps,
// so durability is actually performed — the recorded events prove the real
// fsync ran in the required order. An optional `inject` partial lets tests
// override individual ops (e.g. throw EIO on fsync for a specific path).
interface RecordedEvent {
  op: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  fd?: number;
}

function eioError(msg = 'EIO'): Error & { code: string } {
  return Object.assign(new Error(msg), { code: 'EIO' });
}

function recordingFsOps(inject?: {
  fsyncSync?: (fd: number, path: string) => void;
  openSync?: (path: string, flags: string, mode?: number) => number;
}): { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const fdToPath = new Map<number, string>();
  // Delegate to the real fs directly (not via the module's fsOps, which may
  // be the recording wrapper itself during the test).
  const realOpen = (p: string, f: string, m?: number) =>
    m !== undefined ? fs.openSync(p, f, m) : fs.openSync(p, f);
  const realFsync = (fd: number) => fs.fsyncSync(fd);
  const realClose = (fd: number) => fs.closeSync(fd);
  const realWrite = (fd: number, d: string) => fs.writeSync(fd, d);
  const realRename = (o: string, n: string) => fs.renameSync(o, n);
  const wrapper: Record<string, unknown> = {
    openSync: (p: string, f: string, m?: number) => {
      let fd: number;
      if (inject?.openSync) {
        fd = inject.openSync(p, f, m);
      } else {
        fd = realOpen(p, f, m);
      }
      fdToPath.set(fd, p);
      events.push({ op: 'openSync', path: p, fd });
      return fd;
    },
    writeSync: (fd: number, d: string) => {
      events.push({ op: 'writeSync', path: fdToPath.get(fd), fd });
      realWrite(fd, d);
    },
    fsyncSync: (fd: number) => {
      const p = fdToPath.get(fd);
      events.push({ op: 'fsyncSync', path: p, fd });
      if (inject?.fsyncSync) {
        inject.fsyncSync(fd, p ?? '');
      } else {
        realFsync(fd);
      }
    },
    closeSync: (fd: number) => {
      events.push({ op: 'closeSync', path: fdToPath.get(fd), fd });
      realClose(fd);
      fdToPath.delete(fd);
    },
    renameSync: (o: string, n: string) => {
      events.push({ op: 'renameSync', oldPath: o, newPath: n });
      realRename(o, n);
    },
  };
  __setFsOps(wrapper);
  return { events };
}

// Find the index of the first event matching a predicate.
function indexOfEvent(events: RecordedEvent[], pred: (e: RecordedEvent) => boolean): number {
  return events.findIndex(pred);
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
    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
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
    const cache = new SqliteMessageCache({ dbPath: active.quarantineDbPath });
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
  afterEach(() => {
    // Reset the injectable fs-ops seam to real fs so no wrapper leaks between
    // tests. Tests that install a recording/injecting wrapper do so via
    // __setFsOps; this restore happens before the permission walk below so
    // the wrapper (which delegates to real fs anyway) does not interfere.
    __setFsOps(null);
    // Restore permissions before rmSync — tests in this block may chmod
    // files/dirs to 0000 to simulate EACCES, and rmSync(force) can fail to
    // traverse a 0000 directory. Walk the tree and restore 0755 on any
    // directory that might have been locked down.
    try { fs.chmodSync(dataRoot, 0o755); } catch { /* may already be gone */ }
    function restoreWalk(dir: string) {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const p = path.join(dir, name);
        try { fs.chmodSync(p, 0o755); } catch { /* best-effort */ }
        try { if (fs.statSync(p).isDirectory()) restoreWalk(p); } catch { /* best-effort */ }
      }
    }
    restoreWalk(dataRoot);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const failPoints: FailPoint[] = [
    'after-line',
    'after-bank',
    'after-quarantine',
    'after-validation',
    'before-marker-write',
    'after-marker-write',
    'after-marker-fsync',
    'after-generation-dir-fsync',
    'before-pointer-rename',
    'after-pointer-rename',
  ];

  const pointerCommittedAt: Record<FailPoint, boolean> = {
    'after-line': false,
    'after-bank': false,
    'after-quarantine': false,
    'after-validation': false,
    'before-marker-write': false,
    'after-marker-write': false,
    'after-marker-fsync': false,
    'after-generation-dir-fsync': false,
    'before-pointer-rename': false,
    'after-pointer-rename': true,
  };

  // With the publication marker written BEFORE the pointer rename (see
  // publishPointer), crash points that fire AFTER the marker file is
  // opened leave a marked generation with no pointer — bootstrap must FAIL
  // CLOSED rather than discard the marked generation or publish a
  // divergent active one alongside it. `before-marker-write` fires before
  // the marker is opened, so the generation is genuinely unmarked staging
  // and follows the discard-and-rebuild-fresh path (same as the staging
  // crash points after-line/bank/quarantine/validation).
  const markedButNotCommitted: Record<FailPoint, boolean> = {
    'after-line': false,
    'after-bank': false,
    'after-quarantine': false,
    'after-validation': false,
    'before-marker-write': false,
    'after-marker-write': true,
    'after-marker-fsync': true,
    'after-generation-dir-fsync': true,
    'before-pointer-rename': true,
    'after-pointer-rename': false,
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
      const markedWithoutPointer = markedButNotCommitted[failAt];
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

      if (markedWithoutPointer) {
        // Crash at 'before-pointer-rename' after the marker was written but
        // before the pointer rename: bootstrap must FAIL CLOSED rather than
        // discard the marked generation or publish a divergent active one
        // alongside it. The orphaned marked generation stays on disk for
        // forensic recovery; the operator must either restore a valid
        // pointer naming it (now impossible — the pointer file was never
        // written) or manually evacuate the marked generation before
        // re-bootstrap. There is no automatic recovery path.
        expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);
        // The orphaned marked generation and the legacy source are intact.
        expect(generationsOnDisk(dataRoot)).toEqual([interruptedGeneration]);
        expect(fs.existsSync(path.join(
          dataRoot, 'persistence-generations', interruptedGeneration, '.published',
        ))).toBe(true);
        expect(hashFile(dbPath)).toBe(sourceHashBefore);
        // Manually evacuate the orphaned marked generation (operator action
        // the throw's recovery hint documents) so a subsequent bootstrap can
        // proceed from the still-present legacy source.
        fs.rmSync(path.join(dataRoot, 'persistence-generations', interruptedGeneration), { recursive: true, force: true });
      }

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
      const cache = new SqliteMessageCache({ dbPath: restart.active.lineDbPath });
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

  it('rejects a committed generation with a missing required DB rather than fabricating an empty one', () => {
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.existsSync(first.bankDbPath)).toBe(true);
    expect(fs.existsSync(first.quarantineDbPath)).toBe(true);
    expect(fs.existsSync(first.reportPath)).toBe(true);

    // Damage the committed generation: delete the line DB. The pointer still
    // names this generation, so without the artifact check the composed
    // server's SqliteMessageCache would fabricate a brand-new empty line DB
    // inside the generation, silently hiding the two attributed messages.
    fs.rmSync(first.lineDbPath);

    // Re-bootstrap must NOT silently adopt the damaged generation. It throws
    // with a diagnostic naming the missing artifact, rather than fabricating
    // an empty DB over the missing slot. The throw must NOT recommend
    // deleting the pointer as recovery — that would route the next bootstrap
    // through discardUnpublishedGenerations and recursively delete the
    // surviving committed generation (see the marker-protection test below).
    const err = (() => { try { bootstrapPersistence({ dataRoot }); throw null; } catch (e) { return e as Error; } })();
    expect(String(err.message)).toMatch(/missing/);
    expect(String(err.message)).toContain(first.lineDbPath);
    expect(String(err.message)).not.toMatch(/remove the pointer file to re-bootstrap fresh/);
    expect(String(err.message)).toMatch(/Do NOT delete the pointer file/);

    // The missing DB must NOT have been silently recreated by a re-bootstrap
    // attempt (no fabrication side effect), and the other artifacts are
    // untouched — the operator can still repair by restoring the file.
    expect(fs.existsSync(first.lineDbPath)).toBe(false);
    expect(fs.existsSync(first.bankDbPath)).toBe(true);
    expect(fs.existsSync(first.quarantineDbPath)).toBe(true);
  });

  it('a committed generation whose pointer is later removed is NOT discardable — bootstrap fails closed, no divergent active generation', () => {
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });
    // Sanity: first boot wrote the publication marker inside its generation.
    // reportPath = <root>/persistence-generations/<gen>/migration-report.json,
    // so the generation directory is its parent.
    const generationDir = path.dirname(first.reportPath);
    const markerPath = path.join(generationDir, '.published');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Add a post-migration message to the surviving line DB, the canonical
    // "data the throw is protecting" scenario from the follow-up review.
    const cache = new SqliteMessageCache({ dbPath: first.lineDbPath });
    try {
      cache.upsertMessages(OWNER, 'cPostMigration', [{ id: 'mPost', createdTime: 9999 } as never]);
    } finally {
      cache.close();
    }

    // Simulate the destructive scenario from the reviewer's pushback: damage
    // one artifact (the quarantine DB) AND remove the pointer. readPointer
    // can no longer establish authority (the pointer is gone), so bootstrap
    // reaches the fail-closed branch and refuses — neither discarding the
    // marked committed generation nor publishing a divergent active
    // generation alongside it. The throw names the preserved generation and
    // documents that the operator must restore a valid pointer or manually
    // evacuate the orphaned marked generation before re-bootstrap.
    fs.rmSync(first.quarantineDbPath);
    fs.rmSync(path.join(dataRoot, 'persistence-current.json'));

    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);
    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(path.basename(generationDir));

    // The damaged committed generation SURVIVES on disk: its line DB is
    // intact and the post-migration message is still readable, exactly the
    // data the missing-artifact throw and the fail-closed branch both exist
    // to protect. No divergent fresh generation was published and made
    // active; the only generations on disk are the original (preserved)
    // one — so the operator can repair the pointer (or evacuate) deliberately.
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    const forensic = new SqliteMessageCache({ dbPath: first.lineDbPath });
    try {
      expect(forensic.getMessages(OWNER, 'c1').map((m) => m.id)).toEqual(['m1']);
      expect(forensic.getMessages(OWNER, 'cPostMigration').map((m) => m.id)).toEqual(['mPost']);
    } finally {
      forensic.close();
    }
    // No fresh generation was published alongside the preserved one.
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations')))
      .toEqual([path.basename(generationDir)]);
  });

  it('a committed generation whose pointer is missing but is itself intact is re-authorizable by restoring the pointer', () => {
    // Distinguish the "operator can recover" path from the destructive
    // scenario above: if the committed generation is fully intact and only
    // the pointer was lost, the operator can restore the pointer manually
    // and bootstrap re-authorizes that same generation (no divergence, no
    // data loss). This is the recovery path the fail-closed throw's hint
    // documents.
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });

    // Pointer lost (e.g. an errant `rm` against persistence-current.json).
    fs.rmSync(path.join(dataRoot, 'persistence-current.json'));

    // bootstrap fails closed: a published generation exists but no pointer
    // can establish authority for it.
    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);

    // Operator restores a valid pointer naming the preserved generation.
    // All required artifacts of that generation are still on disk, so
    // readPointer re-authorizes it and bootstrap returns the SAME generation.
    fs.writeFileSync(
      path.join(dataRoot, 'persistence-current.json'),
      JSON.stringify({ generation: first.generation, publishedAt: new Date().toISOString() }),
    );
    const restored = bootstrapPersistence({ dataRoot });
    expect(restored).toEqual(first);
  });

  it('durably persists the publication marker before pointer rename', () => {
    // The marker-before-rename ordering invariant: a crash injected at
    // 'before-pointer-rename' (which fires AFTER the marker write but
    // BEFORE the pointer rename) must leave a non-empty, readable marker
    // file on disk with no pointer file. This is the behavioral proxy for
    // "the marker is durably persisted before the pointer is committed":
    // if the marker write had not completed (no fsync, or write ordered
    // after the rename), the crash would leave either no marker or a
    // pointer file alongside it — both violating the invariant.
    //
    // In addition to the behavioral proxy, we record the ordered durability
    // events via the injectable fs-ops seam and assert the fsync ordering
    // explicitly through the ACTUAL fs calls: the pointer tmp fsync precedes
    // the marker open, the marker fsync precedes the generation-directory
    // fsync, and both precede the pointer rename. Because the recording
    // wrapper delegates to the real fs (real fsync actually runs), removing
    // or reordering any load-bearing fsync would either drop the
    // corresponding event or invert the recorded order, regressing the
    // assertions below.
    const { events } = recordingFsOps();
    try {
      buildFixture('single-valid-auth', dataRoot);
      expect(() => bootstrapPersistence({ dataRoot, failAt: 'before-pointer-rename' })).toThrow();
    } finally {
      __setFsOps(null);
    }

    const gensRoot = path.join(dataRoot, 'persistence-generations');
    const onDisk = fs.readdirSync(gensRoot);
    expect(onDisk).toHaveLength(1);
    const gen = onDisk[0];

    // Marker is on disk and non-empty → the write completed and was
    // persisted before the rename that never happened.
    const markerPath = path.join(gensRoot, gen, '.published');
    expect(fs.existsSync(markerPath)).toBe(true);
    const markerContent = fs.readFileSync(markerPath, 'utf8');
    expect(markerContent.length).toBeGreaterThan(0);

    // Pointer does NOT exist → the rename hasn't happened, so the marker
    // was written strictly before any pointer commitment.
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);

    // The marker's parent (the generation directory) must also be durable
    // before the rename — observable here as the marker directory entry
    // itself being present on disk (the dir fsync's effect is what made the
    // marker entry visible post-crash).
    expect(fs.existsSync(path.join(gensRoot, gen))).toBe(true);

    // Ordered durability assertions via the recording seam. The crash fires
    // at 'before-pointer-rename', so no renameSync event must be present;
    // every preceding fsync must have been recorded against its real path
    // in the required order. Because the wrapper records the actual fs
    // operations (not synthetic labels), commenting out a real fsOps.fsyncSync
    // call in publishPointer would drop the corresponding fsyncSync event
    // and regress these assertions.
    const pointerTmpFsync = indexOfEvent(events, e =>
      e.op === 'fsyncSync' && typeof e.path === 'string' && e.path.includes('.persistence-current.') && e.path.endsWith('.tmp'));
    const markerOpen = indexOfEvent(events, e =>
      e.op === 'openSync' && typeof e.path === 'string' && e.path.endsWith('.published'));
    const markerFsync = indexOfEvent(events, e =>
      e.op === 'fsyncSync' && typeof e.path === 'string' && e.path.endsWith('.published'));
    const dirFsync = indexOfEvent(events, e =>
      e.op === 'fsyncSync' && typeof e.path === 'string' && e.path === path.join(gensRoot, gen));
    const renameIdx = indexOfEvent(events, e =>
      e.op === 'renameSync' && typeof e.newPath === 'string' && e.newPath.endsWith('persistence-current.json'));

    expect(pointerTmpFsync).toBeGreaterThanOrEqual(0);
    expect(markerOpen).toBeGreaterThanOrEqual(0);
    expect(markerFsync).toBeGreaterThanOrEqual(0);
    expect(dirFsync).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBe(-1); // crash fired before the rename

    // Strict ordering: pointer tmp fsync before marker open, marker fsync
    // before generation-dir fsync, both before any pointer rename.
    expect(pointerTmpFsync).toBeLessThan(markerOpen);
    expect(markerFsync).toBeLessThan(dirFsync);
    // No rename event exists, so all fsyncs precede the (absent) rename.
    expect(dirFsync).toBeLessThan(events.length);
  });

  it('repairs a missing marker for an authoritative pointer without changing generations', () => {
    // A valid pointer with all four required artifacts intact but a missing
    // `.published` marker is the "self-repair" path: readPointer must
    // durably recreate the marker before returning the generation, rather
    // than accepting an unmarked committed generation (which later pointer
    // loss would let discard silently delete).
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });
    const generationDir = path.dirname(first.reportPath);
    const markerPath = path.join(generationDir, '.published');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Simulate the marker being lost (e.g. a partial power loss that
    // preserved the pointer but not the marker's directory entry).
    fs.rmSync(markerPath);
    expect(fs.existsSync(markerPath)).toBe(false);

    // Record the durability events fired by the repair path so we can
    // assert the repair's fsync ordering explicitly through the ACTUAL fs
    // calls (marker fsync before generation-dir fsync). Because the
    // recording wrapper delegates to the real fs, removing the load-bearing
    // fsyncs in ensureDurablePublicationMarker would drop these events and
    // regress the assertions.
    const { events: repairEvents } = recordingFsOps();
    let second: ActivePersistence;
    try {
      // Bootstrap with a valid pointer and all artifacts intact must RETURN
      // THE SAME generation (no divergence) AND durably repair the marker.
      second = bootstrapPersistence({ dataRoot });
    } finally {
      __setFsOps(null);
    }
    expect(second).toEqual(first);
    expect(fs.existsSync(markerPath)).toBe(true);
    const repairedContent = fs.readFileSync(markerPath, 'utf8');
    expect(repairedContent.length).toBeGreaterThan(0);

    // The repair path durably fsynced the marker file and then the
    // generation directory before re-authorizing the generation. Assert via
    // the real fs call recording — not synthetic labels.
    const repairMarkerFsync = indexOfEvent(repairEvents, e =>
      e.op === 'fsyncSync' && typeof e.path === 'string' && e.path.endsWith('.published'));
    const repairDirFsync = indexOfEvent(repairEvents, e =>
      e.op === 'fsyncSync' && typeof e.path === 'string' && e.path === generationDir);
    expect(repairMarkerFsync).toBeGreaterThanOrEqual(0);
    expect(repairDirFsync).toBeGreaterThanOrEqual(0);
    expect(repairMarkerFsync).toBeLessThan(repairDirFsync);

    // Now verify the repair is load-bearing: remove the pointer and assert
    // bootstrap fails closed on the REPAIRED marker rather than discarding
    // or replacing the generation (the exact scenario the unmarked-commit
    // gap previously allowed).
    fs.rmSync(path.join(dataRoot, 'persistence-current.json'));
    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);
    // The generation is preserved on disk (marker protection).
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations')))
      .toEqual([first.generation]);
  });

  it('rejects a non-file marker (directory or symlink) rather than classifying as absent', () => {
    // The data-loss bug safeMarkerExists guards against: if a committed
    // generation's `.published` marker is replaced with a directory or a
    // (possibly dangling) symlink, the old statSync-based implementation
    // followed the link and returned isFile() === false, classifying the
    // marker as "absent". discardUnpublishedGenerations would then delete
    // the committed generation and bootstrap would publish a divergent one,
    // silently losing the persisted messages in the committed generation's
    // line DB. The lstatSync-based fix throws for any non-regular-file
    // entry (directory, symlink, special file) so a damaged data root
    // surfaces for operator inspection instead of being silently discarded.
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });
    const generationDir = path.dirname(first.reportPath);
    const markerPath = path.join(generationDir, '.published');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Add a post-migration message — the canonical data the throw protects.
    const cache = new SqliteMessageCache({ dbPath: first.lineDbPath });
    try {
      cache.upsertMessages(OWNER, 'cProtected', [{ id: 'mProtected', createdTime: 9999 } as never]);
    } finally {
      cache.close();
    }

    // Subtest A: replace the marker with a directory and remove the pointer.
    // bootstrap must throw (fail closed) rather than delete the generation
    // or publish a divergent active one.
    fs.rmSync(markerPath);
    fs.mkdirSync(markerPath);
    fs.rmSync(path.join(dataRoot, 'persistence-current.json'));
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();
    // The committed generation SURVIVES — nothing was deleted.
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations')))
      .toEqual([first.generation]);
    // No divergent generation was published.
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);

    // Reset the marker to a valid file so subtest B starts clean.
    fs.rmSync(markerPath, { recursive: true, force: true });
    fs.writeFileSync(markerPath, new Date().toISOString());

    // Subtest B: replace the marker with a (dangling) symlink and remove the
    // pointer. lstatSync on a dangling symlink does NOT throw — it returns a
    // symlink stat — so the isFile() check must convert that to a throw
    // rather than treating the marker as absent.
    fs.rmSync(markerPath);
    fs.symlinkSync(path.join(generationDir, 'does-not-exist-target'), markerPath);
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations')))
      .toEqual([first.generation]);
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);

    // Subtest C: a symlink that points at a regular file is still rejected
    // (it is not itself a regular file via lstat). This blocks an attacker
    // who replaces the marker with a symlink to an unrelated file to bypass
    // the marker check.
    fs.rmSync(markerPath);
    const decoy = path.join(generationDir, 'decoy-target');
    fs.writeFileSync(decoy, 'decoy');
    fs.symlinkSync(decoy, markerPath);
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations')))
      .toEqual([first.generation]);
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);

    // The protected post-migration message is still readable throughout.
    const forensic = new SqliteMessageCache({ dbPath: first.lineDbPath });
    try {
      expect(forensic.getMessages(OWNER, 'cProtected').map((m) => m.id)).toEqual(['mProtected']);
    } finally {
      forensic.close();
    }
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

  // ─── Filesystem-error fail-closed (Task 2) ────────────────────────────────

  // Helper: set up a fully committed generation with a valid pointer, then
  // return the paths the caller will damage.
  function committedGeneration(dataRoot: string): ActivePersistence {
    buildFixture('single-valid-auth', dataRoot);
    return bootstrapPersistence({ dataRoot });
  }

  // Restores permissions on paths modified by the tests below. Runs in
  // afterEach AND inline before assertions that need to read the tree.
  function restorePerms(paths: string[]): void {
    for (const p of paths) {
      try { fs.chmodSync(p, 0o755); } catch { /* may not exist */ }
    }
  }

  it('fails closed on persistence filesystem errors: pointer read EACCES throws and publishes nothing', () => {
    const first = committedGeneration(dataRoot);
    const pointerFile = path.join(dataRoot, 'persistence-current.json');
    const gensBefore = fs.readdirSync(path.join(dataRoot, 'persistence-generations'));

    // Make the pointer file unreadable (EACCES on readFileSync).
    fs.chmodSync(pointerFile, 0o000);

    // Bootstrap must throw the EACCES error, NOT silently treat it as "no
    // pointer" (which would publish a divergent active generation).
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();

    // No new generation was published; the pointer is unchanged.
    restorePerms([pointerFile]);
    const gensAfter = fs.readdirSync(path.join(dataRoot, 'persistence-generations'));
    expect(gensAfter).toEqual(gensBefore);
    // The pointer still names the same generation.
    const ptr = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
    expect(ptr.generation).toBe(first.generation);
  });

  it('fails closed on persistence filesystem errors: generations-root readdir EACCES throws and preserves data', () => {
    const first = committedGeneration(dataRoot);
    const gensRoot = path.join(dataRoot, 'persistence-generations');
    const pointerFile = path.join(dataRoot, 'persistence-current.json');

    // Remove the pointer so bootstrap reaches discardUnpublishedGenerations.
    fs.rmSync(pointerFile);
    // Make the generations root non-listable (EACCES on readdirSync).
    fs.chmodSync(gensRoot, 0o000);

    // Bootstrap must throw the EACCES error, NOT silently return [] from
    // readdirSync (which would bypass the fail-closed check and publish a
    // divergent active generation alongside the preserved one).
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();

    // The marked generation is preserved on disk (nothing was deleted or
    // published). Restore perms to verify.
    restorePerms([gensRoot]);
    const gensAfter = fs.readdirSync(gensRoot);
    expect(gensAfter).toEqual([first.generation]);
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    // No new pointer was published.
    expect(fs.existsSync(pointerFile)).toBe(false);
  });

  it('fails closed on persistence filesystem errors: marker stat EACCES throws and leaves every generation untouched', () => {
    const first = committedGeneration(dataRoot);
    const gensRoot = path.join(dataRoot, 'persistence-generations');
    const genDir = path.join(gensRoot, first.generation);
    const pointerFile = path.join(dataRoot, 'persistence-current.json');

    // Remove the pointer so bootstrap reaches discardUnpublishedGenerations.
    fs.rmSync(pointerFile);
    // Make the marker's parent directory (the generation dir) inaccessible
    // so statSync on the marker throws EACCES.
    fs.chmodSync(genDir, 0o000);

    // Bootstrap must throw the EACCES error from safeMarkerExists's statSync,
    // NOT silently treat the marker as absent (which would let rmSync delete
    // the committed generation).
    expect(() => bootstrapPersistence({ dataRoot })).toThrow();

    // Nothing was deleted; the generation is intact.
    restorePerms([genDir]);
    expect(fs.existsSync(genDir)).toBe(true);
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.readdirSync(gensRoot)).toEqual([first.generation]);
  });

  it('ENOENT controls: a fresh root still bootstraps, and genuine unmarked staging is still discarded', () => {
    // Fresh root: no pointer, no generations tree at all → ENOENT from
    // readPointer's readFileSync AND from discardUnpublishedGenerations's
    // readdirSync. Both must treat ENOENT as "absent" and proceed normally.
    buildFixture('fresh-root', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    expect(active.generation).toMatch(/^gen-/);
    expect(fs.existsSync(active.lineDbPath)).toBe(true);

    // Genuine unmarked staging: bootstrap once with a crash before the
    // marker write (no pointer, no marker), then restart — the unmarked
    // staging is discarded and rebuilt fresh.
    fs.rmSync(path.join(dataRoot, 'persistence-current.json'));
    fs.rmSync(path.join(dataRoot, 'persistence-generations'), { recursive: true, force: true });
    buildFixture('single-valid-auth', dataRoot);
    expect(() => bootstrapPersistence({ dataRoot, failAt: 'before-marker-write' })).toThrow();
    const onDisk = fs.readdirSync(path.join(dataRoot, 'persistence-generations'));
    expect(onDisk).toHaveLength(1);
    expect(fs.existsSync(path.join(path.join(dataRoot, 'persistence-generations'), onDisk[0], '.published'))).toBe(false);
    const rebuilt = bootstrapPersistence({ dataRoot });
    expect(rebuilt.generation).not.toBe(onDisk[0]);
    expect(fs.readdirSync(path.join(dataRoot, 'persistence-generations'))).toEqual([rebuilt.generation]);
  });

  // ─── Deterministic EIO injection via the fs-ops seam ──────────────────────
  //
  // The crash failpoints (after-marker-fsync etc.) model a throw AFTER a
  // successful fsync — they do not exercise an fsync that itself throws EIO.
  // These tests inject EIO directly into the fsOps.fsyncSync used by
  // production code, asserting the durability invariant: an fsync failure
  // during the marker or generation-directory step aborts BEFORE the pointer
  // rename, so no pointer is committed and the generation is left as
  // unmarked staging. The repair path (readPointer) similarly throws rather
  // than re-authorizing the generation.

  it('EIO on marker fsync during publish aborts before pointer commit, preserving the legacy source', () => {
    buildFixture('single-valid-auth', dataRoot);
    const dbPath = path.join(dataRoot, 'cache', 'messages.db');
    const sourceHashBefore = hashFile(dbPath);

    // Track which fd corresponds to the marker file (opened with 'wx' and a
    // path ending in '.published') and throw EIO the first time fsyncSync is
    // called on it. Every other fsync (pointer tmp, generation dir) is left
    // intact so the failure is pinpointed to the marker fsync.
    let markerFired = false;
    recordingFsOps({
      fsyncSync: (fd, p) => {
        if (p.endsWith('.published') && !markerFired) {
          markerFired = true;
          throw eioError();
        }
        fs.fsyncSync(fd);
      },
    });
    try {
      expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/EIO/);
    } finally {
      __setFsOps(null);
    }

    // No pointer committed — the marker fsync threw before the rename.
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);
    // The staging generation is on disk (the line/bank/quarantine DBs were
    // staged before publishPointer was reached). The marker file's
    // directory entry was created by open('wx') before the fsync threw, so
    // it is visible on disk — but its CONTENT was not fsynced and the
    // generation-directory fsync never ran, so the marker is not durable.
    // From bootstrap's perspective this is a marked-but-uncommitted
    // orphan: the next bootstrap must FAIL CLOSED rather than discard or
    // diverge, exactly the invariant the marker-before-rename ordering
    // protects even when the marker fsync itself fails.
    const gensRoot = path.join(dataRoot, 'persistence-generations');
    const onDisk = fs.readdirSync(gensRoot);
    expect(onDisk).toHaveLength(1);
    expect(fs.existsSync(path.join(gensRoot, onDisk[0], '.published'))).toBe(true);
    // The legacy source is untouched.
    expect(hashFile(dbPath)).toBe(sourceHashBefore);

    // The marked-but-uncommitted generation makes the next bootstrap FAIL
    // CLOSED (refuses to discard or diverge).
    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);
    // Evacuate the orphan and restart fresh to clean up.
    fs.rmSync(path.join(gensRoot, onDisk[0]), { recursive: true, force: true });
    const active = bootstrapPersistence({ dataRoot });
    expect(active.generation).not.toBe(onDisk[0]);
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(true);
  });

  it('EIO on generation-directory fsync during publish aborts before pointer commit', () => {
    buildFixture('single-valid-auth', dataRoot);
    const dbPath = path.join(dataRoot, 'cache', 'messages.db');
    const sourceHashBefore = hashFile(dbPath);

    // The generation-directory fsync opens the generation directory with 'r'
    // (no mode) — distinguished from the marker file (opened 'wx', 0o600)
    // and the pointer tmp (opened 'wx', 0o600 with a .tmp suffix). Throw EIO
    // the first time fsyncSync is called on a path that is the generation
    // directory (i.e. opened with 'r' and not ending in .published or .tmp).
    let dirFired = false;
    recordingFsOps({
      fsyncSync: (fd, p) => {
        // The generation-directory fsync path is the generation directory
        // itself (no file extension, ends with the generation id segment).
        // The marker path ends in '.published'; the pointer tmp ends in
        // '.tmp'. Only the directory fsync has neither.
        if (
          !p.endsWith('.published') &&
          !p.endsWith('.tmp') &&
          !p.endsWith('persistence-current.json') &&
          !dirFired
        ) {
          dirFired = true;
          throw eioError();
        }
        fs.fsyncSync(fd);
      },
    });
    try {
      expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/EIO/);
    } finally {
      __setFsOps(null);
    }

    // No pointer committed — the directory fsync threw before the rename.
    expect(fs.existsSync(path.join(dataRoot, 'persistence-current.json'))).toBe(false);
    const gensRoot = path.join(dataRoot, 'persistence-generations');
    const onDisk = fs.readdirSync(gensRoot);
    expect(onDisk).toHaveLength(1);
    // The marker file WAS written and fsynced before the directory fsync
    // threw, so it is present on disk — but no pointer means the generation
    // is treated as a marked-but-uncommitted orphan on the next bootstrap.
    expect(fs.existsSync(path.join(gensRoot, onDisk[0], '.published'))).toBe(true);
    expect(hashFile(dbPath)).toBe(sourceHashBefore);

    // The marked-but-uncommitted generation makes the next bootstrap FAIL
    // CLOSED (refuses to discard or diverge) — exactly the invariant the
    // marker-before-rename ordering protects.
    expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/Refusing to bootstrap/);
    // Evacuate the orphan and restart fresh to clean up.
    fs.rmSync(path.join(gensRoot, onDisk[0]), { recursive: true, force: true });
    const active = bootstrapPersistence({ dataRoot });
    expect(active.generation).not.toBe(onDisk[0]);
  });

  it('EIO on marker fsync during readPointer repair does NOT re-authorize the generation', () => {
    // Set up a fully-committed, intact generation with a valid pointer.
    buildFixture('single-valid-auth', dataRoot);
    const first = bootstrapPersistence({ dataRoot });
    const generationDir = path.dirname(first.reportPath);
    const markerPath = path.join(generationDir, '.published');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Remove the marker so readPointer's repair path will try to recreate
    // (and fsync) it.
    fs.rmSync(markerPath);
    expect(fs.existsSync(markerPath)).toBe(false);

    // Inject EIO on the marker fsync inside ensureDurablePublicationMarker.
    // The repair path opens the marker with 'wx' (creating it) and fsyncs it;
    // that fsync must throw, and readPointer must propagate the throw rather
    // than return `active` (which would re-authorize the generation without
    // a durable marker).
    let markerFired = false;
    recordingFsOps({
      fsyncSync: (fd, p) => {
        if (p.endsWith('.published') && !markerFired) {
          markerFired = true;
          throw eioError();
        }
        fs.fsyncSync(fd);
      },
    });
    try {
      expect(() => bootstrapPersistence({ dataRoot })).toThrowError(/EIO/);
    } finally {
      __setFsOps(null);
    }

    // The pointer file is unchanged — the repair throw did NOT mutate it.
    const pointerFile = path.join(dataRoot, 'persistence-current.json');
    expect(fs.existsSync(pointerFile)).toBe(true);
    const ptr = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
    expect(ptr.generation).toBe(first.generation);

    // The generation is preserved on disk (the throw protected it from
    // being re-authorized without a durable marker). All artifacts are intact.
    expect(fs.existsSync(first.lineDbPath)).toBe(true);
    expect(fs.existsSync(first.bankDbPath)).toBe(true);
    expect(fs.existsSync(first.quarantineDbPath)).toBe(true);
    expect(fs.existsSync(first.reportPath)).toBe(true);

    // A subsequent bootstrap WITHOUT the injection succeeds and re-creates
    // the marker durably, re-authorizing the same generation.
    const restored = bootstrapPersistence({ dataRoot });
    expect(restored).toEqual(first);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8').length).toBeGreaterThan(0);
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

    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
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

    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
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

    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
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
    const preseed = new SqliteMessageCache({ dbPath: active.lineDbPath });
    preseed.upsertMessages(OWNER, 'c1', [{
      id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '9999',
      contentType: 0, hasContent: false, text: 'already synced independently',
    }]);
    preseed.close();

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': OWNER, 'c2/m2': OWNER },
    });

    expect(result).toEqual({ recovered: 1, unresolved: 0, conflicts: 1 });

    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
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

  it('idempotently completes an interrupted recovery (line-DB row present, quarantine still unresolved)', () => {
    // Simulate the crash window the reviewer flagged: a previous recovery
    // run inserted the row into the line DB but crashed before marking the
    // quarantined row resolved. On replay, the byte-identical existing line
    // row must be recognized as an interrupted recovery (recovered), NOT
    // permanently misclassified as a conflict — which is the silent failure
    // mode the fix targets.
    buildFixture('zero-auth', dataRoot);
    const active = bootstrapPersistence({ dataRoot });
    writeValidAuthRecord(dataRoot, OWNER);

    // Replay the exact staging bytes stageLineDb would have written for c1/m1
    // at createdTime 1000 (see buildLegacyDb's raw_json shape).
    const interruptedRaw = JSON.stringify({
      id: 'm1', from: 'c1', to: 'c1', toType: 1,
      createdTime: '1000', contentType: 0, hasContent: false, text: 'hi',
    });
    const preseed = new SqliteMessageCache({ dbPath: active.lineDbPath });
    try {
      preseed.upsertMessages(OWNER, 'c1', [{
        id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '1000',
        contentType: 0, hasContent: false, text: 'hi',
      }]);
    } finally {
      preseed.close();
    }

    const result = recoverQuarantinedMessages(active, {
      messages: { 'c1/m1': OWNER, 'c2/m2': OWNER },
    });

    // c1/m1: interrupted-recovery replay → recovered (not conflict).
    // c2/m2: normal recovery → recovered.
    expect(result).toEqual({ recovered: 2, unresolved: 0, conflicts: 0 });

    const cache = new SqliteMessageCache({ dbPath: active.lineDbPath });
    try {
      expect(cache.getMessages(OWNER, 'c1')).toHaveLength(1);
      expect(cache.getMessages(OWNER, 'c2')).toHaveLength(1);
    } finally {
      cache.close();
    }
    // The previously-unresolved c1/m1 quarantine row is now marked resolved
    // (rawQuarantineRow returns the row itself regardless of resolution state,
    // while quarantineRows filters to resolution_owner_mid IS NULL).
    expect(quarantineRows(active.quarantineDbPath)).toHaveLength(0);
    const c1Row = rawQuarantineRow(active.quarantineDbPath, 'c1/m1');
    expect(c1Row?.resolution_owner_mid).toBe(OWNER);
    // Sanity: the line-DB row's raw_json is byte-identical to what we staged —
    // if upsertMessages normalized it, this test would wrongly pass via conflict.
    const db = new Database(active.lineDbPath, { readonly: true });
    try {
      const row = db.prepare(
        'SELECT raw_json FROM messages WHERE owner_mid = ? AND chat_mid = ? AND message_id = ?',
      ).get(OWNER, 'c1', 'm1') as { raw_json: string } | undefined;
      expect(row?.raw_json).toBe(interruptedRaw);
    } finally {
      db.close();
    }
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
