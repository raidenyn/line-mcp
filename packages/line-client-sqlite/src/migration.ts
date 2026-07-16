import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Direct SQLite primitives for staging owner-scoped line messages and
 * quarantined (unattributed) messages, plus explicit-mapping quarantine
 * recovery. Extracted from the server's persistence-migration orchestration
 * (issue #75, Task 6) so the line/quarantine schema and staging logic live
 * in the package that owns the line-message store, rather than being
 * duplicated inline in the server. Bank/category staging is out of scope
 * here — it stays in the server until a later task (bank-mcp extraction).
 *
 * Everything here is a pure, direct-SQLite building block: no ownership
 * inference, no report writing, no pointer/generation logic. The server's
 * persistence-migration module owns that orchestration and calls into these
 * functions instead of duplicating the schema strings itself.
 */

export interface LegacyMessageRow {
  chat_mid: string;
  message_id: string;
  created_time: number;
  raw_json: string;
}

interface QuarantinedRow {
  source_key: string;
  chat_mid: string;
  message_id: string;
  created_time: number;
  raw_json: string;
}

export function checkIntegrity(db: Database.Database, dbPathForError: string): void {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
  if (!ok) {
    throw new Error(`Integrity check failed for staged database at ${dbPathForError}`);
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

/**
 * Reads the legacy `messages` rows from a pre-migration combined
 * `cache/messages.db` (read-only, never modified), ordered oldest-first by
 * `created_time`. Returns `[]` when the file has no `messages` table. Throws
 * (refusing migration) when the file exists but is corrupt or unreadable —
 * the guarantee the server's persistence migration relies on to never guess.
 * The bank/category rows in the same legacy file are read separately by the
 * bank package; this reader is line-only.
 */
export function readLegacyMessages(legacyDbPath: string): LegacyMessageRow[] {
  let db: Database.Database;
  try {
    db = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Legacy source database is corrupt or unreadable; refusing migration: ${firstLine(err)}`,
      { cause: err },
    );
  }
  try {
    return tableExists(db, 'messages')
      ? (db.prepare(
          'SELECT chat_mid, message_id, created_time, raw_json FROM messages ORDER BY created_time ASC',
        ).all() as LegacyMessageRow[])
      : [];
  } catch (err) {
    throw new Error(
      `Legacy source database is corrupt or unreadable; refusing migration: ${firstLine(err)}`,
      { cause: err },
    );
  } finally {
    db.close();
  }
}

// Stages every legacy message row into a fresh owner-scoped line database at
// `lineDbPath`, all attributed to `ownerMid`. Mirrors the schema
// SqliteMessageCache itself creates (see sqlite-message-cache.ts) so the
// staged file is immediately readable through the normal cache API.
export function stageLineDb(lineDbPath: string, rows: LegacyMessageRow[], ownerMid: string): void {
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

// Stages every unattributable legacy message row into a fresh quarantine
// database at `quarantineDbPath`, tagged with `reason`. The `legacy_messages`
// table has no PRIMARY KEY overlap with the normal `messages` schema, so rows
// here are never queryable through the normal owner-scoped MessageCache API —
// quarantine is a physically separate store, not just a filtered view.
export function stageQuarantineDb(quarantineDbPath: string, rows: LegacyMessageRow[], reason: string): void {
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
        // Audit-stable and matches the chatMid/messageId shape recovery mappings
        // are keyed by — never derived from row order.
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

function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

export interface QuarantineRecoverySqlResult {
  recovered: number;
  conflicts: number;
  total: number;
}

// Explicit-mapping recovery over the raw quarantine/line databases. Never
// infers ownership — a row is only recovered when `mapping` names its exact
// source_key and the named owner mid appears in `validMids` (the caller is
// responsible for validating those mids are current, e.g. against stored
// auth records, before calling this). Rows whose target would collide with
// an existing row in the line DB are left untouched and counted as
// `conflicts`, never overwritten. Resolved rows are updated in place
// (resolution_owner_mid/resolved_at set) and retained in legacy_messages for
// audit — nothing is ever deleted.
export function recoverQuarantinedMessagesSql(
  quarantineDbPath: string,
  lineDbPath: string,
  mapping: Record<string, string>,
  validMids: Set<string>,
): QuarantineRecoverySqlResult {
  const qdb = new Database(quarantineDbPath);
  const ldb = new Database(lineDbPath);

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
      const ownerMid = mapping[row.source_key];
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

  return { recovered, conflicts, total };
}
