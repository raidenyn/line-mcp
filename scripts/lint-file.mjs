/* global URL -- Node globals are not declared for this script */
// The edit trigger of scripts/verify-changed.mjs. The agent harness verify gate
// (.agents/harness/verify-gate/) runs that script after every edit of a file in
// its `editFiles` with VERIFY_TRIGGER=edit and VERIFY_FILE, on Claude Code and
// OpenCode alike. For a TypeScript file inside the repository it runs
// `eslint --fix` on that one file. Errors that remain are returned (at most
// MAX_LINES) with exit code 1, which the gate appends to the tool result. When
// --fix changed the file, a one-line note says so; on a clean run it is the
// only output and exit 0, which the gate hands to the model as pass output.
// Everything else (other files, a missing or crashing ESLint, a timeout)
// passes silently, so the edit run never fails work it cannot judge.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MAX_LINES = 20;
const TIMEOUT_MS = 20_000;
const LINTABLE = /\.(?:c|m)?ts$/;
const EXCLUDED_SEGMENTS = new Set(['dist', 'node_modules', '.git']);
const EXCLUDED_PREFIX = 'packages/line-client/assets/ltsm/';

/**
 * Canonical path, so a checkout reached through a symlink (or macOS
 * /tmp -> /private/tmp) still compares equal to the script's own location.
 * A file that does not exist yet keeps its name under its real parent.
 *
 * @param {string} path absolute path
 * @returns {string}
 */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * Return the repository-relative path to lint, or null when `file` is not a
 * TypeScript file the edit run owns.
 *
 * @param {string | undefined} file path, absolute or relative to `cwd`
 * @param {string} [root] repository root
 * @param {string} [cwd] directory a relative `file` is resolved from
 * @returns {string | null}
 */
export function lintTarget(file, root = REPO_ROOT, cwd = root) {
  if (typeof file !== 'string' || file.length === 0 || !LINTABLE.test(file)) return null;
  const absolute = canonical(resolve(cwd, file));
  const rel = relative(canonical(root), absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const posix = rel.split(sep).join('/');
  if (posix.startsWith(EXCLUDED_PREFIX)) return null;
  if (posix.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment))) return null;
  return posix;
}

/**
 * Turn ESLint `--format json` output into compact feedback lines, errors only.
 * Returns an empty array when nothing blocking remains.
 *
 * @param {string} json ESLint stdout
 * @param {string} file repository-relative path shown in the lines
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function formatErrors(json, file, maxLines = MAX_LINES) {
  let results;
  try {
    results = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(results)) return [];
  const errors = results.flatMap((result) =>
    (result?.messages ?? []).filter((message) => message?.severity === 2),
  );
  if (errors.length === 0) return [];

  const header = `ESLint: ${errors.length} error(s) remain in ${file} after --fix. Fix them now:`;
  const body = errors.map(
    (error) =>
      `${file}:${error.line ?? 0}:${error.column ?? 0} ${error.message}` +
      (error.ruleId ? ` (${error.ruleId})` : ''),
  );
  const room = maxLines - 1;
  if (body.length <= room) return [header, ...body];
  const shown = body.slice(0, room - 1);
  return [header, ...shown, `… ${body.length - shown.length} more; run \`pnpm exec eslint ${file}\``];
}

/**
 * @param {string} file repository-relative path
 * @param {string} [root]
 * @param {typeof spawnSync} [spawn] injectable for the ESLint-crash tests
 * @returns {{ errors: string[], fixed: boolean }} remaining errors (empty when
 *   clean or when ESLint could not judge) and whether --fix rewrote the file
 */
export function lintFile(file, root = REPO_ROOT, spawn = spawnSync) {
  const path = resolve(root, file);
  if (!existsSync(path)) return { errors: [], fixed: false };
  const before = readFileSync(path, 'utf8');
  // The local binary avoids pnpm start-up and lets the timeout kill ESLint
  // itself rather than a pnpm parent that leaves it holding the pipe.
  const local = resolve(root, 'node_modules/.bin/eslint');
  const [command, prefix] = existsSync(local) ? [local, []] : ['pnpm', ['exec', 'eslint']];
  const result = spawn(command, [...prefix, '--fix', '--format', 'json', '--', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  let fixed;
  try {
    fixed = readFileSync(path, 'utf8') !== before;
  } catch {
    fixed = false;
  }
  // 0 = clean, 1 = errors remain; 2, a signal or a timeout means ESLint itself
  // failed, which is not the agent's edit to fix.
  if (result.status !== 1) return { errors: [], fixed };
  return { errors: formatErrors(result.stdout ?? '', file), fixed };
}

/**
 * The note shown when --fix changed the file, so the agent re-reads it
 * before its next exact-match edit.
 *
 * @param {string} file
 * @returns {string}
 */
export function fixedNote(file) {
  return `ESLint --fix rewrote ${file}; re-read it before editing it again.`;
}

/**
 * Lint the edited file. Exit code 1 with the remaining errors (and the --fix
 * note when the file was rewritten); exit code 0 with only the note after a
 * clean rewrite; exit code 0 and no output otherwise.
 *
 * @param {string | undefined} file edited path, as VERIFY_FILE gives it
 * @param {string} [root]
 * @returns {{ code: 0 | 1, output: string }}
 */
export function lintEditedFile(file, root = REPO_ROOT) {
  const target = lintTarget(file, root);
  if (!target) return { code: 0, output: '' };
  const { errors, fixed } = lintFile(target, root);
  if (errors.length === 0) return { code: 0, output: fixed ? `${fixedNote(target)}\n` : '' };
  const lines = fixed ? [...errors.slice(0, MAX_LINES - 1), fixedNote(target)] : errors;
  return { code: 1, output: `${lines.join('\n')}\n` };
}
