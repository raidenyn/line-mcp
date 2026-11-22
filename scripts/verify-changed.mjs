/* global console, process -- Node globals are not declared for this script */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The fast rung is restricted to the in-process suites: smoke, Docker and
// packaging need a build or a daemon and belong to `verify` / `verify:all`.
const UNIT_PATHS = ['packages', 'tests/architecture', 'tests/release'];

/**
 * Pick the TypeScript files to lint from `git diff --name-only` output plus
 * untracked paths. Deleted files are already excluded by the caller's
 * `--diff-filter`; keeping this pure lets the selection be unit-tested.
 *
 * @param {string} trackedOutput
 * @param {string} untrackedOutput
 * @returns {string[]}
 */
export function selectLintTargets(trackedOutput, untrackedOutput) {
  const targets = new Set();
  for (const line of `${trackedOutput}\n${untrackedOutput}`.split('\n')) {
    const file = line.trim();
    if (file.endsWith('.ts')) targets.add(file);
  }
  return [...targets];
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout;
}

function resolveBase() {
  for (const ref of ['origin/main', 'main']) {
    const base = git(['merge-base', ref, 'HEAD']);
    if (base?.trim()) return base.trim();
  }
  // A checkout without main history still gets an inner loop against HEAD.
  return git(['rev-parse', 'HEAD'])?.trim() || null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status ?? 1;
}

function main() {
  const base = resolveBase();
  if (!base) {
    console.error('verify:changed: cannot resolve a git base commit');
    process.exit(1);
  }

  const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', base, '--']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--']);
  if (tracked === null || untracked === null) {
    console.error('verify:changed: git could not list changed files');
    process.exit(1);
  }

  const lintTargets = selectLintTargets(tracked, untracked).filter((file) => existsSync(file));
  if (lintTargets.length === 0) {
    console.log('verify:changed: no changed TypeScript files');
    return;
  }

  console.log(`verify:changed: linting ${lintTargets.length} changed TypeScript file(s)`);
  const lintStatus = run('npx', ['--no-install', 'eslint', ...lintTargets]);
  if (lintStatus !== 0) process.exit(lintStatus);

  process.exit(
    run('npx', [
      '--no-install',
      'vitest',
      'run',
      '--changed',
      base,
      '--reporter=dot',
      '--passWithNoTests',
      ...UNIT_PATHS,
    ]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
