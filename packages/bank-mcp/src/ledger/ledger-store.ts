import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { LEDGER_SCHEMA_STEPS, applySchemaSteps, type SchemaStep } from './schema';
import { LedgerError, invalidArgument } from './errors';
import { defaultReviewFrom, normalizeTimezone } from './validation';

/** The setup hint shared by `ledger_status` and every non-adding action. */
export const SETUP_ACTION =
  'Call manage_accounts with action add_source, a base_currency and an owner_timezone.';

export interface LedgerSettings {
  base_currency: string;
  timezone: string;
  revision: number;
}

export interface LedgerSource {
  provider: 'line';
  source_id: string;
  native_id: string;
  label: string | null;
  /** Effective timezone: the source's own, or the owner's when it inherits. */
  timezone: string;
  /** The source's own timezone, `null` when it follows the owner's. */
  own_timezone: string | null;
  review_from: string;
  last_caught_up_at: number | null;
  last_error: { code: string; message: string; at: number } | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface WriteKeys {
  idempotencyKey?: string;
  requestHash?: string;
  expectedRevision?: number;
}

export interface AddSourceInput {
  provider: 'line';
  source_id: string;
  label?: string;
  timezone?: string;
  review_from?: string;
  base_currency?: string;
  owner_timezone?: string;
}

export interface UpdateSourcePatch {
  label?: string | null;
  timezone?: string | null;
  review_from?: string;
}

export interface UpdateSettingsPatch {
  timezone?: string;
  base_currency?: string;
}

interface SourceRow {
  provider: 'line';
  source_id: string;
  native_id: string;
  label: string | null;
  timezone: string;
  own_timezone: string | null;
  review_from: string;
  last_caught_up_at: number | null;
  last_error: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const SETTINGS_COLUMNS = 'base_currency, timezone, revision';

const SOURCE_COLUMNS = `
  s.provider AS provider,
  s.source_id AS source_id,
  s.native_id AS native_id,
  s.label AS label,
  COALESCE(s.timezone, o.timezone) AS timezone,
  s.timezone AS own_timezone,
  s.review_from AS review_from,
  s.last_caught_up_at AS last_caught_up_at,
  s.last_error AS last_error,
  s.revision AS revision,
  s.created_at AS created_at,
  s.updated_at AS updated_at`;

function toSource(row: SourceRow): LedgerSource {
  return {
    provider: row.provider,
    source_id: row.source_id,
    native_id: row.native_id,
    label: row.label,
    timezone: row.timezone,
    own_timezone: row.own_timezone,
    review_from: row.review_from,
    last_caught_up_at: row.last_caught_up_at,
    last_error: row.last_error === null
      ? null
      : (JSON.parse(row.last_error) as { code: string; message: string; at: number }),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sameTimezone(a: string, b: string): boolean {
  return normalizeTimezone(a, 'timezone') === normalizeTimezone(b, 'timezone');
}

export interface LedgerStoreOptions {
  /** Injected clock (epoch milliseconds); tests advance it for the idempotency window. */
  now?: () => number;
  /** Overrides the shipped step list (tests use a failing step). */
  steps?: readonly SchemaStep[];
}

/**
 * The owner-scoped ledger on `bank/bank.db`. It owns its own better-sqlite3
 * connection, separate from `CategoryStore`'s, applies the ordered schema
 * steps when it opens, and scopes every row and lookup by the owner (the
 * principal's subject).
 *
 * Inputs arrive already validated and normalised by the tool layer; the store
 * enforces the state rules (setup, revisions, conflicts) inside one SQLite
 * transaction per write.
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
  private get database(): Database.Database {
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

  getSettings(owner: string): LedgerSettings {
    return this.requireSettings(owner);
  }

  listSources(owner: string): { settings: LedgerSettings; sources: LedgerSource[] } {
    const settings = this.requireSettings(owner);
    const rows = this.database.prepare(`
      SELECT ${SOURCE_COLUMNS}
      FROM ledger_sources s
      JOIN ledger_owners o ON o.owner = s.owner
      WHERE s.owner = ?
      ORDER BY s.id ASC
    `).all(owner) as SourceRow[];
    return { settings, sources: rows.map(toSource) };
  }

  getSource(owner: string, provider: 'line', sourceId: string): { source: LedgerSource } {
    this.requireSettings(owner);
    return { source: this.requireSource(owner, provider, sourceId) };
  }

  addSource(owner: string, input: AddSourceInput, keys: WriteKeys): {
    settings: LedgerSettings;
    source: LedgerSource;
  } {
    const add = this.database.transaction((): { settings: LedgerSettings; source: LedgerSource } => {
      const now = this.now();
      let settings = this.findSettings(owner);

      if (!settings) {
        if (input.base_currency === undefined) {
          throw invalidArgument('base_currency', 'base_currency is required for the first source');
        }
        if (input.owner_timezone === undefined) {
          throw invalidArgument('owner_timezone', 'owner_timezone is required for the first source');
        }
        if (keys.expectedRevision !== undefined) {
          throw new LedgerError('conflict', 'No settings exist yet.', {
            details: { current_revision: null },
          });
        }
        this.database.prepare(
          `INSERT INTO ledger_owners (owner, base_currency, timezone, revision, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        ).run(owner, input.base_currency, input.owner_timezone, now, now);
        settings = {
          base_currency: input.base_currency,
          timezone: input.owner_timezone,
          revision: 1,
        };
      } else {
        if (input.base_currency !== undefined && input.base_currency !== settings.base_currency) {
          throw new LedgerError('conflict', 'The base currency cannot change once it is set.', {
            details: { current: settings.base_currency },
          });
        }
        if (input.owner_timezone !== undefined && !sameTimezone(input.owner_timezone, settings.timezone)) {
          throw new LedgerError('conflict', 'The owner timezone can only change with update_settings.', {
            action: 'Call manage_accounts with action update_settings and a timezone.',
            details: { current: settings.timezone },
          });
        }
        this.checkExpectedRevision(keys.expectedRevision, settings.revision);
      }

      const existing = this.findSource(owner, input.provider, input.source_id);
      if (existing) {
        throw new LedgerError('conflict', 'This source is already registered.', {
          details: { source: existing },
        });
      }

      const effectiveTimezone = input.timezone ?? settings.timezone;
      const reviewFrom = input.review_from ?? defaultReviewFrom(now, effectiveTimezone);
      this.database.prepare(
        `INSERT INTO ledger_sources
           (owner, provider, native_id, source_id, label, timezone, review_from, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        owner,
        input.provider,
        input.source_id,
        input.source_id,
        input.label ?? null,
        input.timezone ?? null,
        reviewFrom,
        now,
        now,
      );
      return { settings, source: this.requireSource(owner, input.provider, input.source_id) };
    });
    return add();
  }

  updateSettings(owner: string, patch: UpdateSettingsPatch, keys: WriteKeys): { settings: LedgerSettings } {
    const update = this.database.transaction((): { settings: LedgerSettings } => {
      const settings = this.requireSettings(owner);
      this.checkExpectedRevision(keys.expectedRevision, settings.revision);
      if (patch.timezone === undefined && patch.base_currency === undefined) {
        throw invalidArgument('action', 'update_settings needs a timezone or a base_currency');
      }
      if (patch.base_currency !== undefined && patch.base_currency !== settings.base_currency) {
        throw new LedgerError('conflict', 'The base currency cannot change once it is set.', {
          details: { current: settings.base_currency },
        });
      }
      const timezoneChanged = patch.timezone !== undefined && !sameTimezone(patch.timezone, settings.timezone);
      if (!timezoneChanged) {
        return { settings };
      }
      const now = this.now();
      this.database.prepare(
        `UPDATE ledger_owners
            SET timezone = ?, revision = revision + 1, updated_at = ?
          WHERE owner = ?`,
      ).run(patch.timezone, now, owner);
      return { settings: this.requireSettings(owner) };
    });
    return update();
  }

  updateSource(
    owner: string,
    provider: 'line',
    sourceId: string,
    patch: UpdateSourcePatch,
    keys: WriteKeys,
  ): { source: LedgerSource } {
    const update = this.database.transaction((): { source: LedgerSource } => {
      this.requireSettings(owner);
      const source = this.requireSource(owner, provider, sourceId);
      this.checkExpectedRevision(keys.expectedRevision, source.revision);

      if (patch.label === undefined && patch.timezone === undefined && patch.review_from === undefined) {
        throw invalidArgument('action', 'update_source needs a label, a timezone or a review_from');
      }

      const labelChanged = patch.label !== undefined && patch.label !== source.label;
      const timezoneChanged = patch.timezone !== undefined
        && (source.own_timezone === null
          ? patch.timezone !== null
          : patch.timezone === null || !sameTimezone(patch.timezone, source.own_timezone));
      const reviewFromChanged = patch.review_from !== undefined && patch.review_from !== source.review_from;

      if (!labelChanged && !timezoneChanged && !reviewFromChanged) {
        return { source };
      }

      const now = this.now();
      this.database.prepare(
        `UPDATE ledger_sources
            SET label = CASE WHEN ? THEN ? ELSE label END,
                timezone = CASE WHEN ? THEN ? ELSE timezone END,
                review_from = COALESCE(?, review_from),
                revision = revision + 1,
                updated_at = ?
          WHERE owner = ? AND provider = ? AND source_id = ?`,
      ).run(
        labelChanged ? 1 : 0,
        labelChanged ? patch.label : null,
        timezoneChanged ? 1 : 0,
        patch.timezone ?? null,
        reviewFromChanged ? patch.review_from : null,
        now,
        owner,
        provider,
        sourceId,
      );
      return { source: this.requireSource(owner, provider, sourceId) };
    });
    return update();
  }

  private findSettings(owner: string): LedgerSettings | undefined {
    return this.database
      .prepare(`SELECT ${SETTINGS_COLUMNS} FROM ledger_owners WHERE owner = ?`)
      .get(owner) as LedgerSettings | undefined;
  }

  private requireSettings(owner: string): LedgerSettings {
    const settings = this.findSettings(owner);
    if (!settings) {
      throw new LedgerError('setup_required', 'The ledger has no source yet.', { action: SETUP_ACTION });
    }
    return settings;
  }

  private findSource(owner: string, provider: 'line', sourceId: string): LedgerSource | undefined {
    const row = this.database.prepare(`
      SELECT ${SOURCE_COLUMNS}
      FROM ledger_sources s
      JOIN ledger_owners o ON o.owner = s.owner
      WHERE s.owner = ? AND s.provider = ? AND s.source_id = ?
    `).get(owner, provider, sourceId) as SourceRow | undefined;
    return row ? toSource(row) : undefined;
  }

  private requireSource(owner: string, provider: 'line', sourceId: string): LedgerSource {
    const source = this.findSource(owner, provider, sourceId);
    if (!source) {
      throw new LedgerError('not_found', 'No such source.', {
        details: { provider, source_id: sourceId },
      });
    }
    return source;
  }

  private checkExpectedRevision(expected: number | undefined, current: number): void {
    if (expected !== undefined && expected !== current) {
      throw new LedgerError('conflict', 'expected_revision does not match the current revision.', {
        details: { current_revision: current },
      });
    }
  }
}
