import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteMessageCache } from './sqlite-message-cache';
import type { Message } from '@raidenyn/line-client';

const OWNER = 'u-test';

function msg(id: string, createdTime: string, text?: string): Message {
  return { id, from: 'u1', to: 'c1', toType: 1, createdTime, contentType: 0, hasContent: false, text };
}

describe('SqliteMessageCache.getMessages', () => {
  it('returns empty array for unknown chat', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    expect(cache.getMessages(OWNER, 'chat1')).toEqual([]);
  });

  it('returns messages oldest-first', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('2', '2000'), msg('1', '1000')]);
    expect(cache.getMessages(OWNER, 'chat1').map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by sinceMs (inclusive)', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages(OWNER, 'chat1', 2000).map(m => m.id)).toEqual(['2', '3']);
  });

  it('filters by untilMs (inclusive)', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages(OWNER, 'chat1', undefined, 2000).map(m => m.id)).toEqual(['1', '2']);
  });

  it('filters by both sinceMs and untilMs', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('2', '2000'), msg('3', '3000')]);
    expect(cache.getMessages(OWNER, 'chat1', 1500, 2500).map(m => m.id)).toEqual(['2']);
  });

  it('isolates messages by chatMid', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(OWNER, 'chat2', [msg('2', '2000')]);
    expect(cache.getMessages(OWNER, 'chat1').map(m => m.id)).toEqual(['1']);
    expect(cache.getMessages(OWNER, 'chat2').map(m => m.id)).toEqual(['2']);
  });
});

describe('SqliteMessageCache.getMessages message multiplicity', () => {
  it('returns distinct real IDs with identical text in the same minute', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [
      msg('real-1', '600000', 'Repeated'),
      msg('real-2', '627000', 'Repeated'),
    ]);

    expect(cache.getMessages(OWNER, 'chat1').map(message => message.id)).toEqual([
      'real-1',
      'real-2',
    ]);
  });
});

describe('SqliteMessageCache.importMessages', () => {
  it('stores identical imported occurrences and makes reimport idempotent', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    const imported = [
      msg('export-first', '600000', 'Repeated'),
      msg('export-second', '600000', 'Repeated'),
    ];

    expect(cache.importMessages(OWNER, 'chat1', imported)).toEqual({ imported: 2 });
    expect(cache.importMessages(OWNER, 'chat1', imported)).toEqual({ imported: 0 });
    expect(cache.getMessages(OWNER, 'chat1')).toHaveLength(2);
  });

  it('adds only occurrences beyond existing real and legacy synthetic rows', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [
      msg('real-1', '627000', 'Repeated'),
      msg('export-legacy-hash', '600000', 'Repeated'),
    ]);

    const result = cache.importMessages(OWNER, 'chat1', [
      msg('export-new-0', '600000', 'Repeated'),
      msg('export-new-1', '600000', 'Repeated'),
      msg('export-new-2', '600000', 'Repeated'),
    ]);

    expect(result).toEqual({ imported: 1 });
    expect(cache.getMessages(OWNER, 'chat1')).toHaveLength(3);
  });

  it('matches exact IDs first and refreshes them without double-consuming', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [
      msg('export-same', '540000', 'Old text'),
    ]);

    const result = cache.importMessages(OWNER, 'chat1', [
      msg('export-same', '600000', 'Repeated'),
      msg('export-other', '600000', 'Repeated'),
    ]);

    expect(result).toEqual({ imported: 1 });
    expect(cache.getMessages(OWNER, 'chat1').map(message => message.text)).toEqual([
      'Repeated',
      'Repeated',
    ]);
  });

  it('does not match equal text in different minutes', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('real-1', '600000', 'Repeated')]);

    expect(cache.importMessages(OWNER, 'chat1', [
      msg('export-next-minute', '660000', 'Repeated'),
    ])).toEqual({ imported: 1 });
  });

  it('rolls back the entire import when a later message cannot be serialized', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    const invalid = msg('export-invalid', '660000', 'Second');
    const metadata: Record<string, string> = {};
    (metadata as Record<string, unknown>)['self'] = metadata;
    invalid.contentMetadata = metadata;

    expect(() => cache.importMessages(OWNER, 'chat1', [
      msg('export-valid', '600000', 'First'),
      invalid,
    ])).toThrow();
    expect(cache.getMessages(OWNER, 'chat1')).toEqual([]);
  });
});

describe('SqliteMessageCache.upsertMessages', () => {
  it('deduplicates on re-insert (same message_id)', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    expect(cache.getMessages(OWNER, 'chat1')).toHaveLength(1);
  });

  it('no-ops on empty array', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', []);
    expect(cache.getMessages(OWNER, 'chat1')).toEqual([]);
  });
});

describe('SqliteMessageCache.latestTimestamp', () => {
  it('returns null for empty cache', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    expect(cache.latestTimestamp(OWNER, 'chat1')).toBeNull();
  });

  it('returns highest createdTime as number', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000'), msg('3', '3000'), msg('2', '2000')]);
    expect(cache.latestTimestamp(OWNER, 'chat1')).toBe(3000);
  });

  it('is scoped per chatMid', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(OWNER, 'chat2', [msg('2', '9000')]);
    expect(cache.latestTimestamp(OWNER, 'chat1')).toBe(1000);
  });
});

describe('SqliteMessageCache.getDistinctChatMids', () => {
  it('returns empty array when cache is empty', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    expect(cache.getDistinctChatMids(OWNER)).toEqual([]);
  });

  it('returns each chat mid exactly once', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages(OWNER, 'chat1', [msg('1', '1000')]);
    cache.upsertMessages(OWNER, 'chat2', [msg('2', '2000')]);
    cache.upsertMessages(OWNER, 'chat1', [msg('3', '3000')]); // second insert for chat1
    const mids = cache.getDistinctChatMids(OWNER);
    expect(mids.sort()).toEqual(['chat1', 'chat2']);
  });
});

describe('SqliteMessageCache owner isolation', () => {
  it('isolates identical chat and message IDs by owner', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.upsertMessages('u-owner-a', 'c-shared', [msg('m1', '1000', 'from A')]);
    cache.upsertMessages('u-owner-b', 'c-shared', [msg('m1', '1000', 'from B')]);

    expect(cache.getMessages('u-owner-a', 'c-shared').map(m => m.text)).toEqual(['from A']);
    expect(cache.getMessages('u-owner-b', 'c-shared').map(m => m.text)).toEqual(['from B']);
    expect(cache.latestTimestamp('u-owner-a', 'c-shared')).not.toBeNull();
    expect(cache.getDistinctChatMids('u-owner-a')).toEqual(['c-shared']);
  });
});

describe('SqliteMessageCache API reconciliation', () => {
  it('replaces one matching synthetic row with each new real ID', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.importMessages(OWNER, 'chat1', [
      msg('export-0', '600000', 'Repeated'),
      msg('export-1', '600000', 'Repeated'),
    ]);

    cache.upsertMessages(OWNER, 'chat1', [msg('real-0', '627000', 'Repeated')]);
    expect(cache.getMessages(OWNER, 'chat1').map(message => message.id).sort()).toEqual([
      'export-1',
      'real-0',
    ]);

    cache.upsertMessages(OWNER, 'chat1', [msg('real-1', '638000', 'Repeated')]);
    expect(cache.getMessages(OWNER, 'chat1').map(message => message.id).sort()).toEqual([
      'real-0',
      'real-1',
    ]);
  });

  it('does not consume another synthetic row when a real ID is refetched', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });
    cache.importMessages(OWNER, 'chat1', [
      msg('export-0', '600000', 'Repeated'),
      msg('export-1', '600000', 'Repeated'),
    ]);
    const real = msg('real-0', '627000', 'Repeated');

    cache.upsertMessages(OWNER, 'chat1', [real]);
    cache.upsertMessages(OWNER, 'chat1', [real]);

    expect(cache.getMessages(OWNER, 'chat1').map(message => message.id).sort()).toEqual([
      'export-1',
      'real-0',
    ]);
  });

  it('never content-deduplicates two real IDs', () => {
    const cache = new SqliteMessageCache({ dbPath: ':memory:' });

    cache.upsertMessages(OWNER, 'chat1', [
      msg('real-0', '627000', 'Repeated'),
      msg('real-1', '638000', 'Repeated'),
    ]);

    expect(cache.getMessages(OWNER, 'chat1')).toHaveLength(2);
  });

  it('rolls back earlier replacements when a later stored row is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'line-cache-reconcile-'));
    const dbPath = join(dir, 'messages.db');
    const cache = new SqliteMessageCache({ dbPath });
    const rawDb = new Database(dbPath);
    try {
      cache.importMessages(OWNER, 'chat1', [
        msg('export-valid', '600000', 'First'),
      ]);
      rawDb.prepare(`
        INSERT INTO messages (owner_mid, chat_mid, message_id, created_time, raw_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(OWNER, 'chat1', 'export-invalid', 660000, '{invalid-json');

      expect(() => cache.upsertMessages(OWNER, 'chat1', [
        msg('real-first', '627000', 'First'),
        msg('real-second', '687000', 'Second'),
      ])).toThrow();

      const ids = (rawDb.prepare(`
        SELECT message_id FROM messages
        WHERE owner_mid = ? AND chat_mid = ?
        ORDER BY message_id
      `).all(OWNER, 'chat1') as Array<{ message_id: string }>)
        .map(row => row.message_id);
      expect(ids).toEqual(['export-invalid', 'export-valid']);
    } finally {
      rawDb.close();
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
