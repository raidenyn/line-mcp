import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse } from 'yaml';
import * as ts from 'typescript';

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
  it('is configured as a private pnpm workspace containing packages/*', () => {
    const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(rootManifest.private).toBe(true);
    expect(rootManifest.workspaces).toBeUndefined();
    const workspaceFile = path.join(ROOT, 'pnpm-workspace.yaml');
    expect(fs.existsSync(workspaceFile)).toBe(true);
    const workspace = parse(fs.readFileSync(workspaceFile, 'utf-8')) as { packages?: string[] };
    expect(workspace.packages).toEqual(['packages/*']);
  });

  it('has a single root pnpm-lock.yaml', () => {
    for (const dir of PACKAGE_DIRS) {
      for (const lockfile of ['pnpm-lock.yaml', 'package-lock.json']) {
        expect(fs.existsSync(path.join(PACKAGES_DIR, dir, lockfile)), `${dir}/${lockfile}`).toBe(false);
      }
    }
    expect(fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(false);
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

// ─── Ledger import boundary (expense-ledger M1 task 2) ──────────────────────
//
// Nothing under packages/bank-mcp/src/ledger/, nor any file it reaches through
// relative imports, may import @raidenyn/line-client (or a subpath). The
// package-level IMPORT_RE above cannot express this: it allows bank-mcp as a
// whole to use line-client, and it matches package names only.

interface BoundaryViolation {
  file: string;
  chain: string[];
}

/** Every module specifier of an import, export-from, dynamic import or require. */
function importSpecifiers(fileName: string, content: string): string[] {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const add = (expression: ts.Expression | undefined): void => {
    if (expression !== undefined && ts.isStringLiteralLike(expression)) found.push(expression.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(found)];
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates: string[] = [];
  // Node16-style source imports name the emitted `.js` file; the checker reads
  // TypeScript source, so look for the matching `.ts` first.
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  candidates.push(`${base}.ts`, path.join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Reports every file reached from `dir` (through relative imports) that
 * imports @raidenyn/line-client or a subpath, with the import chain.
 */
function ledgerBoundaryViolations(dir: string): BoundaryViolation[] {
  const roots = listSourceFiles(dir);
  const violations: BoundaryViolation[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = roots.map((file) => ({ file, chain: [file] }));

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const content = fs.readFileSync(file, 'utf-8');
    for (const specifier of importSpecifiers(file, content)) {
      if (/^@raidenyn\/line-client(\/|$)/.test(specifier)) {
        violations.push({ file, chain });
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelative(file, specifier);
      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }
  return violations;
}

describe('bank-mcp ledger import boundary', () => {
  const ledgerDir = path.join(PACKAGES_DIR, 'bank-mcp', 'src', 'ledger');

  it('exists, has .ts files and reports no line-client import', () => {
    expect(fs.existsSync(ledgerDir)).toBe(true);
    expect(listSourceFiles(ledgerDir).length).toBeGreaterThan(0);
    expect(ledgerBoundaryViolations(ledgerDir)).toEqual([]);
  });

  const cases: Array<{ label: string; files: Record<string, string>; expected: string }> = [
    {
      label: 'a direct import',
      files: { 'checked/a.ts': "import { x } from '@raidenyn/line-client';\n" },
      expected: 'a.ts',
    },
    {
      label: 'an import type',
      files: { 'checked/a.ts': "import type { M } from '@raidenyn/line-client';\n" },
      expected: 'a.ts',
    },
    {
      label: 'an export from',
      files: { 'checked/a.ts': "export { y } from '@raidenyn/line-client';\n" },
      expected: 'a.ts',
    },
    {
      label: 'a subpath import',
      files: { 'checked/a.ts': "import '@raidenyn/line-client/dist/client';\n" },
      expected: 'a.ts',
    },
    {
      label: 'a comment before the module literal',
      files: { 'checked/a.ts': "import /* comment */ '@raidenyn/line-client';\n" },
      expected: 'a.ts',
    },
    {
      label: 'an indirect relative import',
      files: {
        'checked/a.ts': "import { z } from '../outside';\n",
        'outside.ts': "import { M } from '@raidenyn/line-client';\n",
      },
      expected: 'outside.ts',
    },
    {
      label: 'an indirect relative .js import that resolves to TypeScript',
      files: {
        'checked/a.ts': "import { z } from '../outside.js';\n",
        'outside.ts': "import { M } from '@raidenyn/line-client';\n",
      },
      expected: 'outside.ts',
    },
  ];

  it.each(cases)('reports $label', ({ files, expected }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-boundary-'));
    try {
      for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      const violations = ledgerBoundaryViolations(path.join(root, 'checked'));
      expect(violations).toHaveLength(1);
      expect(violations[0].file.endsWith(expected)).toBe(true);
      expect(violations[0].chain[0].endsWith(path.join('checked', 'a.ts'))).toBe(true);
      expect(violations[0].chain[violations[0].chain.length - 1]).toBe(violations[0].file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
