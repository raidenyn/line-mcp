import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { LEDGER_SCHEMA_STEPS, applySchemaSteps, type SchemaStep } from './schema';

export interface LedgerStoreOptions {
  /** Injected clock (epoch milliseconds); tests advance it for the idempotency window. */
  now?: () => number;
  /** Overrides the shipped step list (tests use a failing step). */
  steps?: readonly SchemaStep[];
}

/**
 * The owner-scoped ledger on `bank/bank.db`. It owns its own better-sqlite3
 * connection, separate from `CategoryStore`'s, and applies the ordered schema
 * steps when it opens.
 */
export class LedgerStore {
  private db: Database.Database | undefined;
  private readonly now: () => number;

  constructor(dbPath: string, options: LedgerStoreOptions = {}) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.now = options.now ?? Date.now;
    const db = new Database(dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      applySchemaSteps(db, options.steps ?? LEDGER_SCHEMA_STEPS, this.now());
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** The open connection. Throws if the store has been closed. */
  protected get database(): Database.Database {
    if (!this.db) throw new Error('LedgerStore is closed');
    return this.db;
  }

  /** Idempotent: stopping a composed server twice must not fail. */
  close(): void {
    const db = this.db;
    if (!db) return;
    this.db = undefined;
    db.close();
  }
}
