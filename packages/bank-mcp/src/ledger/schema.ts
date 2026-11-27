import type Database from 'better-sqlite3';

/**
 * One ordered, additive schema step for the ledger tables in `bank/bank.db`.
 *
 * `sql` runs first, then the optional `run(db)` for a step that needs a
 * computed backfill. Steps are never edited after merge: each later task
 * appends the next step after the last merged one.
 */
export interface SchemaStep {
  step: number;
  sql: string;
  run?: (db: Database.Database) => void;
}

/**
 * Step 1 — the first ledger tables. Kept as a single `CREATE TABLE` batch so
 * a failing statement rolls the whole step back.
 *
 * A ledger-owned `ledger_schema_steps` table records progress instead of
 * `PRAGMA user_version`, because `stageBankCategories` already sets
 * `user_version = 1` on `bank.db` and the ledger's version stays independent
 * of it.
 */
export const LEDGER_SCHEMA_STEPS: readonly SchemaStep[] = [
  {
    step: 1,
    sql: `
      CREATE TABLE ledger_owners (
        owner         TEXT PRIMARY KEY,
        base_currency TEXT NOT NULL,
        timezone      TEXT NOT NULL,
        revision      INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE ledger_sources (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        owner              TEXT NOT NULL,
        provider           TEXT NOT NULL,
        native_id          TEXT NOT NULL,
        source_id          TEXT NOT NULL,
        label              TEXT NULL,
        timezone           TEXT NULL,
        review_from        TEXT NOT NULL,
        last_caught_up_at  INTEGER NULL,
        last_error         TEXT NULL,
        revision           INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        UNIQUE(owner, provider, source_id)
      );

      CREATE TABLE ledger_idempotency (
        owner        TEXT NOT NULL,
        tool         TEXT NOT NULL,
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY(owner, tool, key)
      );

      CREATE INDEX ledger_idempotency_owner_created
        ON ledger_idempotency(owner, created_at);
    `,
  },
];

/**
 * Runs every step above the highest one recorded, in one transaction, then
 * records each applied step. Returns the step numbers applied by this call
 * (empty when the database is current).
 */
export function applySchemaSteps(
  db: Database.Database,
  steps: readonly SchemaStep[] = LEDGER_SCHEMA_STEPS,
  nowMs: number = Date.now(),
): number[] {
  const ordered = [...steps].sort((a, b) => a.step - b.step);
  const apply = db.transaction((): number[] => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_schema_steps (
        step       INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const current = (db.prepare('SELECT MAX(step) AS step FROM ledger_schema_steps').get() as {
      step: number | null;
    }).step ?? 0;
    const applied: number[] = [];
    const record = db.prepare('INSERT INTO ledger_schema_steps (step, applied_at) VALUES (?, ?)');
    for (const step of ordered) {
      if (step.step <= current) continue;
      db.exec(step.sql);
      step.run?.(db);
      record.run(step.step, nowMs);
      applied.push(step.step);
    }
    return applied;
  });
  return apply();
}
