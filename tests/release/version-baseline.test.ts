import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifests = [
  'package.json',
  'packages/bank-mcp/package.json',
  'packages/line-client-sqlite/package.json',
  'packages/line-client/package.json',
  'packages/line-mcp/package.json',
  'packages/mcp-runtime/package.json',
  'packages/server/package.json',
];
const workspaceNames = new Set(manifests.slice(1).map((path) => {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name: string };
  return manifest.name;
}));

describe('0.1.0 version baseline', () => {
  it.each(manifests)('%s has the baseline version', (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
    expect(manifest.version).toBe('0.1.0');
  });

  it.each(manifests)('%s uses the baseline internal ranges', (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (workspaceNames.has(name)) expect(range).toBe('^0.1.0');
    }
  });

  it('records root and workspace versions in the lockfile', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe('0.1.0');
    expect(lock.packages[''].version).toBe('0.1.0');
    for (const path of manifests.slice(1)) {
      expect(lock.packages[path.replace('/package.json', '')].version).toBe('0.1.0');
    }
  });
});
