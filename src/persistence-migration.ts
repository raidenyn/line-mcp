import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { cacheDbPath, authDir } from './data-dir';
import { inventoryStoredAuthRecords, type AuthRecordInventory } from './oauth';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ActivePersistence {
  generation: string;
  lineDbPath: string;
  bankDbPath: string;
  quarantineDbPath: string;
  reportPath: string;
}

export type FailPoint =
  | 'after-line'
  | 'after-bank'
  | 'after-quarantine'
  | 'after-validation'
  | 'before-pointer-rename'
  | 'after-pointer-rename';

export interface MigrationCounts {
  sourceMessages: number;
  attributedMessages: number;
  quarantinedMessages: number;
  sourceCategories: number;
  copiedCategories: number;
}

export interface RecoveryReportEntry {
  recoveredTotal: number;
  conflictsTotal: number;
  lastRunAt: string;
}

export interface MigrationReport {
  generation: string;
  createdAt: string;
  legacySourcePresent: boolean;
  ownerMid: string | null;
  quarantineReason: string | null;
  authCandidates: {
    validCount: number;
    invalidCount: number;
    invalidReasons: string[];
  };
  counts: MigrationCounts;
  // Populated only after recoverQuarantinedMessages() has run at least once
  // against this generation; absent on a freshly-published generation.
  recovery?: RecoveryReportEntry;
}

// ─── Quarantine recovery (explicit operator MID mapping only) ───────────────

export interface RecoveryMapping {
  // Keyed by the same audit-stable `chatMid/messageId` source_key stageQuarantineDb
  // writes; value is the owner mid an operator has determined the message
  // actually belongs to. Never inferred automatically — recovery only ever
  // acts on mappings the caller supplies explicitly.
  messages: Record<string, string>;
}

export interface RecoveryResult {
  recovered: number;
  unresolved: number;
  conflicts: number;
}

interface QuarantinedRow {
  source_key: string;
  chat_mid: string;
  message_id: string;
  created_time: number;
  raw_json: string;
}

// ActivePersistence never carries dataRoot directly (it's re-derived here
// rather than added as a field) so the interface stays what bootstrapPersistence
// has always returned; every generation path is a fixed descendant of dataRoot
// (see resolveGenerationPaths), so walking back up from reportPath is exact.
function deriveDataRoot(active: ActivePersistence): string {
  return path.dirname(path.dirname(path.dirname(active.reportPath)));
}

function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function updateReportWithRecovery(
  reportPath: string,
  delta: { recovered: number; conflicts: number },
): void {
  let report: MigrationReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as MigrationReport;
  } catch {
    return; // no report to update against — should not happen in practice
  }
  const prev = report.recovery ?? { recoveredTotal: 0, conflictsTotal: 0, lastRunAt: '' };
  report.recovery = {
    recoveredTotal: prev.recoveredTotal + delta.recovered,
    conflictsTotal: prev.conflictsTotal + delta.conflicts,
    lastRunAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

// Explicit-mapping recovery for rows quarantined by bootstrapPersistence.
// Never infers ownership — a row is only recovered when the caller's mapping
// names its exact source_key and the named owner mid has a valid stored auth
// record (validated fresh on every call, since accounts can be added between
// runs). Rows whose target would collide with an existing row already
// present in the active line DB are left exactly as they were and counted as
// `conflicts`, never overwritten. Resolved rows are updated in place
// (resolution_owner_mid/resolved_at set) and retained in legacy_messages for
// audit — nothing is ever deleted.
export function recoverQuarantinedMessages(
  active: ActivePersistence,
  mapping: RecoveryMapping,
): RecoveryResult {
  const dataRoot = deriveDataRoot(active);
  const validMids = new Set(
    inventoryStoredAuthRecords(authDir(dataRoot)).valid.map(v => v.mid),
  );

  const qdb = new Database(active.quarantineDbPath);
  const ldb = new Database(active.lineDbPath);

  let recovered = 0;
  let conflicts = 0;
  let total: number;

  try {
    const pendingRows = qdb.prepare(
      `SELECT source_key, chat_mid, message_id, created_time, raw_json
       FROM legacy_messages
       WHERE resolution_owner_mid IS NULL`,
    ).all() as QuarantinedRow[];
    total = pendingRows.length;

    const insertLine = ldb.prepare(
      'INSERT INTO messages (owner_mid, chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?, ?)',
    );
    const markResolved = qdb.prepare(
      'UPDATE legacy_messages SET resolution_owner_mid = ?, resolved_at = ? WHERE source_key = ?',
    );
    const nowIso = new Date().toISOString();

    for (const row of pendingRows) {
      const ownerMid = mapping.messages[row.source_key];
      if (!ownerMid) continue; // no mapping supplied for this row — stays unresolved

      if (!validMids.has(ownerMid)) continue; // no stored auth record for this mid — refuse, stays unresolved

      try {
        insertLine.run(ownerMid, row.chat_mid, row.message_id, row.created_time, row.raw_json);
      } catch (err) {
        if (!isConstraintViolation(err)) throw err;
        // A row already exists at (owner_mid, chat_mid, message_id) — never
        // overwrite; retain the quarantined row untouched for audit.
        conflicts++;
        continue;
      }

      markResolved.run(ownerMid, nowIso, row.source_key);
      recovered++;
    }
  } finally {
    qdb.close();
    ldb.close();
  }

  const unresolved = total - recovered - conflicts;
  updateReportWithRecovery(active.reportPath, { recovered, conflicts });

  return { recovered, unresolved, conflicts };
}

// ─── Path layout ──────────────────────────────────────────────────────────────

// Generation ids are internally generated (see makeGenerationId) and never
// taken verbatim from user input, but a tampered/corrupt persistence-current.json
// could still name something unsafe — so every resolved path is re-validated
// against dataRoot regardless of where the generation string came from.
const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Refusing to resolve a persistence path outside the data root');
  }
  return resolved;
}

export function resolveGenerationPaths(dataRoot: string, generation: string): ActivePersistence {
  if (!GENERATION_ID_PATTERN.test(generation)) {
    throw new Error('Invalid generation id: must match ^[A-Za-z0-9_-]+$');
  }
  const base = safeJoin(dataRoot, 'persistence-generations', generation);
  return {
    generation,
    lineDbPath: safeJoin(base, 'line', 'messages.db'),
    bankDbPath: safeJoin(base, 'bank', 'bank.db'),
    quarantineDbPath: safeJoin(base, 'quarantine', 'messages.db'),
    reportPath: safeJoin(base, 'migration-report.json'),
  };
}

function generationsRoot(dataRoot: string): string {
  return safeJoin(dataRoot, 'persistence-generations');
}

function pointerPath(dataRoot: string): string {
  return safeJoin(dataRoot, 'persistence-current.json');
}

function makeGenerationId(): string {
  return `gen-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

// ─── Pointer (the one cutover commit point) ──────────────────────────────────

interface PointerManifest {
  generation: string;
  publishedAt: string;
}

// A pointer is only authoritative when it parses, names a syntactically safe
// generation, and that generation's report actually exists on disk. Anything
// else (missing file, corrupt JSON, unsafe/incomplete generation) is treated
// exactly like "no pointer yet" — never partially trusted.
function readPointer(dataRoot: string): ActivePersistence | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pointerPath(dataRoot), 'utf8');
  } catch {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  const generation = (manifest as Partial<PointerManifest> | null)?.generation;
  if (typeof generation !== 'string') return null;
  try {
    const active = resolveGenerationPaths(dataRoot, generation);
    if (!fs.existsSync(active.reportPath)) return null;
    return active;
  } catch {
    return null;
  }
}

// Called only when readPointer() found nothing authoritative, so every
// directory here is by definition unreferenced by any committed pointer —
// safe to discard and rebuild fresh, per the plan's restart-authority rule.
function discardUnpublishedGenerations(dataRoot: string): void {
  const root = generationsRoot(dataRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function publishPointer(dataRoot: string, generation: string, failAt?: FailPoint): void {
  const file = pointerPath(dataRoot);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: PointerManifest = { generation, publishedAt: new Date().toISOString() };
  const tmp = path.join(dir, `.persistence-current.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);

  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (failAt === 'before-pointer-rename') {
    throw new Error('Simulated crash: before-pointer-rename');
  }

  fs.renameSync(tmp, file);

  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }

  if (failAt === 'after-pointer-rename') {
    throw new Error('Simulated crash: after-pointer-rename');
  }
}

// ─── Legacy source (read-only; never modified) ───────────────────────────────

interface LegacyMessageRow {
  chat_mid: string;
  message_id: string;
  created_time: number;
  raw_json: string;
}

interface LegacyCategoryRow {
  id: number;
  name: string;
  pattern: string;
}

interface LegacySource {
  present: boolean;
  messages: LegacyMessageRow[];
  categories: LegacyCategoryRow[];
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readLegacySource(dataRoot: string): LegacySource {
  const file = cacheDbPath(dataRoot);
  if (!fs.existsSync(file)) {
    return { present: false, messages: [], categories: [] };
  }
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Legacy source database is corrupt or unreadable; refusing migration: ${firstLine(err)}`,
      { cause: err },
    );
  }
  try {
    const messages = tableExists(db, 'messages')
      ? (db.prepare(
          'SELECT chat_mid, message_id, created_time, raw_json FROM messages ORDER BY created_time ASC',
        ).all() as LegacyMessageRow[])
      : [];
    const categories = tableExists(db, 'categories')
      ? (db.prepare('SELECT id, name, pattern FROM categories ORDER BY id ASC').all() as LegacyCategoryRow[])
      : [];
    return { present: true, messages, categories };
  } catch (err) {
    throw new Error(
      `Legacy source database is corrupt or unreadable; refusing migration: ${firstLine(err)}`,
      { cause: err },
    );
  } finally {
    db.close();
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

// ─── Ownership decision matrix ────────────────────────────────────────────────

interface OwnershipDecision {
  ownerMid: string | null;
  quarantineReason: string | null;
}

// Never infer ownership from chat_mid, message contents, record order, or the
// first saved account. Automatic attribution is permitted in exactly one
// case: one valid auth candidate and zero invalid ones. Any other shape
// (nothing valid, several valid, or an invalid file present alongside a valid
// one) is ambiguous and quarantines the entire source.
function decideOwnership(inventory: AuthRecordInventory): OwnershipDecision {
  if (inventory.invalid.length > 0) {
    return {
      ownerMid: null,
      quarantineReason:
        `ambiguous ownership: ${inventory.invalid.length} invalid auth record(s) present ` +
        `alongside ${inventory.valid.length} valid one(s)`,
    };
  }
  if (inventory.valid.length === 0) {
    return { ownerMid: null, quarantineReason: 'ambiguous ownership: no valid auth record found' };
  }
  if (inventory.valid.length > 1) {
    return {
      ownerMid: null,
      quarantineReason: `ambiguous ownership: ${inventory.valid.length} valid auth records found`,
    };
  }
  return { ownerMid: inventory.valid[0].mid, quarantineReason: null };
}

// ─── Staging destination databases ───────────────────────────────────────────

function checkIntegrity(db: Database.Database, dbPathForError: string): void {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
  if (!ok) {
    throw new Error(`Integrity check failed for staged database at ${dbPathForError}`);
  }
}

function stageLineDb(lineDbPath: string, rows: LegacyMessageRow[], ownerMid: string): void {
  fs.mkdirSync(path.dirname(lineDbPath), { recursive: true });
  const db = new Database(lineDbPath);
  try {
    db.exec(`
      CREATE TABLE messages (
        owner_mid    TEXT    NOT NULL,
        chat_mid     TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        created_time INTEGER NOT NULL,
        raw_json     TEXT    NOT NULL,
        PRIMARY KEY (owner_mid, chat_mid, message_id)
      );
      CREATE INDEX idx_messages_owner_chat_time
        ON messages (owner_mid, chat_mid, created_time);
      PRAGMA user_version = 2;
    `);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO messages (owner_mid, chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?, ?)',
    );
    const insertAll = db.transaction((items: LegacyMessageRow[]) => {
      for (const row of items) {
        insert.run(ownerMid, row.chat_mid, row.message_id, row.created_time, row.raw_json);
      }
    });
    insertAll(rows);
    checkIntegrity(db, lineDbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function stageQuarantineDb(quarantineDbPath: string, rows: LegacyMessageRow[], reason: string): void {
  fs.mkdirSync(path.dirname(quarantineDbPath), { recursive: true });
  const db = new Database(quarantineDbPath);
  try {
    db.exec(`
      CREATE TABLE legacy_messages (
        source_key           TEXT PRIMARY KEY,
        chat_mid             TEXT NOT NULL,
        message_id           TEXT NOT NULL,
        created_time         INTEGER NOT NULL,
        raw_json             TEXT NOT NULL,
        reason               TEXT NOT NULL,
        resolution_owner_mid TEXT,
        resolved_at          TEXT
      );
      PRAGMA user_version = 1;
    `);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO legacy_messages
         (source_key, chat_mid, message_id, created_time, raw_json, reason, resolution_owner_mid, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    const insertAll = db.transaction((items: LegacyMessageRow[]) => {
      for (const row of items) {
        // Audit-stable and matches the chatMid/messageId shape recovery will
        // key mappings by (see Task 3): never derived from row order.
        const sourceKey = `${row.chat_mid}/${row.message_id}`;
        insert.run(sourceKey, row.chat_mid, row.message_id, row.created_time, row.raw_json, reason);
      }
    });
    insertAll(rows);
    checkIntegrity(db, quarantineDbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function stageBankDb(bankDbPath: string, rows: LegacyCategoryRow[]): void {
  fs.mkdirSync(path.dirname(bankDbPath), { recursive: true });
  const db = new Database(bankDbPath);
  try {
    db.exec(`
      CREATE TABLE categories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL UNIQUE,
        pattern TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const insert = db.prepare('INSERT INTO categories (id, name, pattern) VALUES (?, ?, ?)');
    const insertAll = db.transaction((items: LegacyCategoryRow[]) => {
      for (const row of items) insert.run(row.id, row.name, row.pattern);
    });
    insertAll(rows);
    checkIntegrity(db, bankDbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

// ─── Count validation (refuses pointer publication on mismatch) ─────────────

export function validateMigrationCounts(counts: MigrationCounts): void {
  if (counts.attributedMessages + counts.quarantinedMessages !== counts.sourceMessages) {
    throw new Error(
      'Migration validation failed: attributedMessages + quarantinedMessages ' +
      `(${counts.attributedMessages} + ${counts.quarantinedMessages}) does not equal ` +
      `sourceMessages (${counts.sourceMessages}); refusing to publish the pointer`,
    );
  }
  if (counts.copiedCategories !== counts.sourceCategories) {
    throw new Error(
      'Migration validation failed: copiedCategories ' +
      `(${counts.copiedCategories}) does not equal sourceCategories (${counts.sourceCategories}); ` +
      'refusing to publish the pointer',
    );
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export function bootstrapPersistence(options: {
  dataRoot: string;
  failAt?: FailPoint;
}): ActivePersistence {
  const { dataRoot, failAt } = options;
  fs.mkdirSync(dataRoot, { recursive: true });

  // Steady state / restart-after-publish: a valid pointer is authoritative
  // and short-circuits everything else — the legacy source is never
  // re-read once a generation has been committed.
  const existing = readPointer(dataRoot);
  if (existing) return existing;

  // No committed pointer: any staging generation left behind by a prior
  // interrupted run is unreferenced by definition, so it's safe to discard
  // and rebuild from scratch.
  discardUnpublishedGenerations(dataRoot);

  const legacy = readLegacySource(dataRoot);
  const inventory = inventoryStoredAuthRecords(authDir(dataRoot));
  const hasMessages = legacy.messages.length > 0;
  const decision = hasMessages
    ? decideOwnership(inventory)
    : { ownerMid: null, quarantineReason: null };

  // decision.quarantineReason is only ever null when decision.ownerMid is set
  // (see decideOwnership) or when there were no messages to begin with; the
  // fallback text is defensive and should never actually surface.
  const attributedRows = decision.ownerMid ? legacy.messages : [];
  const quarantinedRows = !decision.ownerMid && hasMessages ? legacy.messages : [];
  const quarantineReasonForRows = decision.quarantineReason ?? 'ambiguous ownership';

  const generation = makeGenerationId();
  const active = resolveGenerationPaths(dataRoot, generation);

  stageLineDb(active.lineDbPath, attributedRows, decision.ownerMid ?? '');
  if (failAt === 'after-line') throw new Error('Simulated crash: after-line');

  stageBankDb(active.bankDbPath, legacy.categories);
  if (failAt === 'after-bank') throw new Error('Simulated crash: after-bank');

  stageQuarantineDb(active.quarantineDbPath, quarantinedRows, quarantineReasonForRows);
  if (failAt === 'after-quarantine') throw new Error('Simulated crash: after-quarantine');

  const counts: MigrationCounts = {
    sourceMessages: legacy.messages.length,
    attributedMessages: attributedRows.length,
    quarantinedMessages: quarantinedRows.length,
    sourceCategories: legacy.categories.length,
    copiedCategories: legacy.categories.length,
  };
  validateMigrationCounts(counts);

  const report: MigrationReport = {
    generation,
    createdAt: new Date().toISOString(),
    legacySourcePresent: legacy.present,
    ownerMid: decision.ownerMid,
    quarantineReason: decision.quarantineReason,
    authCandidates: {
      validCount: inventory.valid.length,
      invalidCount: inventory.invalid.length,
      invalidReasons: inventory.invalid.map(i => i.reason),
    },
    counts,
  };
  fs.writeFileSync(active.reportPath, JSON.stringify(report, null, 2));
  if (failAt === 'after-validation') throw new Error('Simulated crash: after-validation');

  publishPointer(dataRoot, generation, failAt);

  return active;
}
