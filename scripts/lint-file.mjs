/* global process, URL -- Node globals are not declared for this script */
// Edit-time diagnostics. Claude Code runs this after Edit/Write/MultiEdit
// (PostToolUse) and the OpenCode plugin in .opencode/plugin/ runs it after its
// edit tools, with the same JSON payload on stdin:
//   { "cwd": "...", "tool_input": { "file_path": "..." } }
// For a TypeScript file inside the repository it runs `eslint --fix` on that
// one file. Errors that remain are printed on stderr (at most MAX_LINES) and
// the script exits 2, which both hosts feed back to the agent. When --fix
// changed the file, a one-line note says so (on exit 0 as PostToolUse JSON
// `additionalContext` on stdout). Everything else
// (other files, a missing or crashing ESLint, a timeout) exits 0 silently, so
// the hook never blocks work it cannot judge.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
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
 * Return the repository-relative path to lint, or null when the payload does
 * not name a TypeScript file this hook owns.
 *
 * @param {unknown} payload hook JSON
 * @param {string} [root] repository root
 * @returns {string | null}
 */
export function lintTarget(payload, root = REPO_ROOT) {
  const input = /** @type {any} */ (payload)?.tool_input;
  const file = input?.file_path ?? input?.filePath ?? input?.path;
  if (typeof file !== 'string' || file.length === 0 || !LINTABLE.test(file)) return null;
  const cwd = /** @type {any} */ (payload)?.cwd;
  const absolute = canonical(resolve(typeof cwd === 'string' && cwd ? cwd : root, file));
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
 * @returns {{ errors: string[], fixed: boolean }} remaining errors (empty when
 *   clean or when ESLint could not judge) and whether --fix rewrote the file
 */
export function lintFile(file, root = REPO_ROOT) {
  const path = resolve(root, file);
  if (!existsSync(path)) return { errors: [], fixed: false };
  const before = readFileSync(path, 'utf8');
  // The local binary avoids pnpm start-up and lets the timeout kill ESLint
  // itself rather than a pnpm parent that leaves it holding the pipe.
  const local = resolve(root, 'node_modules/.bin/eslint');
  const [command, prefix] = existsSync(local) ? [local, []] : ['pnpm', ['exec', 'eslint']];
  const result = spawnSync(command, [...prefix, '--fix', '--format', 'json', '--', file], {
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
 * PostToolUse JSON output that hands `fixedNote` to the agent on exit 0.
 *
 * @param {string} file
 */
export function fixedOutput(file) {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: fixedNote(file) } };
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

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  const file = lintTarget(payload);
  if (!file) return 0;
  const { errors, fixed } = lintFile(file);
  if (errors.length === 0) {
    // Claude Code passes `additionalContext` to the model; the OpenCode plugin
    // reads the same JSON.
    if (fixed) process.stdout.write(`${JSON.stringify(fixedOutput(file))}\n`);
    return 0;
  }
  const lines = fixed ? [...errors.slice(0, MAX_LINES - 1), fixedNote(file)] : errors;
  process.stderr.write(`${lines.join('\n')}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code;
  try {
    code = main();
  } catch {
    code = 0;
  }
  process.exit(code);
}
