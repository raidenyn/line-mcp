import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

describe('data-dir helpers', () => {
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('dataDir defaults to <cwd>/data', async () => {
    const { dataDir } = await import('./data-dir');
    expect(dataDir()).toBe(path.join(process.cwd(), 'data'));
  });

  it('dataDir returns DATA_DIR when set', async () => {
    process.env.DATA_DIR = '/custom/data';
    const { dataDir } = await import('./data-dir');
    expect(dataDir()).toBe('/custom/data');
  });

  it('secretPath is <dataDir>/secret', async () => {
    process.env.DATA_DIR = '/d';
    const { secretPath } = await import('./data-dir');
    expect(secretPath()).toBe(path.join('/d', 'secret'));
  });

  it('authDir is <dataDir>/auth', async () => {
    process.env.DATA_DIR = '/d';
    const { authDir } = await import('./data-dir');
    expect(authDir()).toBe(path.join('/d', 'auth'));
  });

  it('templatesDir is <dataDir>/templates', async () => {
    process.env.DATA_DIR = '/d';
    const { templatesDir } = await import('./data-dir');
    expect(templatesDir()).toBe(path.join('/d', 'templates'));
  });

  it('cacheDbPath is <dataDir>/cache/messages.db', async () => {
    process.env.DATA_DIR = '/d';
    const { cacheDbPath } = await import('./data-dir');
    expect(cacheDbPath()).toBe(path.join('/d', 'cache', 'messages.db'));
  });

  describe('explicit root overrides', () => {
    it('secretPath uses the explicit root instead of DATA_DIR', async () => {
      process.env.DATA_DIR = '/env-set';
      const { secretPath } = await import('./data-dir');
      expect(secretPath('/explicit')).toBe(path.join('/explicit', 'secret'));
    });

    it('authDir uses the explicit root instead of DATA_DIR', async () => {
      process.env.DATA_DIR = '/env-set';
      const { authDir } = await import('./data-dir');
      expect(authDir('/explicit')).toBe(path.join('/explicit', 'auth'));
    });

    it('templatesDir uses the explicit root instead of DATA_DIR', async () => {
      process.env.DATA_DIR = '/env-set';
      const { templatesDir } = await import('./data-dir');
      expect(templatesDir('/explicit')).toBe(path.join('/explicit', 'templates'));
    });

    it('cacheDbPath uses the explicit root instead of DATA_DIR', async () => {
      process.env.DATA_DIR = '/env-set';
      const { cacheDbPath } = await import('./data-dir');
      expect(cacheDbPath('/explicit')).toBe(path.join('/explicit', 'cache', 'messages.db'));
    });

    it('every helper falls back to dataDir() when no root is given, even with DATA_DIR unset', async () => {
      const { secretPath, authDir, templatesDir, cacheDbPath } = await import('./data-dir');
      const base = path.join(process.cwd(), 'data');
      expect(secretPath()).toBe(path.join(base, 'secret'));
      expect(authDir()).toBe(path.join(base, 'auth'));
      expect(templatesDir()).toBe(path.join(base, 'templates'));
      expect(cacheDbPath()).toBe(path.join(base, 'cache', 'messages.db'));
    });
  });
});
