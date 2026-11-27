import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { CategoryStore } from '../category-store';
import { LEDGER_SCHEMA_STEPS, applySchemaSteps, type SchemaStep } from './schema';
import { LedgerError } from './errors';
import { IDEMPOTENCY_TTL_MS, SETUP_ACTION, LedgerStore } from './ledger-store';
import { requestHash } from './request-hash';

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

const NOW = Date.parse('2026-05-31T12:00:00Z');

function ledgerError(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    return error as LedgerError;
  }
  throw new Error('Expected a LedgerError');
}

function makeStore(now: () => number = () => NOW): LedgerStore {
  return new LedgerStore(':memory:', { now });
}

const ALICE = 'u-alice';
const BOB = 'u-bob';

describe('LedgerStore settings and sources', () => {
  it('answers setup_required before the first source', () => {
    const store = makeStore();
    try {
      const cases: Array<() => unknown> = [
        () => store.getSettings(ALICE),
        () => store.listSources(ALICE),
        () => store.getSource(ALICE, 'line', 'c-chat'),
        () => store.updateSource(ALICE, 'line', 'c-chat', { label: 'x' }, {}),
        () => store.updateSettings(ALICE, { timezone: 'UTC' }, {}),
      ];
      for (const fn of cases) {
        const error = ledgerError(fn);
        expect(error.code).toBe('setup_required');
        expect(error.action).toBe(SETUP_ACTION);
      }
    } finally {
      store.close();
    }
  });

  it('requires base_currency and owner_timezone for the first source', () => {
    const store = makeStore();
    try {
      const missingCurrency = ledgerError(() =>
        store.addSource(ALICE, { provider: 'line', source_id: 'c-chat', owner_timezone: 'UTC' }, {}),
      );
      expect(missingCurrency.code).toBe('invalid_argument');
      expect(missingCurrency.details).toMatchObject({ field: 'base_currency' });

      const missingTimezone = ledgerError(() =>
        store.addSource(ALICE, { provider: 'line', source_id: 'c-chat', base_currency: 'THB' }, {}),
      );
      expect(missingTimezone.code).toBe('invalid_argument');
      expect(missingTimezone.details).toMatchObject({ field: 'owner_timezone' });

      expect(ledgerError(() => store.getSettings(ALICE)).code).toBe('setup_required');
    } finally {
      store.close();
    }
  });

  it('creates settings and the source on the first addSource', () => {
    const store = makeStore();
    try {
      const { settings, source } = store.addSource(
        ALICE,
        {
          provider: 'line',
          source_id: 'c-chat',
          base_currency: 'THB',
          owner_timezone: 'Asia/Bangkok',
        },
        {},
      );
      expect(settings).toEqual({ base_currency: 'THB', timezone: 'Asia/Bangkok', revision: 1 });
      expect(source).toMatchObject({
        provider: 'line',
        source_id: 'c-chat',
        native_id: 'c-chat',
        label: null,
        timezone: 'Asia/Bangkok',
        own_timezone: null,
        review_from: '2026-02-28',
        last_caught_up_at: null,
        last_error: null,
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
      });
    } finally {
      store.close();
    }
  });

  it('refuses another base currency on addSource and updateSettings', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, {});

      const addConflict = ledgerError(() =>
        store.addSource(ALICE, {
          provider: 'line', source_id: 'c-two', base_currency: 'USD', owner_timezone: 'Asia/Bangkok',
        }, {}),
      );
      expect(addConflict.code).toBe('conflict');
      expect(addConflict.details).toMatchObject({ current: 'THB' });

      const updateConflict = ledgerError(() =>
        store.updateSettings(ALICE, { base_currency: 'USD' }, {}),
      );
      expect(updateConflict.code).toBe('conflict');
      expect(updateConflict.details).toMatchObject({ current: 'THB' });

      const accepted = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-two', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, {});
      expect(accepted.settings.base_currency).toBe('THB');
    } finally {
      store.close();
    }
  });

  it('refuses another owner_timezone on a later addSource', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, {});
      const error = ledgerError(() =>
        store.addSource(ALICE, {
          provider: 'line', source_id: 'c-two', base_currency: 'THB', owner_timezone: 'Europe/Berlin',
        }, {}),
      );
      expect(error.code).toBe('conflict');
      expect(error.action).toContain('update_settings');
      expect(store.getSettings(ALICE).timezone).toBe('Asia/Bangkok');
    } finally {
      store.close();
    }
  });

  it('refuses a duplicate source', () => {
    const store = makeStore();
    try {
      const input = { provider: 'line' as const, source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok' };
      store.addSource(ALICE, input, {});
      const error = ledgerError(() => store.addSource(ALICE, input, {}));
      expect(error.code).toBe('conflict');
      expect(error.details).toMatchObject({ source: { source_id: 'c-one' } });
    } finally {
      store.close();
    }
  });

  it('inherits the owner timezone until the source sets its own', () => {
    const store = makeStore();
    try {
      const added = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, {});
      expect(added.source.timezone).toBe('Asia/Bangkok');
      expect(added.source.own_timezone).toBeNull();

      const updated = store.updateSettings(ALICE, { timezone: 'Europe/Berlin' }, {});
      expect(updated.settings.timezone).toBe('Europe/Berlin');
      expect(store.getSource(ALICE, 'line', 'c-one').source).toMatchObject({
        timezone: 'Europe/Berlin', own_timezone: null,
      });

      const own = store.updateSource(ALICE, 'line', 'c-one', { timezone: 'Asia/Tokyo' }, {});
      expect(own.source).toMatchObject({ timezone: 'Asia/Tokyo', own_timezone: 'Asia/Tokyo' });

      const inherited = store.updateSource(ALICE, 'line', 'c-one', { timezone: null }, {});
      expect(inherited.source).toMatchObject({ timezone: 'Europe/Berlin', own_timezone: null });
    } finally {
      store.close();
    }
  });

  it('clears a label with null and round-trips odd text', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: 'Card "gold" 🥇',
      }, {});
      expect(store.getSource(ALICE, 'line', 'c-one').source.label).toBe('Card "gold" 🥇');
      const cleared = store.updateSource(ALICE, 'line', 'c-one', { label: null }, {});
      expect(cleared.source.label).toBeNull();
    } finally {
      store.close();
    }
  });

  it('keeps the revision on a no-op and raises it by 1 on a change', () => {
    let now = NOW;
    const store = new LedgerStore(':memory:', { now: () => now });
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: 'one',
      }, {});
      now += 1000;
      const noop = store.updateSource(ALICE, 'line', 'c-one', { label: 'one' }, {});
      expect(noop.source.revision).toBe(1);
      expect(noop.source.updated_at).toBe(NOW);

      now += 1000;
      const changed = store.updateSource(ALICE, 'line', 'c-one', { label: 'two' }, {});
      expect(changed.source.revision).toBe(2);
      expect(changed.source.updated_at).toBe(now);

      const settingsNoop = store.updateSettings(ALICE, { timezone: 'UTC' }, {});
      expect(settingsNoop.settings.revision).toBe(1);
      const settingsChanged = store.updateSettings(ALICE, { timezone: 'Europe/Berlin' }, {});
      expect(settingsChanged.settings.revision).toBe(2);
    } finally {
      store.close();
    }
  });

  it('checks expected_revision on every write', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: 'one',
      }, {});
      store.updateSource(ALICE, 'line', 'c-one', { label: 'two' }, {}); // revision 2

      const staleSource = ledgerError(() =>
        store.updateSource(ALICE, 'line', 'c-one', { label: 'three' }, { expectedRevision: 1 }),
      );
      expect(staleSource.code).toBe('conflict');
      expect(staleSource.details).toMatchObject({ current_revision: 2 });
      expect(store.getSource(ALICE, 'line', 'c-one').source.label).toBe('two');

      const staleSettings = ledgerError(() =>
        store.updateSettings(ALICE, { timezone: 'Asia/Tokyo' }, { expectedRevision: 2 }),
      );
      expect(staleSettings.code).toBe('conflict');
      expect(staleSettings.details).toMatchObject({ current_revision: 1 });
    } finally {
      store.close();
    }
  });

  it('refuses any expected_revision before settings exist', () => {
    const store = makeStore();
    try {
      const error = ledgerError(() =>
        store.addSource(ALICE, {
          provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
        }, { expectedRevision: 1 }),
      );
      expect(error.code).toBe('conflict');
      expect(error.details).toMatchObject({ current_revision: null });
      expect(ledgerError(() => store.getSettings(ALICE)).code).toBe('setup_required');
    } finally {
      store.close();
    }
  });

  it('scopes every lookup by owner', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-shared', base_currency: 'THB', owner_timezone: 'UTC', label: 'alice',
      }, {});
      store.addSource(BOB, {
        provider: 'line', source_id: 'c-shared', base_currency: 'USD', owner_timezone: 'UTC', label: 'bob',
      }, {});

      expect(store.getSource(ALICE, 'line', 'c-shared').source.label).toBe('alice');
      expect(store.getSource(BOB, 'line', 'c-shared').source.label).toBe('bob');

      const missing = ledgerError(() => store.getSource(BOB, 'line', 'c-alice-only'));
      expect(missing.code).toBe('not_found');

      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-alice-only', base_currency: 'THB', owner_timezone: 'UTC',
      }, {});
      const otherOwners = ledgerError(() => store.getSource(BOB, 'line', 'c-alice-only'));
      expect(otherOwners.code).toBe('not_found');
      expect(store.listSources(BOB).sources.map((source) => source.source_id)).toEqual(['c-shared']);
      expect(store.listSources(ALICE).sources.map((source) => source.source_id)).toEqual(['c-shared', 'c-alice-only']);
    } finally {
      store.close();
    }
  });

  it('refuses a second first-source with another currency through another store', () => {
    const { dir, path } = tempDbPath();
    const first = new LedgerStore(path, { now: () => NOW });
    const second = new LedgerStore(path, { now: () => NOW });
    try {
      first.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
      }, {});
      const error = ledgerError(() =>
        second.addSource(ALICE, {
          provider: 'line', source_id: 'c-two', base_currency: 'USD', owner_timezone: 'UTC',
        }, {}),
      );
      expect(error.code).toBe('conflict');
      expect(error.details).toMatchObject({ current: 'THB' });
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins a source when it is given the owner timezone explicitly', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, {});
      const pinned = store.updateSource(ALICE, 'line', 'c-one', { timezone: 'Asia/Bangkok' }, {});
      expect(pinned.source.own_timezone).toBe('Asia/Bangkok');
      expect(pinned.source.revision).toBe(2);

      store.updateSettings(ALICE, { timezone: 'Europe/Berlin' }, {});
      expect(store.getSource(ALICE, 'line', 'c-one').source).toMatchObject({
        timezone: 'Asia/Bangkok', own_timezone: 'Asia/Bangkok',
      });
    } finally {
      store.close();
    }
  });

  it('replays update_source once and keeps the first updated_at', () => {
    let now = NOW;
    const store = new LedgerStore(':memory:', { now: () => now });
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: 'one',
      }, {});
      now += 1000;
      const args = { action: 'update_source', provider: 'line', source_id: 'c-one', label: 'two' };
      const keys = { idempotencyKey: 'k', requestHash: requestHash(args) };
      const first = store.updateSource(ALICE, 'line', 'c-one', { label: 'two' }, keys);
      now += 1000;
      const replay = store.updateSource(ALICE, 'line', 'c-one', { label: 'two' }, keys);

      expect(replay).toEqual(first);
      expect(store.getSource(ALICE, 'line', 'c-one').source.revision).toBe(2);
      expect(store.getSource(ALICE, 'line', 'c-one').source.updated_at).toBe(NOW + 1000);
    } finally {
      store.close();
    }
  });

  it('replays a retried add_source instead of answering conflict', () => {
    const store = makeStore();
    try {
      const args = {
        action: 'add_source', provider: 'line', source_id: 'c-one',
      };
      const keys = { idempotencyKey: 'retry-me', requestHash: requestHash(args) };
      const first = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
      }, keys);
      const replay = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
      }, keys);
      expect(replay).toEqual(first);
      expect(store.listSources(ALICE).sources).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('refuses a reused key with other arguments and records only successes', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
      }, {});
      // A refused write (duplicate source) must not be recorded.
      const refusedKeys = {
        idempotencyKey: 'k', requestHash: requestHash({ action: 'add_source', source_id: 'c-one' }),
      };
      const refused = ledgerError(() => store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC',
      }, refusedKeys));
      expect(refused.code).toBe('conflict');
      const applied = store.updateSource(ALICE, 'line', 'c-one', { label: 'later' }, refusedKeys);
      expect(applied.source.label).toBe('later');

      const otherHash = ledgerError(() => store.updateSource(ALICE, 'line', 'c-one', { label: 'other' }, {
        idempotencyKey: 'k', requestHash: requestHash({ action: 'update_source', label: 'other' }),
      }));
      expect(otherHash.code).toBe('conflict');
      expect(otherHash.details).toMatchObject({ reason: 'idempotency_key_reused' });
      expect(store.getSource(ALICE, 'line', 'c-one').source.label).toBe('later');
    } finally {
      store.close();
    }
  });

  it('expires keys after 24 hours', () => {
    let now = NOW;
    const store = new LedgerStore(':memory:', { now: () => now });
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: 'one',
      }, {});
      const args = { action: 'update_source', label: 'two' };
      store.updateSource(ALICE, 'line', 'c-one', { label: 'two' }, {
        idempotencyKey: 'k', requestHash: requestHash(args),
      });
      now += IDEMPOTENCY_TTL_MS + 1;
      const applied = store.updateSource(ALICE, 'line', 'c-one', { label: 'three' }, {
        idempotencyKey: 'k', requestHash: requestHash({ action: 'update_source', label: 'three' }),
      });
      expect(applied.source.label).toBe('three');
      expect(applied.source.revision).toBe(3);
    } finally {
      store.close();
    }
  });

  it('keeps idempotency keys per owner', () => {
    const store = makeStore();
    try {
      store.addSource(ALICE, {
        provider: 'line', source_id: 'c-alice', base_currency: 'THB', owner_timezone: 'UTC',
      }, {});
      store.addSource(BOB, {
        provider: 'line', source_id: 'c-bob', base_currency: 'USD', owner_timezone: 'UTC',
      }, {});
      const args = { action: 'update_source', label: 'alice-label' };
      store.updateSource(ALICE, 'line', 'c-alice', { label: 'alice-label' }, {
        idempotencyKey: 'same-key', requestHash: requestHash(args),
      });
      const bobResult = store.updateSource(BOB, 'line', 'c-bob', { label: 'bob-label' }, {
        idempotencyKey: 'same-key', requestHash: requestHash({ action: 'update_source', label: 'bob-label' }),
      });
      expect(bobResult.source.label).toBe('bob-label');
    } finally {
      store.close();
    }
  });

  it('replays an add_source retry across midnight in the source timezone', () => {
    let now = Date.parse('2026-05-31T16:59:00Z'); // 23:59 in Bangkok
    const store = new LedgerStore(':memory:', { now: () => now });
    try {
      const args = {
        action: 'add_source', provider: 'line', source_id: 'c-one', owner_timezone: 'Asia/Bangkok',
      };
      const keys = { idempotencyKey: 'midnight', requestHash: requestHash(args) };
      const first = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, keys);
      now = Date.parse('2026-05-31T17:01:00Z'); // 00:01 in Bangkok
      const replay = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
      }, keys);
      expect(replay).toEqual(first);
      expect(replay.source.review_from).toBe('2026-02-28');
    } finally {
      store.close();
    }
  });

  it('defaults review_from in the source effective timezone and accepts an explicit date', () => {
    // 2026-06-01T15:30Z is 2026-06-02 00:30 in Asia/Tokyo.
    const tokyoStore = new LedgerStore(':memory:', { now: () => Date.parse('2026-06-01T15:30:00Z') });
    try {
      const { source } = tokyoStore.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', timezone: 'Asia/Tokyo',
      }, {});
      // Tokyo's 2 June minus three months is 2026-03-02.
      expect(source.review_from).toBe('2026-03-02');
    } finally {
      tokyoStore.close();
    }

    const store = makeStore();
    try {
      const { source } = store.addSource(ALICE, {
        provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', review_from: '2026-01-01',
      }, {});
      expect(source.review_from).toBe('2026-01-01');
    } finally {
      store.close();
    }
  });
});
