import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Message } from './line-client';

export class MessageCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_mid     TEXT    NOT NULL,
        message_id   TEXT    NOT NULL,
        created_time INTEGER NOT NULL,
        raw_json     TEXT    NOT NULL,
        PRIMARY KEY (chat_mid, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time
        ON messages (chat_mid, created_time);
    `);
  }

  upsertMessages(chatMid: string, messages: Message[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO messages (chat_mid, message_id, created_time, raw_json) VALUES (?, ?, ?, ?)',
    );
    const insertAll = this.db.transaction((msgs: Message[]) => {
      for (const m of msgs) {
        stmt.run(chatMid, m.id, parseInt(m.createdTime, 10), JSON.stringify(m));
      }
    });
    insertAll(messages);
  }

  getMessages(chatMid: string, sinceMs?: number, untilMs?: number): Message[] {
    const conditions = ['chat_mid = ?'];
    const params: unknown[] = [chatMid];
    if (sinceMs != null) { conditions.push('created_time >= ?'); params.push(sinceMs); }
    if (untilMs != null) { conditions.push('created_time <= ?'); params.push(untilMs); }
    const sql = `SELECT raw_json FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_time ASC`;
    const rows = (this.db.prepare(sql).all(...params)) as { raw_json: string }[];
    return rows.map(r => JSON.parse(r.raw_json) as Message);
  }

  latestTimestamp(chatMid: string): number | null {
    const row = this.db.prepare(
      'SELECT MAX(created_time) as ts FROM messages WHERE chat_mid = ?',
    ).get(chatMid) as { ts: number | null };
    return row.ts ?? null;
  }
}
