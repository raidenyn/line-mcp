import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ImportMessagesResult, Message, MessageCache } from '@raidenyn/line-client';

interface StoredMessageRow {
  message_id: string;
  raw_json: string;
}

function timestampMs(message: Message): number {
  return parseInt(message.createdTime, 10);
}

function reconciliationKey(message: Message): string | null {
  const timestamp = timestampMs(message);
  if (!Number.isFinite(timestamp) || typeof message.text !== 'string') return null;
  return JSON.stringify([Math.floor(timestamp / 60_000), message.text]);
}

function parseStoredMessage(row: StoredMessageRow): Message {
  return JSON.parse(row.raw_json) as Message;
}

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
    const selectById = this.db.prepare(`
      SELECT message_id, raw_json
      FROM messages
      WHERE owner_mid = ? AND chat_mid = ? AND message_id = ?
    `);
    const selectSyntheticMinute = this.db.prepare(`
      SELECT message_id, raw_json
      FROM messages
      WHERE owner_mid = ? AND chat_mid = ?
        AND message_id LIKE 'export-%'
        AND created_time >= ? AND created_time < ?
      ORDER BY message_id
    `);
    const deleteById = this.db.prepare(`
      DELETE FROM messages
      WHERE owner_mid = ? AND chat_mid = ? AND message_id = ?
    `);
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (owner_mid, chat_mid, message_id, created_time, raw_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction((batch: Message[]) => {
      for (const message of batch) {
        const existing = selectById.get(ownerMid, chatMid, message.id) as StoredMessageRow | undefined;
        const key = reconciliationKey(message);

        if (!existing && !message.id.startsWith('export-') && key !== null) {
          const timestamp = timestampMs(message);
          const minuteStart = Math.floor(timestamp / 60_000) * 60_000;
          const candidates = selectSyntheticMinute.all(
            ownerMid,
            chatMid,
            minuteStart,
            minuteStart + 60_000,
          ) as StoredMessageRow[];
          const match = candidates.find(row => reconciliationKey(parseStoredMessage(row)) === key);
          if (match) deleteById.run(ownerMid, chatMid, match.message_id);
        }

        upsert.run(
          ownerMid,
          chatMid,
          message.id,
          timestampMs(message),
          JSON.stringify(message),
        );
      }
    });

    insertAll(messages);
  }

  importMessages(
    ownerMid: string,
    chatMid: string,
    messages: Message[],
  ): ImportMessagesResult {
    if (messages.length === 0) return { imported: 0 };

    const times = messages.map(timestampMs);
    const rangeStart = Math.floor(Math.min(...times) / 60_000) * 60_000;
    const rangeEnd = (Math.floor(Math.max(...times) / 60_000) + 1) * 60_000;
    const selectRange = this.db.prepare(`
      SELECT message_id, raw_json
      FROM messages
      WHERE owner_mid = ? AND chat_mid = ?
        AND created_time >= ? AND created_time < ?
    `);
    const selectById = this.db.prepare(`
      SELECT message_id, raw_json
      FROM messages
      WHERE owner_mid = ? AND chat_mid = ? AND message_id = ?
    `);
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (owner_mid, chat_mid, message_id, created_time, raw_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    const reconcile = this.db.transaction((batch: Message[]): ImportMessagesResult => {
      const rangeRows = selectRange.all(
        ownerMid,
        chatMid,
        rangeStart,
        rangeEnd,
      ) as StoredMessageRow[];
      const existingById = new Map(rangeRows.map(row => [row.message_id, row]));

      for (const message of batch) {
        if (existingById.has(message.id)) continue;
        const row = selectById.get(ownerMid, chatMid, message.id) as StoredMessageRow | undefined;
        if (row) existingById.set(row.message_id, row);
      }

      const consumedExistingIds = new Set<string>();
      const consumedParsedIds = new Set<string>();

      for (const message of batch) {
        if (!existingById.has(message.id)) continue;
        upsert.run(
          ownerMid,
          chatMid,
          message.id,
          timestampMs(message),
          JSON.stringify(message),
        );
        consumedExistingIds.add(message.id);
        consumedParsedIds.add(message.id);
      }

      const availableByKey = new Map<string, number>();
      for (const row of rangeRows) {
        if (consumedExistingIds.has(row.message_id)) continue;
        const key = reconciliationKey(parseStoredMessage(row));
        if (key !== null) availableByKey.set(key, (availableByKey.get(key) ?? 0) + 1);
      }

      let imported = 0;
      for (const message of batch) {
        if (consumedParsedIds.has(message.id)) continue;
        const key = reconciliationKey(message);
        const available = key === null ? 0 : (availableByKey.get(key) ?? 0);
        if (key !== null && available > 0) {
          availableByKey.set(key, available - 1);
          continue;
        }
        upsert.run(
          ownerMid,
          chatMid,
          message.id,
          timestampMs(message),
          JSON.stringify(message),
        );
        imported += 1;
      }

      return { imported };
    });

    return reconcile(messages);
  }

  getMessages(ownerMid: string, chatMid: string, sinceMs?: number, untilMs?: number): Message[] {
    const conditions = ['owner_mid = ?', 'chat_mid = ?'];
    const params: unknown[] = [ownerMid, chatMid];
    if (sinceMs != null) { conditions.push('created_time >= ?'); params.push(sinceMs); }
    if (untilMs != null) { conditions.push('created_time <= ?'); params.push(untilMs); }
    const sql = `SELECT raw_json FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_time ASC`;
    const rows = (this.db.prepare(sql).all(...params)) as { raw_json: string }[];
    return rows.map(row => JSON.parse(row.raw_json) as Message);
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
