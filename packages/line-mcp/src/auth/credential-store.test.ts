import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AuthData } from '@raidenyn/line-client';

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

const TEST_AUTH: AuthData = {
  accessToken: 'stale-access-token',
  refreshToken: 'stale-refresh-token',
  certificate: 'test-cert',
  mid: 'u1234567890test',
  wrappedNonce: 'test-nonce',
  kdfParameter1: 'test-kdf1',
  kdfParameter2: 'test-kdf2',
};

const FRESH_AUTH: AuthData = {
  ...TEST_AUTH,
  accessToken: 'fresh-access-token',
  refreshToken: 'fresh-refresh-token',
};

// The credential-store standalone helpers default their store directory to
// `<DATA_DIR|cwd/data>/auth`, resolved lazily. Re-importing the module between
// tests gives each test a clean module instance bound to its own DATA_DIR.
describe('stored auth records', () => {
  let tmpdir: string;
  let mod: typeof import('./credential-store');

  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-cred-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpdir;
    mod = await import('./credential-store');
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('atomically writes a complete record with displayName and restrictive modes', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    const dir = path.join(tmpdir, 'auth');
    const file = path.join(dir, `${TEST_AUTH.mid}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...TEST_AUTH,
      displayName: 'Personal LINE',
    });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([`${TEST_AUTH.mid}.json`]);
  });

  it('preserves an existing displayName when refreshed credentials omit it', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    mod.persistAuthData(FRESH_AUTH);

    expect(mod.loadStoredAuthRecord(TEST_AUTH.mid)).toEqual({
      ...FRESH_AUTH,
      displayName: 'Personal LINE',
    });
  });

  it('throws without replacing the previous record when rename fails', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    expect(() => mod.persistAuthData(FRESH_AUTH)).toThrow('rename denied');
    expect(mod.loadStoredAuthRecord(TEST_AUTH.mid)?.accessToken).toBe(TEST_AUTH.accessToken);
    expect(fs.readdirSync(path.join(tmpdir, 'auth'))).toEqual([`${TEST_AUTH.mid}.json`]);
  });

  it('lists valid legacy and named records while isolating invalid files', () => {
    const dir = path.join(tmpdir, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST_AUTH.mid}.json`), JSON.stringify(TEST_AUTH));
    fs.writeFileSync(path.join(dir, 'u-second.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-second',
      displayName: 'Work LINE',
    }));
    fs.writeFileSync(path.join(dir, 'u-corrupt.json'), '{');
    fs.writeFileSync(path.join(dir, 'u-incomplete.json'), JSON.stringify({ mid: 'u-incomplete' }));
    fs.writeFileSync(path.join(dir, 'u-mismatch.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-other',
    }));
    fs.writeFileSync(path.join(dir, 'u-empty-name.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-empty-name',
      displayName: '',
    }));

    expect(mod.listStoredAuthRecords().map(record => record.mid).sort()).toEqual([
      TEST_AUTH.mid,
      'u-second',
    ].sort());
  });

  describe('inventoryStoredAuthRecords', () => {
    it('reports every invalid file with a structural reason instead of dropping it', () => {
      const dir = path.join(tmpdir, 'auth');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${TEST_AUTH.mid}.json`), JSON.stringify(TEST_AUTH));
      fs.writeFileSync(path.join(dir, 'u-second.json'), JSON.stringify({
        ...TEST_AUTH,
        mid: 'u-second',
        displayName: 'Work LINE',
      }));
      fs.writeFileSync(path.join(dir, 'u-corrupt.json'), '{');
      fs.writeFileSync(path.join(dir, 'u-incomplete.json'), JSON.stringify({ mid: 'u-incomplete' }));
      fs.writeFileSync(path.join(dir, 'u-mismatch.json'), JSON.stringify({
        ...TEST_AUTH,
        mid: 'u-other',
      }));
      fs.writeFileSync(path.join(dir, 'u-empty-name.json'), JSON.stringify({
        ...TEST_AUTH,
        mid: 'u-empty-name',
        displayName: '',
      }));

      const inventory = mod.inventoryStoredAuthRecords(dir);

      expect(inventory.valid.map(v => v.mid).sort()).toEqual([TEST_AUTH.mid, 'u-second'].sort());
      expect(inventory.valid.every(v => typeof v.path === 'string' && v.path.length > 0)).toBe(true);
      expect(inventory.invalid.map(i => i.path.split(path.sep).pop()).sort()).toEqual([
        'u-corrupt.json',
        'u-empty-name.json',
        'u-incomplete.json',
        'u-mismatch.json',
      ].sort());
      for (const entry of inventory.invalid) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      const serializedReasons = JSON.stringify(inventory.invalid.map(i => i.reason));
      expect(serializedReasons).not.toContain(TEST_AUTH.accessToken);
      expect(serializedReasons).not.toContain(TEST_AUTH.refreshToken);
      expect(serializedReasons).not.toContain(TEST_AUTH.certificate);
      expect(serializedReasons).not.toContain(TEST_AUTH.wrappedNonce);
    });

    it('returns empty valid/invalid arrays when the directory does not exist', () => {
      const inventory = mod.inventoryStoredAuthRecords(path.join(tmpdir, 'does-not-exist'));
      expect(inventory).toEqual({ valid: [], invalid: [] });
    });

    it('agrees with listStoredAuthRecords on which records are valid', () => {
      const dir = path.join(tmpdir, 'auth');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${TEST_AUTH.mid}.json`), JSON.stringify(TEST_AUTH));
      fs.writeFileSync(path.join(dir, 'u-bad.json'), JSON.stringify({ mid: 'u-bad' }));

      const inventory = mod.inventoryStoredAuthRecords(dir);
      const listed = mod.listStoredAuthRecords(dir);
      expect(inventory.valid.map(v => v.mid).sort()).toEqual(listed.map(r => r.mid).sort());
      expect(inventory.invalid).toHaveLength(1);
    });
  });

  it('rejects unsafe MIDs and non-string auth fields', () => {
    expect(mod.loadStoredAuthRecord('../escape')).toBeNull();
    const dir = path.join(tmpdir, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'u-bad.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-bad',
      certificate: 42,
    }));
    expect(mod.loadStoredAuthRecord('u-bad')).toBeNull();
  });

  it('strips selector metadata when loading a stored record', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');

    const loaded = mod.loadAuthFromDisk(TEST_AUTH.mid);

    expect(loaded).toEqual(TEST_AUTH);
    expect(loaded).not.toHaveProperty('displayName');
  });
});