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
    expect(secretPath()).toBe('/d/secret');
  });

  it('authDir is <dataDir>/auth', async () => {
    process.env.DATA_DIR = '/d';
    const { authDir } = await import('./data-dir');
    expect(authDir()).toBe('/d/auth');
  });

  it('templatesDir is <dataDir>/templates', async () => {
    process.env.DATA_DIR = '/d';
    const { templatesDir } = await import('./data-dir');
    expect(templatesDir()).toBe('/d/templates');
  });

  it('cacheDbPath is <dataDir>/cache/messages.db', async () => {
    process.env.DATA_DIR = '/d';
    const { cacheDbPath } = await import('./data-dir');
    expect(cacheDbPath()).toBe('/d/cache/messages.db');
  });
});
