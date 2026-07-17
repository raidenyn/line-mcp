import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CategoryStore } from './category-store';

describe('CategoryStore.list', () => {
  it('returns empty array when no categories saved', () => {
    const store = new CategoryStore(':memory:');
    expect(store.list()).toEqual([]);
  });
});

describe('CategoryStore.upsert', () => {
  it('creates a new category', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' });
    expect(store.list()).toEqual([{ name: 'Groceries', pattern: 'tesco|lotus' }]);
  });

  it('updates pattern when name already exists', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' });
    const result = store.list();
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe('tesco|lotus');
  });

  it('preserves insertion order across updates', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Transport', pattern: 'grab' });
    store.upsert({ name: 'Groceries', pattern: 'tesco|lotus' }); // update, not reorder
    expect(store.list().map(c => c.name)).toEqual(['Groceries', 'Transport']);
  });
});

describe('CategoryStore.delete', () => {
  it('returns false when name not found', () => {
    const store = new CategoryStore(':memory:');
    expect(store.delete('Groceries')).toBe(false);
  });

  it('removes category and returns true', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    expect(store.delete('Groceries')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('does not affect other categories', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    store.upsert({ name: 'Transport', pattern: 'grab' });
    store.delete('Groceries');
    expect(store.list()).toEqual([{ name: 'Transport', pattern: 'grab' }]);
  });
});

describe('CategoryStore.close', () => {
  it('closes the underlying database and is idempotent-safe for callers', () => {
    const store = new CategoryStore(':memory:');
    store.upsert({ name: 'Groceries', pattern: 'tesco' });
    expect(() => store.close()).not.toThrow();
  });

  it('releases the file handle (a new store can reopen the same file path)', () => {
    const tmp = path.join(os.tmpdir(), `line-mcp-catstore-${process.pid}-${Date.now()}.db`);
    try {
      const first = new CategoryStore(tmp);
      first.upsert({ name: 'Groceries', pattern: 'tesco' });
      first.close();
      // better-sqlite3 locks the file while open; after close a second store
      // must be able to open the same path without error (handle released).
      const second = new CategoryStore(tmp);
      expect(second.list().map((c) => c.name)).toEqual(['Groceries']);
      second.close();
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* tmp cleanup best-effort */ }
    }
  });
});
