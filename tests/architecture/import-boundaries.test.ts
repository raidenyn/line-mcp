import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Enforces the workspace dependency graph from issue #75 (modular-workspaces).
 *
 * Two independent signals are checked for every package:
 *   1. declared workspace dependencies in package.json ("@raidenyn/*" keys in
 *      dependencies/devDependencies/peerDependencies)
 *   2. actual `import ... from '@raidenyn/*'` / `require('@raidenyn/*')`
 *      statements found by scanning that package's src/**\/*.ts files
 *
 * Both must stay within the `allowed` graph below. This is a static, pure-fs
 * test — it never imports the packages themselves, so it works even when a
 * package is still an empty scaffold.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const allowed: Record<string, string[]> = {
  '@raidenyn/line-client': [],
  '@raidenyn/line-client-sqlite': ['@raidenyn/line-client'],
  '@raidenyn/mcp-runtime': [],
  '@raidenyn/line-mcp': [
    '@raidenyn/line-client',
    '@raidenyn/line-client-sqlite',
    '@raidenyn/mcp-runtime',
  ],
  '@raidenyn/bank-mcp': ['@raidenyn/line-client', '@raidenyn/mcp-runtime'],
  '@raidenyn/server': [
    '@raidenyn/line-client',
    '@raidenyn/line-client-sqlite',
    '@raidenyn/mcp-runtime',
    '@raidenyn/line-mcp',
    '@raidenyn/bank-mcp',
  ],
};

const PACKAGE_DIRS = [
  'line-client',
  'line-client-sqlite',
  'mcp-runtime',
  'line-mcp',
  'bank-mcp',
  'server',
];

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(dir: string): PackageManifest {
  const manifestPath = path.join(PACKAGES_DIR, dir, 'package.json');
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw) as PackageManifest;
}

function allDeclaredDeps(manifest: PackageManifest): Record<string, string> {
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
}

function declaredWorkspaceDeps(manifest: PackageManifest): string[] {
  return Object.keys(allDeclaredDeps(manifest)).filter((name) => name.startsWith('@raidenyn/'));
}

/** Recursively lists every .ts file under dir (skips node_modules/dist). */
function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Matches the quoted module specifier itself rather than anchoring on preceding
// `import`/`from`/`require(` syntax, so it also catches bare side-effect imports
// (`import '@raidenyn/x';`), dynamic `import('@raidenyn/x')`, and `export ... from`.
const IMPORT_RE = /['"](@raidenyn\/[a-zA-Z0-9_-]+)['"]/g;

/** Scans a package's src tree for imports/requires of other @raidenyn/* packages. */
function importedWorkspacePackages(pkgDir: string): Set<string> {
  const srcDir = path.join(PACKAGES_DIR, pkgDir, 'src');
  const found = new Set<string>();
  for (const file of listSourceFiles(srcDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      found.add(match[1]);
    }
  }
  return found;
}

describe('workspace root', () => {
  it('is configured as a private npm workspace containing packages/*', () => {
    const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(rootManifest.private).toBe(true);
    expect(rootManifest.workspaces).toEqual(['packages/*']);
  });

  it('has no package-local lockfiles (single root package-lock.json)', () => {
    for (const dir of PACKAGE_DIRS) {
      const lockPath = path.join(PACKAGES_DIR, dir, 'package-lock.json');
      expect(fs.existsSync(lockPath)).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(true);
  });
});

describe.each(PACKAGE_DIRS)('package %s', (dir) => {
  it('has a manifest whose name matches the allowed graph', () => {
    const manifest = readManifest(dir);
    expect(manifest.name in allowed).toBe(true);
  });

  it('declares only workspace dependencies present in the allowed graph', () => {
    const manifest = readManifest(dir);
    const declared = declaredWorkspaceDeps(manifest);
    const permitted = allowed[manifest.name] ?? [];
    for (const dep of declared) {
      expect(permitted, `${manifest.name} declares disallowed workspace dependency ${dep}`).toContain(dep);
    }
  });

  it('only imports workspace packages present in the allowed graph', () => {
    const manifest = readManifest(dir);
    const imported = importedWorkspacePackages(dir);
    const permitted = allowed[manifest.name] ?? [];
    for (const dep of imported) {
      expect(permitted, `${manifest.name} imports disallowed workspace package ${dep}`).toContain(dep);
    }
  });
});

describe('extra prohibitions', () => {
  it('line-client never depends on better-sqlite3', () => {
    const manifest = readManifest('line-client');
    const deps = allDeclaredDeps(manifest);
    expect(Object.keys(deps)).not.toContain('better-sqlite3');
  });

  it('mcp-runtime never depends on (or imports) a product MCP package', () => {
    const manifest = readManifest('mcp-runtime');
    const deps = Object.keys(allDeclaredDeps(manifest));
    const imported = importedWorkspacePackages('mcp-runtime');
    const forbidden = ['@raidenyn/line-mcp', '@raidenyn/bank-mcp', '@raidenyn/server'];
    for (const name of forbidden) {
      expect(deps).not.toContain(name);
      expect(imported.has(name)).toBe(false);
    }
  });

  it('bank-mcp never depends on or imports line-mcp', () => {
    const manifest = readManifest('bank-mcp');
    const deps = Object.keys(allDeclaredDeps(manifest));
    const imported = importedWorkspacePackages('bank-mcp');
    expect(deps).not.toContain('@raidenyn/line-mcp');
    expect(imported.has('@raidenyn/line-mcp')).toBe(false);
  });

  it('line-mcp never depends on or imports bank-mcp', () => {
    const manifest = readManifest('line-mcp');
    const deps = Object.keys(allDeclaredDeps(manifest));
    const imported = importedWorkspacePackages('line-mcp');
    expect(deps).not.toContain('@raidenyn/bank-mcp');
    expect(imported.has('@raidenyn/bank-mcp')).toBe(false);
  });
});
