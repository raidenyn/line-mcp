import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Package-tree isolation check for the SQLite adapter split (issue #75,
// Task 6): the reusable core (@raidenyn/line-client) must stay free of any
// SQLite dependency, while this adapter package is exactly where
// better-sqlite3 is meant to live. See also the broader architecture graph
// test in tests/architecture/import-boundaries.test.ts.

function readManifest(pkgDir: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
}

describe('package tree: sqlite dependency isolation', () => {
  it('line-client-sqlite declares better-sqlite3 directly', () => {
    const manifest = readManifest(path.resolve(__dirname, '..'));
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    expect(Object.keys(deps)).toContain('better-sqlite3');
  });

  it('line-client excludes better-sqlite3 from its own manifest', () => {
    const manifest = readManifest(path.resolve(__dirname, '..', '..', 'line-client'));
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    expect(Object.keys(deps)).not.toContain('better-sqlite3');
  });
});
