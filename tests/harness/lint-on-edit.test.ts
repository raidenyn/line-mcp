import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Plain ESM without declarations: the hook is a script, not part of the
// TypeScript build.
import { formatErrors, lintTarget, MAX_LINES } from '../../.claude/hooks/lint-on-edit.mjs';

const ROOT = resolve('.');
const HOOK = '.claude/hooks/lint-on-edit.mjs';

function runHook(payload: unknown) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000 });
}

describe('lint-on-edit target selection', () => {
  it('accepts TypeScript files inside the repository, absolute or relative', () => {
    expect(lintTarget({ tool_input: { file_path: join(ROOT, 'packages/server/src/cli.ts') } }, ROOT)).toBe(
      'packages/server/src/cli.ts',
    );
    expect(lintTarget({ cwd: ROOT, tool_input: { file_path: 'scripts/x.mts' } }, ROOT)).toBe('scripts/x.mts');
    // OpenCode's edit tools name the file `path`.
    expect(lintTarget({ cwd: ROOT, tool_input: { path: 'tests/a.test.ts' } }, ROOT)).toBe('tests/a.test.ts');
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
      expect(lintTarget({ cwd: ROOT, tool_input: { file_path: file } }, ROOT), file).toBeNull();
    }
    expect(lintTarget({ tool_input: {} }, ROOT)).toBeNull();
    expect(lintTarget(null, ROOT)).toBeNull();
  });
});

describe('lint-on-edit formatting', () => {
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
  });
});

describe('lint-on-edit hook script', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('exits 0 silently for payloads it does not own', () => {
    for (const input of ['{}', 'not json', JSON.stringify({ tool_input: { file_path: 'README.md' } })]) {
      const result = spawnSync('node', [HOOK], { input, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it('fixes what it can and exits 2 with the remaining errors on stderr', () => {
    // A fixture inside the repository so the repository ESLint config applies.
    dir = mkdtempSync(join(ROOT, 'tests/harness/.fixture-'));
    const file = join(dir, 'fixture.ts');
    writeFileSync(file, 'let fixable = 1;\nexport const used = fixable;\nconst unused = 2;\n');

    const result = runHook({ cwd: ROOT, tool_input: { file_path: file } });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/fixture\.ts:3:7 .*unused.*\(@typescript-eslint\/no-unused-vars\)/);
    expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(MAX_LINES);
    // `prefer-const` is auto-fixable, so --fix rewrote the file.
    expect(readFileSync(file, 'utf8')).toContain('const fixable = 1;');
  });

  it('exits 0 for a clean file', () => {
    dir = mkdtempSync(join(ROOT, 'tests/harness/.fixture-'));
    const file = join(dir, 'clean.ts');
    writeFileSync(file, 'export const clean = 1;\n');
    const result = runHook({ cwd: ROOT, tool_input: { file_path: file } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
