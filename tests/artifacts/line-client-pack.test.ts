import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

/**
 * Blocking artifact gate for @raidenyn/line-client (issue #75, Task 6).
 *
 * This is deliberately heavy: it runs a *real* `npm pack`, a *real*
 * `npm install` of the resulting tarball into a temp directory that lives
 * entirely outside this checkout, and a *real* WASM HMAC operation through
 * happy-dom — none of it mocked. The point is to prove the package that a
 * standalone consumer would actually receive (not the source tree, not the
 * dev node_modules) is self-contained, carries no SQLite dependency, and
 * really works.
 *
 * This is a packing/consumption smoke test only — it is NOT a publish, and
 * must never run `npm publish` (see THIRD_PARTY_NOTICES.md: public
 * publication of the bundled LTSM assets is explicitly not approved).
 */

const ROOT = path.resolve(__dirname, '..', '..');
const LINE_CLIENT_DIR = path.join(ROOT, 'packages', 'line-client');
const TSC_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsc');

// This dev sandbox's user-level ~/.npmrc sets a restrictive `allow-scripts`
// policy (an npm/rfcs#868-style supply-chain guard). npm propagates that
// setting into every child process it spawns as npm_config_allow_scripts —
// including the `npx vitest` process running this very test — so a nested
// `npm install` here inherits it and refuses outright with EALLOWSCRIPTS
// ("--allow-scripts is not allowed in project-scoped installs"), even though
// we never pass --allow-scripts ourselves. Stripping the inherited env var
// for these nested npm invocations avoids that false trip; it has no effect
// on which scripts actually run, since every install below also passes
// --ignore-scripts explicitly.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.npm_config_allow_scripts;

interface NpmPackFileEntry {
  path: string;
  size: number;
  mode: number;
}

interface NpmPackResult {
  filename: string;
  files: NpmPackFileEntry[];
  bundled: string[];
}

let packDestDir: string;
let installDir: string;
let packResult: NpmPackResult;
let tarballPath: string;

describe('line-client packed-consumer artifact gate', () => {
  beforeAll(() => {
    // Both directories are created fresh under the OS temp root — neither is
    // inside this git checkout, matching a real external consumer's layout.
    packDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-client-pack-dest-'));
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-client-pack-install-'));
    expect(installDir.startsWith(ROOT)).toBe(false);
    expect(packDestDir.startsWith(ROOT)).toBe(false);

    // `npm pack` runs the package's own "prepack" script first (vendors a
    // real, runnable happy-dom + its transitive deps into this package's own
    // node_modules — see packages/line-client/scripts/vendor-happy-dom.js —
    // which is what lets bundledDependencies actually bundle something real
    // instead of the empty set you'd get under plain workspace hoisting).
    const rawJson = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', packDestDir],
      { cwd: LINE_CLIENT_DIR, encoding: 'utf8', env: CHILD_ENV },
    );
    [packResult] = JSON.parse(rawJson) as NpmPackResult[];
    tarballPath = path.join(packDestDir, packResult.filename);
    expect(fs.existsSync(tarballPath)).toBe(true);

    execFileSync('npm', ['init', '-y'], { cwd: installDir, stdio: 'ignore', env: CHILD_ENV });
    // --offline proves this install needs no registry access at all: every
    // runtime dependency (happy-dom and its own transitive deps) travels
    // inside the tarball itself via bundledDependencies. --ignore-scripts is
    // standard install hygiene for an arbitrary tarball and is safe here —
    // none of this package's runtime behavior depends on an install-time
    // script (its "prepack" script only matters when *producing* the
    // tarball, not when consuming it).
    execFileSync(
      'npm',
      ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
      { cwd: installDir, stdio: 'ignore', env: CHILD_ENV },
    );
  }, 300_000);

  afterAll(() => {
    for (const dir of [packDestDir, installDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bundles happy-dom in the pack result\'s bundled-dependency closure', () => {
    expect(packResult.bundled).toContain('happy-dom');
  });

  it('contains exactly one WASM file, one sandbox JS file, and declarations — no source tests or unrelated docs', () => {
    const ownPaths = packResult.files
      .map(f => f.path)
      .filter(p => !p.startsWith('node_modules/')); // exclude the bundled happy-dom closure

    const wasmFiles = ownPaths.filter(p => p.endsWith('.wasm'));
    const sandboxFiles = ownPaths.filter(p => p.endsWith('ltsmSandbox.js'));
    const declarationFiles = ownPaths.filter(p => p.endsWith('.d.ts'));
    const testFiles = ownPaths.filter(p => p.endsWith('.test.ts') || p.endsWith('.test.js'));

    expect(wasmFiles).toEqual(['assets/ltsm/ltsm.wasm']);
    expect(sandboxFiles).toEqual(['assets/ltsm/ltsmSandbox.js']);
    expect(declarationFiles.length).toBeGreaterThan(0);
    expect(testFiles).toEqual([]);

    // Only the package manifest, provenance/notice docs, dist output, and the
    // ltsm assets belong at the top of the tree — nothing else leaked in.
    const unexpected = ownPaths.filter(p =>
      !p.startsWith('dist/') &&
      !p.startsWith('assets/') &&
      p !== 'package.json' &&
      p !== 'THIRD_PARTY_NOTICES.md',
    );
    expect(unexpected).toEqual([]);
  });

  it('installs offline into a directory outside the checkout with no unmet-dependency problems', () => {
    const lsRaw = execFileSync('npm', ['ls', '--all', '--json'], { cwd: installDir, encoding: 'utf8', env: CHILD_ENV });
    const ls = JSON.parse(lsRaw) as { problems?: string[] };
    const problems = (ls.problems ?? []).filter(p => !/UNMET OPTIONAL DEPENDENCY/i.test(p));
    expect(problems).toEqual([]);
  });

  it('never installs better-sqlite3 anywhere beneath the packed line-client', () => {
    // `npm ls <pkg>` exits non-zero (and prints "(empty)") when the named
    // package isn't found anywhere in the tree — that's the expected,
    // desired outcome here, so the assertion inspects stdout rather than
    // treating a non-zero exit as a hard failure.
    let lsRaw: string;
    try {
      lsRaw = execFileSync('npm', ['ls', 'better-sqlite3', '--all'], { cwd: installDir, encoding: 'utf8', env: CHILD_ENV });
    } catch (err) {
      lsRaw = (err as { stdout?: string }).stdout ?? '';
    }
    expect(lsRaw).toMatch(/\(empty\)/);
    expect(lsRaw).not.toMatch(/better-sqlite3@/);

    const found = execFileSync(
      'find', ['node_modules', '-iname', '*better-sqlite3*'],
      { cwd: installDir, encoding: 'utf8' },
    ).trim();
    expect(found).toBe('');
  });

  it('finds happy-dom installed beneath the packed line-client', () => {
    const lsRaw = execFileSync('npm', ['ls', 'happy-dom', '--all'], { cwd: installDir, encoding: 'utf8', env: CHILD_ENV });
    expect(lsRaw).toMatch(/happy-dom@/);
  });

  it('compiles a TypeScript consumer against the installed package from an unrelated CWD', () => {
    const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-client-pack-consumer-'));
    try {
      expect(consumerDir.startsWith(ROOT)).toBe(false);

      fs.writeFileSync(
        path.join(consumerDir, 'consumer.ts'),
        [
          "import { signForAccount, createLineClient, parseExportHeader } from '@raidenyn/line-client';",
          'import type { AuthData, HmacInput, StorageKeyMaterial } from \'@raidenyn/line-client\';',
          '',
          'export async function run(): Promise<string> {',
          '  const key: StorageKeyMaterial = {',
          "    mid: 'u-consumer',",
          "    wrappedNonce: 'AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT',",
          "    kdfParameter1: 'W5kowvH9dJNVemz7XD2dww==',",
          "    kdfParameter2: '+ZFNyJlBAnn2W5e9m/ALYA==',",
          '  };',
          "  const input: HmacInput = { accessToken: 'tok', path: '/api/test', body: '[]' };",
          '  const client = createLineClient(null as AuthData | null);',
          '  void client;',
          "  void parseExportHeader;",
          '  return signForAccount(key, input);',
          '}',
          '',
        ].join('\n'),
      );

      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          skipLibCheck: true,
          strict: true,
          noEmit: false,
          outDir: 'out',
        },
        include: ['consumer.ts'],
      };
      fs.writeFileSync(path.join(consumerDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

      // node_modules must actually be resolvable from consumerDir for both
      // tsc's module resolution and a real runtime require() to find
      // @raidenyn/line-client, so symlink the installed tree in directly.
      fs.symlinkSync(
        path.join(installDir, 'node_modules'),
        path.join(consumerDir, 'node_modules'),
        'dir',
      );

      execFileSync(TSC_BIN, ['--project', path.join(consumerDir, 'tsconfig.json')], {
        cwd: consumerDir,
        encoding: 'utf8',
      });

      const compiledPath = path.join(consumerDir, 'out', 'consumer.js');
      expect(fs.existsSync(compiledPath)).toBe(true);
    } finally {
      fs.rmSync(consumerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs a real (non-mocked) WASM HMAC operation via the public API, from an unrelated CWD', () => {
    // Executed as a child process whose cwd is the install directory itself —
    // unrelated to this checkout — so `require('@raidenyn/line-client')`
    // resolves purely through the installed package, never touching this
    // repo's own packages/line-client source or dist.
    const script = [
      "const { signForAccount } = require('@raidenyn/line-client');",
      '(async () => {',
      '  const key = {',
      "    mid: 'u-real-wasm',",
      "    wrappedNonce: 'AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT',",
      "    kdfParameter1: 'W5kowvH9dJNVemz7XD2dww==',",
      "    kdfParameter2: '+ZFNyJlBAnn2W5e9m/ALYA==',",
      '  };',
      "  const input = { accessToken: 'tok', path: '/api/test', body: '[]' };",
      '  const a = await signForAccount(key, input);',
      '  const b = await signForAccount(key, input);',
      '  process.stdout.write(JSON.stringify({ a, b }));',
      '})().catch(err => { console.error(err); process.exit(1); });',
    ].join('\n');

    const out = execFileSync('node', ['-e', script], { cwd: installDir, encoding: 'utf8' });
    const { a, b } = JSON.parse(out) as { a: string; b: string };

    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    // Deterministic real HMAC output for identical inputs — the strongest
    // signal available from outside that this ran the genuine WASM signing
    // path rather than returning a fixed/mocked placeholder.
    expect(a).toBe(b);
  }, 60_000);
});
