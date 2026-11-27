import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Plain ESM without declarations: the edit lint is a script, not part of the
// TypeScript build.
import { formatErrors, lintEditedFile, lintFile, lintTarget, MAX_LINES } from '../../scripts/lint-file.mjs';

const ROOT = resolve('.');

describe('edit lint target selection', () => {
  it('accepts TypeScript files inside the repository, absolute or relative', () => {
    expect(lintTarget(join(ROOT, 'packages/server/src/cli.ts'), ROOT)).toBe('packages/server/src/cli.ts');
    expect(lintTarget('scripts/x.mts', ROOT)).toBe('scripts/x.mts');
    expect(lintTarget('tests/a.test.ts', ROOT, ROOT)).toBe('tests/a.test.ts');
  });

  it('resolves a checkout reached through a symlink', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'lint-hook-')), 'repo');
    try {
      symlinkSync(ROOT, link);
      expect(lintTarget(join(link, 'packages/server/src/cli.ts'), link)).toBe('packages/server/src/cli.ts');
      // The script's root is the real path; the caller may use the link.
      expect(lintTarget('packages/new-file.ts', ROOT, link)).toBe('packages/new-file.ts');
    } finally {
      rmSync(resolve(link, '..'), { recursive: true, force: true });
    }
  });

  it('skips other files, dist, node_modules, LTSM assets and paths outside the repository', () => {
    for (const file of [
      'README.md',
      'scripts/verify-changed.mjs',
      'packages/server/dist/cli.d.ts',
      'node_modules/foo/index.ts',
      'packages/line-client/assets/ltsm/x.ts',
      '../outside.ts',
      '/etc/x.ts',
    ]) {
      expect(lintTarget(file, ROOT), file).toBeNull();
    }
    expect(lintTarget(undefined, ROOT)).toBeNull();
    expect(lintTarget('', ROOT)).toBeNull();
  });
});

describe('edit lint formatting', () => {
  const message = (line: number) => ({ line, column: 7, severity: 2, message: `bad ${line}`, ruleId: 'no-x' });

  it('reports errors only, one compact line each', () => {
    const json = JSON.stringify([
      { messages: [message(3), { line: 1, column: 1, severity: 1, message: 'warn', ruleId: 'w' }] },
    ]);
    expect(formatErrors(json, 'a.ts')).toEqual([
      'ESLint: 1 error(s) remain in a.ts after --fix. Fix them now:',
      'a.ts:3:7 bad 3 (no-x)',
    ]);
    expect(formatErrors(JSON.stringify([{ messages: [] }]), 'a.ts')).toEqual([]);
    expect(formatErrors('not json', 'a.ts')).toEqual([]);
  });

  it(`caps the feedback at ${MAX_LINES} lines`, () => {
    const json = JSON.stringify([{ messages: Array.from({ length: 50 }, (_, i) => message(i + 1)) }]);
    const lines = formatErrors(json, 'a.ts');
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.at(-1)).toContain('32 more');
    expect(lines.at(-1)).toContain('run `pnpm exec eslint a.ts`');
  });
});

describe('edit lint of one file', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A fixture inside the repository so the repository ESLint config applies.
  function fixture(name: string, text: string) {
    dir = mkdtempSync(join(ROOT, 'tests/harness/.fixture-'));
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  }

  it('passes silently for files it does not own', () => {
    for (const file of [undefined, '', 'README.md', 'tests/harness/.fixture-missing/x.ts']) {
      expect(lintEditedFile(file, ROOT), String(file)).toEqual({ code: 0, output: '' });
    }
  });

  it('fixes what it can and fails with the remaining errors and the rewrite note', () => {
    const file = fixture('fixture.ts', 'let fixable = 1;\nexport const used = fixable;\nconst unused = 2;\n');
    const result = lintEditedFile(file, ROOT);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/fixture\.ts:3:7 .*unused.*\(@typescript-eslint\/no-unused-vars\)/);
    expect(result.output.trim().split('\n').length).toBeLessThanOrEqual(MAX_LINES);
    // `prefer-const` is auto-fixable, so --fix rewrote the file and says so.
    expect(readFileSync(file, 'utf8')).toContain('const fixable = 1;');
    expect(result.output).toMatch(/ESLint --fix rewrote .*fixture\.ts; re-read it/);
  });

  it('passes with only the rewrite note when --fix cleans the file', () => {
    const file = fixture('fixable.ts', 'let fixable = 1;\nexport const used = fixable;\n');
    const result = lintEditedFile(file, ROOT);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^ESLint --fix rewrote .*fixable\.ts; re-read it before editing it again\.\n$/);
  });

  it('passes silently for a clean file', () => {
    const file = fixture('clean.ts', 'export const clean = 1;\n');
    expect(lintEditedFile(file, ROOT)).toEqual({ code: 0, output: '' });
  });

  it('does not judge an edit when ESLint itself fails or is killed', () => {
    const file = fixture('crash.ts', 'export const crash = 1;\n');
    const rel = file.slice(ROOT.length + 1);
    for (const outcome of [{ status: 2 }, { status: null, signal: 'SIGTERM' }]) {
      const spawn = (() => ({ stdout: '', stderr: 'boom', ...outcome })) as unknown as Parameters<typeof lintFile>[2];
      expect(lintFile(rel, ROOT, spawn)).toEqual({ errors: [], fixed: false });
    }
  });
});
