import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readLegacyCategories, stageBankCategories, type LegacyCategoryRow } from './category-migration';
import { CategoryStore } from './category-store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bank-catmig-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Builds a legacy combined cache/messages.db shaped like the pre-migration
// monolith: a categories table (AUTOINCREMENT id) plus, optionally, a messages
// table that this bank primitive must ignore.
function buildLegacyDb(categories: LegacyCategoryRow[], withMessagesTable = true): string {
  const dbPath = join(dir, 'messages.db');
  const db = new Database(dbPath);
  if (withMessagesTable) {
    db.exec(`CREATE TABLE messages (chat_mid TEXT, message_id TEXT, created_time INTEGER, raw_json TEXT);`);
  }
  db.exec(`
    CREATE TABLE categories (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE,
      pattern TEXT NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO categories (id, name, pattern) VALUES (?, ?, ?)');
  for (const c of categories) insert.run(c.id, c.name, c.pattern);
  db.close();
  return dbPath;
}

describe('readLegacyCategories', () => {
  it('reads categories in id order', () => {
    const path = buildLegacyDb([
      { id: 2, name: 'transport', pattern: 'Taxi' },
      { id: 1, name: 'groceries', pattern: 'Store' },
    ]);
    expect(readLegacyCategories(path)).toEqual([
      { id: 1, name: 'groceries', pattern: 'Store' },
      { id: 2, name: 'transport', pattern: 'Taxi' },
    ]);
  });

  it('returns [] when the legacy db has no categories table', () => {
    const dbPath = join(dir, 'messages.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE messages (chat_mid TEXT);');
    db.close();
    expect(readLegacyCategories(dbPath)).toEqual([]);
  });

  it('throws (refusing migration) on a corrupt legacy db', () => {
    const dbPath = join(dir, 'messages.db');
    writeFileSync(dbPath, 'this is not a sqlite database file at all');
    expect(() => readLegacyCategories(dbPath)).toThrow(/corrupt or unreadable/);
  });
});

describe('stageBankCategories', () => {
  it('stages rows preserving explicit ids, order, names, and patterns, and returns matching counts', () => {
    const rows: LegacyCategoryRow[] = [
      { id: 1, name: 'groceries', pattern: 'Store' },
      { id: 2, name: 'transport', pattern: 'Taxi' },
    ];
    const bankDbPath = join(dir, 'bank', 'bank.db');
    const result = stageBankCategories(bankDbPath, rows);
    expect(result).toEqual({ sourceCategories: 2, copiedCategories: 2, integrityOk: true });

    const db = new Database(bankDbPath, { readonly: true });
    try {
      const staged = db.prepare('SELECT id, name, pattern FROM categories ORDER BY id ASC').all();
      expect(staged).toEqual(rows);
      // sqlite_sequence advanced to the max inserted id, so the next auto id
      // continues from the source rather than restarting at 1.
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'categories'").get() as { seq: number };
      expect(seq.seq).toBe(2);
    } finally {
      db.close();
    }
  });

  it('produces a db immediately usable through the normal CategoryStore API', () => {
    const rows: LegacyCategoryRow[] = [{ id: 5, name: 'coffee', pattern: 'Cafe' }];
    const bankDbPath = join(dir, 'bank', 'bank.db');
    stageBankCategories(bankDbPath, rows);
    const store = new CategoryStore(bankDbPath);
    expect(store.list()).toEqual([{ name: 'coffee', pattern: 'Cafe' }]);
  });

  it('stages an empty category set as an empty, valid db', () => {
    const bankDbPath = join(dir, 'bank', 'bank.db');
    const result = stageBankCategories(bankDbPath, []);
    expect(result).toEqual({ sourceCategories: 0, copiedCategories: 0, integrityOk: true });
    expect(new CategoryStore(bankDbPath).list()).toEqual([]);
  });

  it('round-trips read-then-stage from a legacy source', () => {
    const legacyPath = buildLegacyDb([
      { id: 1, name: 'groceries', pattern: 'Store' },
      { id: 2, name: 'transport', pattern: 'Taxi' },
    ]);
    const rows = readLegacyCategories(legacyPath);
    const bankDbPath = join(dir, 'bank', 'bank.db');
    const result = stageBankCategories(bankDbPath, rows);
    expect(result.sourceCategories).toBe(2);
    expect(result.copiedCategories).toBe(2);
    expect(new CategoryStore(bankDbPath).list()).toEqual([
      { name: 'groceries', pattern: 'Store' },
      { name: 'transport', pattern: 'Taxi' },
    ]);
  });
});
