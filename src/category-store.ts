import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Category } from './transaction-parser';

export class CategoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL UNIQUE,
        pattern TEXT NOT NULL
      );
    `);
  }

  upsert(category: Category): void {
    this.db.prepare(
      `INSERT INTO categories (name, pattern) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET pattern = excluded.pattern`,
    ).run(category.name, category.pattern);
  }

  delete(name: string): boolean {
    const info = this.db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    return info.changes > 0;
  }

  list(): Category[] {
    return this.db.prepare('SELECT name, pattern FROM categories ORDER BY id ASC').all() as Category[];
  }
}
