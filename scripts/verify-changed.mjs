/* global console, process -- Node globals are not declared for this script */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The fast rung is restricted to the in-process suites: smoke, Docker and
// packaging need a build or a daemon and belong to `verify` / `verify:all`.
const UNIT_PATHS = ['packages', 'tests/architecture', 'tests/release', 'tests/harness'];
// Everything `eslint .` lints, so a changed script is checked by the inner loop.
const LINTABLE = /\.(?:c|m)?[jt]s$/;

/**
 * Pick the JS/TS files to lint from NUL-delimited `git` output. Keeping this
 * pure lets the selection be unit-tested; callers drop deleted files.
 *
 * @param {string} trackedOutput
 * @param {string} untrackedOutput
 * @returns {string[]}
 */
export function selectLintTargets(trackedOutput, untrackedOutput) {
  const targets = new Set();
  for (const file of `${trackedOutput}\0${untrackedOutput}`.split('\0')) {
    if (LINTABLE.test(file)) targets.add(file);
  }
  return [...targets];
}

/**
 * @param {string} trackedOutput
 * @param {string} untrackedOutput
 * @returns {boolean}
 */
export function hasChangedFiles(trackedOutput, untrackedOutput) {
  return `${trackedOutput}\0${untrackedOutput}`.split('\0').some((file) => file.length > 0);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * Find the commit the diff is measured against. `origin/main` is preferred; a
 * checkout without main history falls back to HEAD, which the caller warns
 * about because it ignores committed branch work. `runGit` is injectable for
 * the unit test.
 *
 * @param {(args: string[]) => string | null} [runGit]
 * @returns {{ base: string, ref: string, fallback: boolean } | null}
 */
export function resolveBase(runGit = git) {
  for (const ref of ['origin/main', 'main']) {
    const base = runGit(['merge-base', ref, 'HEAD']);
    if (base?.trim()) return { base: base.trim(), ref, fallback: false };
  }
  const head = runGit(['rev-parse', 'HEAD'])?.trim();
  return head ? { base: head, ref: 'HEAD', fallback: true } : null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status ?? 1;
}

function main() {
  const resolved = resolveBase();
  if (!resolved) {
    console.error('verify:changed: cannot resolve a git base commit');
    process.exit(1);
  }
  if (resolved.fallback) {
    console.error(
      `verify:changed: warning: no origin/main or main ref; comparing against ${resolved.ref}`,
    );
  }

  // `-z` keeps non-ASCII and unusual names intact instead of quoting them.
  const tracked = git(['diff', '--name-only', '-z', resolved.base, '--']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--']);
  if (tracked === null || untracked === null) {
    console.error('verify:changed: git could not list changed files');
    process.exit(1);
  }

  if (!hasChangedFiles(tracked, untracked)) {
    console.log('verify:changed: no changed files');
    return;
  }

  const lintTargets = selectLintTargets(tracked, untracked).filter((file) => existsSync(file));
  if (lintTargets.length > 0) {
    console.log(`verify:changed: linting ${lintTargets.length} changed file(s)`);
    const lintStatus = run('npx', ['--no-install', 'eslint', ...lintTargets]);
    if (lintStatus !== 0) process.exit(lintStatus);

    // Workspace packages resolve each other through compiled dist, so Vitest's
    // import graph cannot reach tests in other packages from a src change.
    const packageSources = lintTargets.filter(
      (file) => /^packages\/[^/]+\/src\//.test(file) && !/\.test\.[cm]?[jt]s$/.test(file),
    );
    if (packageSources.length > 0) {
      console.error(
        'verify:changed: note: package sources changed; other packages consume compiled dist, ' +
          'so run `npm run verify` before the PR to cover cross-package tests',
      );
    }
  } else {
    console.log('verify:changed: no changed lintable files');
  }

  process.exit(
    run('npx', [
      '--no-install',
      'vitest',
      'run',
      '--changed',
      resolved.base,
      '--reporter=dot',
      '--passWithNoTests',
      ...UNIT_PATHS,
    ]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
