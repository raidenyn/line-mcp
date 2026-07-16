import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Message, MessageCache } from '@raidenyn/line-client';

/**
 * SQLite-backed implementation of the `MessageCache` interface
 * (`@raidenyn/line-client`). Constructed with an explicit `dbPath` — this
 * package never derives a default location; that's the caller's
 * responsibility (see the server's data-dir helpers).
 */
export class SqliteMessageCache implements MessageCache {
  private db: Database.Database;

  constructor(options: { dbPath: string }) {
    const { dbPath } = options;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.assertNoLegacySchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        owner_mid    TEXT    NOT NULL,
        chat_mid     TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        created_time INTEGER NOT NULL,
        raw_json     TEXT    NOT NULL,
        PRIMARY KEY (owner_mid, chat_mid, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_owner_chat_time
        ON messages (owner_mid, chat_mid, created_time);
      PRAGMA user_version = 2;
    `);
  }

  // Rejects a pre-owner-scoping `messages` table outright rather than silently
  // querying a nonexistent `owner_mid` column. Migration arranges migration of
  // any such legacy database before a SqliteMessageCache is constructed against it.
  private assertNoLegacySchema(): void {
    const table = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    ).get();
    if (!table) return;
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    const hasOwnerMid = columns.some(c => c.name === 'owner_mid');
    if (!hasOwnerMid) {
      throw new Error(
        'SqliteMessageCache: found a legacy `messages` table without `owner_mid`. ' +
        'Migrate the database to the owner-scoped schema before constructing SqliteMessageCache.',
      );
    }
  }

  upsertMessages(ownerMid: string, chatMid: string, messages: Message[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO messages (owner_mid, chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?, ?)',
    );
    const insertAll = this.db.transaction((msgs: Message[]) => {
      for (const m of msgs) {
        stmt.run(ownerMid, chatMid, m.id, parseInt(m.createdTime, 10), JSON.stringify(m));
      }
    });
    insertAll(messages);
  }

  getMessages(ownerMid: string, chatMid: string, sinceMs?: number, untilMs?: number): Message[] {
    const conditions = ['owner_mid = ?', 'chat_mid = ?'];
    const params: unknown[] = [ownerMid, chatMid];
    if (sinceMs != null) { conditions.push('created_time >= ?'); params.push(sinceMs); }
    if (untilMs != null) { conditions.push('created_time <= ?'); params.push(untilMs); }
    const sql = `SELECT raw_json FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_time ASC`;
    const rows = (this.db.prepare(sql).all(...params)) as { raw_json: string }[];
    const messages = rows.map(r => JSON.parse(r.raw_json) as Message);
    // Deduplicate export-vs-API overlap: same non-empty text within the same minute = same message
    const seen = new Set<string>();
    return messages.filter(m => {
      if (!m.text) return true;
      const key = `${Math.floor(parseInt(m.createdTime, 10) / 60000)}:${m.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  latestTimestamp(ownerMid: string, chatMid: string): number | null {
    const row = this.db.prepare(
      'SELECT MAX(created_time) as ts FROM messages WHERE owner_mid = ? AND chat_mid = ?',
    ).get(ownerMid, chatMid) as { ts: number | null };
    return row.ts ?? null;
  }

  getDistinctChatMids(ownerMid: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT chat_mid FROM messages WHERE owner_mid = ?',
    ).all(ownerMid) as { chat_mid: string }[];
    return rows.map(r => r.chat_mid);
  }

  close(): void {
    this.db.close();
  }
}
