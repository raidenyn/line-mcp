import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Direct-SQLite primitives for migrating the bank/category portion of the
 * legacy combined `cache/messages.db` into an explicit, standalone bank DB.
 * Extracted from the server's persistence-migration orchestration (issue #75,
 * Task 10) so the `categories` schema and its staging logic live in the
 * package that owns the category store, rather than being duplicated inline in
 * the server.
 *
 * Everything here is a pure, direct-SQLite building block: no ownership
 * inference, no report writing, no pointer/generation logic. The server's
 * persistence-migration module owns that orchestration and calls into these
 * functions instead of duplicating the schema strings itself.
 */

export interface LegacyCategoryRow {
  id: number;
  name: string;
  pattern: string;
}

export interface BankCategoryStagingResult {
  /** Rows presented to staging (the source count). */
  sourceCategories: number;
  /** Rows actually present in the staged bank DB afterwards (the destination count). */
  copiedCategories: number;
  /** Whether the staged DB passed `PRAGMA integrity_check` (always true when this returns; a failed check throws first). */
  integrityOk: boolean;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

function checkIntegrity(db: Database.Database, dbPathForError: string): void {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
  if (!ok) {
    throw new Error(`Integrity check failed for staged database at ${dbPathForError}`);
  }
}

/**
 * Reads the `categories` rows from a legacy combined database (read-only,
 * never modified), ordered by `id`. Returns `[]` when the file has no
 * `categories` table. Throws (refusing migration) when the file exists but is
 * corrupt or unreadable — the same guarantee the monolith's reader gave.
 */
export function readLegacyCategories(legacyDbPath: string): LegacyCategoryRow[] {
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
    return tableExists(db, 'categories')
      ? (db.prepare('SELECT id, name, pattern FROM categories ORDER BY id ASC').all() as LegacyCategoryRow[])
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

/**
 * Stages the given category rows into a fresh bank DB at `bankDbPath`,
 * preserving each row's explicit `id`, its insertion order, its `name`, and
 * its `pattern`. Inserting explicit ids into the AUTOINCREMENT column drives
 * `sqlite_sequence` to the source's max id, so the staged DB's auto-increment
 * state matches the source. Mirrors the schema `CategoryStore` itself creates
 * (see category-store.ts) so the staged file is immediately readable through
 * the normal store API. Runs `PRAGMA integrity_check` and throws (refusing to
 * leave a bad staged DB behind) if it does not report `ok`.
 */
export function stageBankCategories(bankDbPath: string, rows: LegacyCategoryRow[]): BankCategoryStagingResult {
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
    const copiedCategories = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n;
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { sourceCategories: rows.length, copiedCategories, integrityOk: true };
  } finally {
    db.close();
  }
}
