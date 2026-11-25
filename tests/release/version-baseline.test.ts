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

  it.each(manifests)('%s links internal packages with the workspace protocol', (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const section of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, range] of Object.entries(section ?? {})) {
        if (workspaceNames.has(name)) expect(range, `${path} ${name}`).toBe('workspace:^');
      }
    }
  });
});
