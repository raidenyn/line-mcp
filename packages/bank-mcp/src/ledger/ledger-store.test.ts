import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { CategoryStore } from '../category-store';
import { LEDGER_SCHEMA_STEPS, applySchemaSteps, type SchemaStep } from './schema';
import { LedgerStore } from './ledger-store';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-store-'));
  return { dir, path: join(dir, 'bank', 'bank.db') };
}

function tableNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

describe('LedgerStore lifecycle', () => {
  it('creates the ledger tables on a fresh file', () => {
    const { dir, path } = tempDbPath();
    const store = new LedgerStore(path);
    try {
      const tables = tableNames(path);
      expect(tables).toEqual(
        expect.arrayContaining(['ledger_idempotency', 'ledger_owners', 'ledger_schema_steps', 'ledger_sources']),
      );
      const db = new Database(path, { readonly: true });
      try {
        expect(db.prepare('SELECT step FROM ledger_schema_steps').all()).toEqual([{ step: 1 }]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves user_version and the legacy categories table alone', () => {
    const { dir, path } = tempDbPath();
    const categories = new CategoryStore(path);
    categories.upsert({ name: 'Legacy', pattern: 'Legacy' });
    categories.close();
    const raw = new Database(path);
    raw.pragma('user_version = 1');
    raw.close();

    const store = new LedgerStore(path);
    try {
      const db = new Database(path, { readonly: true });
      try {
        expect(db.pragma('user_version', { simple: true })).toBe(1);
        expect(db.prepare('SELECT name, pattern FROM categories').all()).toEqual([
          { name: 'Legacy', pattern: 'Legacy' },
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopens without re-running steps and keeps rows', () => {
    const { dir, path } = tempDbPath();
    const first = new LedgerStore(path);
    const db = new Database(path);
    db.prepare(
      `INSERT INTO ledger_owners (owner, base_currency, timezone, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('u-owner', 'THB', 'Asia/Bangkok', 1, 1000, 1000);
    db.close();
    first.close();

    const second = new LedgerStore(path);
    try {
      const check = new Database(path, { readonly: true });
      try {
        expect(check.prepare('SELECT owner, base_currency FROM ledger_owners').all()).toEqual([
          { owner: 'u-owner', base_currency: 'THB' },
        ]);
        expect(check.prepare('SELECT step FROM ledger_schema_steps').all()).toEqual([{ step: 1 }]);
      } finally {
        check.close();
      }
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing step and closes the connection', () => {
    const { dir, path } = tempDbPath();
    const badSteps: readonly SchemaStep[] = [
      ...LEDGER_SCHEMA_STEPS,
      { step: 2, sql: 'CREATE TABLE ledger_x (a); SELECT nope FROM missing;' },
    ];
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => new LedgerStore(path, { steps: badSteps })).toThrow();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }

    const store = new LedgerStore(path);
    try {
      const tables = tableNames(path);
      expect(tables).not.toContain('ledger_x');
      const db = new Database(path, { readonly: true });
      try {
        expect(db.prepare('SELECT step FROM ledger_schema_steps').all()).toEqual([{ step: 1 }]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close is safe to call twice', () => {
    const { dir, path } = tempDbPath();
    const store = new LedgerStore(path);
    store.close();
    expect(() => store.close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies only steps above the recorded one', () => {
    const { dir, path } = tempDbPath();
    mkdirSync(join(dir, 'bank'), { recursive: true });
    const db = new Database(path);
    try {
      const applied = applySchemaSteps(db, undefined, 1000);
      expect(applied).toEqual([1]);
      const again = applySchemaSteps(db, undefined, 2000);
      expect(again).toEqual([]);
      expect(db.prepare('SELECT step, applied_at FROM ledger_schema_steps').all()).toEqual([
        { step: 1, applied_at: 1000 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
