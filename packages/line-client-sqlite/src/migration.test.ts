import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import {
  stageLineDb,
  stageQuarantineDb,
  recoverQuarantinedMessagesSql,
  type LegacyMessageRow,
} from './migration';
import { SqliteMessageCache } from './sqlite-message-cache';

const OWNER = 'u-owner-a';

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'line-client-sqlite-migration-'));
}

function row(chatMid: string, messageId: string, createdTime: number, text = 'hi'): LegacyMessageRow {
  return {
    chat_mid: chatMid,
    message_id: messageId,
    created_time: createdTime,
    raw_json: JSON.stringify({
      id: messageId, from: chatMid, to: chatMid, toType: 1,
      createdTime: String(createdTime), contentType: 0, hasContent: false, text,
    }),
  };
}

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

describe('stageLineDb', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtemp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stages rows attributed to the given owner, readable through SqliteMessageCache', () => {
    const lineDbPath = path.join(dir, 'line', 'messages.db');
    stageLineDb(lineDbPath, [row('c1', 'm1', 1000), row('c2', 'm2', 2000)], OWNER);

    const cache = new SqliteMessageCache({ dbPath: lineDbPath });
    try {
      expect(cache.getMessages(OWNER, 'c1').map(m => m.id)).toEqual(['m1']);
      expect(cache.getMessages(OWNER, 'c2').map(m => m.id)).toEqual(['m2']);
      expect(cache.getMessages('someone-else', 'c1')).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it('produces an empty but valid database for zero rows', () => {
    const lineDbPath = path.join(dir, 'line', 'messages.db');
    expect(() => stageLineDb(lineDbPath, [], OWNER)).not.toThrow();
    const cache = new SqliteMessageCache({ dbPath: lineDbPath });
    try {
      expect(cache.getDistinctChatMids(OWNER)).toEqual([]);
    } finally {
      cache.close();
    }
  });
});

describe('stageQuarantineDb', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtemp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stages rows with an audit-stable source_key, reason set, and unresolved', () => {
    const quarantineDbPath = path.join(dir, 'quarantine', 'messages.db');
    stageQuarantineDb(quarantineDbPath, [row('c1', 'm1', 1000), row('c2', 'm2', 2000)], 'ambiguous ownership: test');

    const rows = quarantineRows(quarantineDbPath);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.source_key).sort()).toEqual(['c1/m1', 'c2/m2']);
    for (const r of rows) {
      expect(r.reason).toBe('ambiguous ownership: test');
      expect(r.resolution_owner_mid).toBeNull();
      expect(r.resolved_at).toBeNull();
    }
  });

  it('quarantined rows are physically invisible through SqliteMessageCache (no messages table)', () => {
    const quarantineDbPath = path.join(dir, 'quarantine', 'messages.db');
    stageQuarantineDb(quarantineDbPath, [row('c1', 'm1', 1000)], 'ambiguous ownership: test');

    const cache = new SqliteMessageCache({ dbPath: quarantineDbPath });
    try {
      expect(cache.getMessages(OWNER, 'c1')).toEqual([]);
      expect(cache.getDistinctChatMids(OWNER)).toEqual([]);
    } finally {
      cache.close();
    }
  });
});

describe('recoverQuarantinedMessagesSql', () => {
  let dir: string;
  let lineDbPath: string;
  let quarantineDbPath: string;

  beforeEach(() => {
    dir = mkdtemp();
    lineDbPath = path.join(dir, 'line', 'messages.db');
    quarantineDbPath = path.join(dir, 'quarantine', 'messages.db');
    stageLineDb(lineDbPath, [], '');
    stageQuarantineDb(quarantineDbPath, [row('c1', 'm1', 1000), row('c2', 'm2', 2000)], 'ambiguous ownership: test');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('recovers a fully-mapped quarantine set', () => {
    const result = recoverQuarantinedMessagesSql(
      quarantineDbPath, lineDbPath,
      { 'c1/m1': OWNER, 'c2/m2': OWNER },
      new Set([OWNER]),
    );
    expect(result).toEqual({ recovered: 2, conflicts: 0, total: 2 });

    const cache = new SqliteMessageCache({ dbPath: lineDbPath });
    try {
      expect(cache.getMessages(OWNER, 'c1')).toHaveLength(1);
      expect(cache.getMessages(OWNER, 'c2')).toHaveLength(1);
    } finally {
      cache.close();
    }
    expect(quarantineRows(quarantineDbPath)).toHaveLength(0);
  });

  it('leaves unmapped rows quarantined (partial recovery)', () => {
    const result = recoverQuarantinedMessagesSql(
      quarantineDbPath, lineDbPath,
      { 'c1/m1': OWNER },
      new Set([OWNER]),
    );
    expect(result).toEqual({ recovered: 1, conflicts: 0, total: 2 });

    const remaining = quarantineRows(quarantineDbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source_key).toBe('c2/m2');
  });

  it('refuses a mapping to a mid not present in validMids', () => {
    const result = recoverQuarantinedMessagesSql(
      quarantineDbPath, lineDbPath,
      { 'c1/m1': 'unknown-mid' },
      new Set(), // no valid mids at all
    );
    expect(result).toEqual({ recovered: 0, conflicts: 0, total: 2 });
    expect(quarantineRows(quarantineDbPath)).toHaveLength(2);
  });

  it('retains a conflicting row for audit instead of overwriting', () => {
    const preseed = new SqliteMessageCache({ dbPath: lineDbPath });
    preseed.upsertMessages(OWNER, 'c1', [{
      id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '9999',
      contentType: 0, hasContent: false, text: 'already synced independently',
    }]);
    preseed.close();

    const result = recoverQuarantinedMessagesSql(
      quarantineDbPath, lineDbPath,
      { 'c1/m1': OWNER, 'c2/m2': OWNER },
      new Set([OWNER]),
    );
    expect(result).toEqual({ recovered: 1, conflicts: 1, total: 2 });

    const cache = new SqliteMessageCache({ dbPath: lineDbPath });
    try {
      const c1Messages = cache.getMessages(OWNER, 'c1');
      expect(c1Messages).toHaveLength(1);
      expect(c1Messages[0].text).toBe('already synced independently');
    } finally {
      cache.close();
    }

    const remaining = quarantineRows(quarantineDbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source_key).toBe('c1/m1');
  });

  it('idempotently completes an interrupted recovery instead of misclassifying it as a conflict', () => {
    // The crash window: a previous recovery run inserted c1/m1 into the line
    // DB successfully but crashed before marking the quarantined row resolved.
    // On replay, the byte-identical existing line row must be recognized as
    // an interrupted recovery (recovered), NOT a conflict — otherwise the row
    // is permanently misclassified as a conflict on every future run.
    const preseed = new SqliteMessageCache({ dbPath: lineDbPath });
    preseed.upsertMessages(OWNER, 'c1', [{
      id: 'm1', from: 'c1', to: 'c1', toType: 1, createdTime: '1000',
      contentType: 0, hasContent: false, text: 'hi',
    }]);
    preseed.close();

    const result = recoverQuarantinedMessagesSql(
      quarantineDbPath, lineDbPath,
      { 'c1/m1': OWNER, 'c2/m2': OWNER },
      new Set([OWNER]),
    );
    expect(result).toEqual({ recovered: 2, conflicts: 0, total: 2 });

    // The previously-interrupted c1/m1 quarantine row is now marked resolved.
    expect(quarantineRows(quarantineDbPath)).toHaveLength(0);
    const db = new Database(quarantineDbPath, { readonly: true });
    try {
      const resolved = db.prepare(
        'SELECT resolution_owner_mid FROM legacy_messages WHERE source_key = ?',
      ).get('c1/m1') as { resolution_owner_mid: string } | undefined;
      expect(resolved?.resolution_owner_mid).toBe(OWNER);
    } finally {
      db.close();
    }
  });

  it('leaves rows with no mapping entry at all untouched and unresolved', () => {
    const result = recoverQuarantinedMessagesSql(quarantineDbPath, lineDbPath, {}, new Set([OWNER]));
    expect(result).toEqual({ recovered: 0, conflicts: 0, total: 2 });
    expect(quarantineRows(quarantineDbPath)).toHaveLength(2);
  });
});
