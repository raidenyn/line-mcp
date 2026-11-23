/* global process, URL -- Node globals are not declared for this script */
// Session-start pre-hydration. Claude Code runs this on SessionStart and adds
// stdout to the agent's context; the OpenCode plugin in .opencode/plugin/ runs
// it once per session and appends the output to the system prompt.
// It prints at most MAX_LINES lines: the branch, a short working-tree status,
// the diff against the merge-base with origin/main, active OpenSpec changes and
// the branch's last CI run. Every probe has a short timeout and is optional; a
// probe that fails is left out. No environment values are printed, and the
// script always exits 0 so it can never fail a session.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const MAX_LINES = 30;
const STATUS_LINES = 8;
const DIFF_FILES = 6;
const OPENSPEC_LINES = 6;

/**
 * Run a command and return trimmed stdout, or null on any failure.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {string | null}
 */
function capture(command, args, cwd, timeout = 3_000) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout.replace(/\s+$/, '');
  } catch {
    return null;
  }
}

/**
 * @typedef {object} Probes
 * @property {string | null} branch current branch, or null when detached/unknown
 * @property {string | null} head short HEAD sha
 * @property {string | null} status `git status --short` output
 * @property {string | null} baseRef ref the merge-base was taken from
 * @property {string | null} diffStat `git diff --stat` output against the merge-base
 * @property {string | null} openspec `openspec list` output, null when the CLI is absent
 * @property {string | null} ci one-line summary of the last CI run, null when unknown
 */

/**
 * Collect the raw probe output. Each probe is independent and optional.
 *
 * @param {string} [root]
 * @returns {Probes}
 */
export function gather(root = REPO_ROOT) {
  const git = (...args) => capture('git', args, root);
  const branch = git('branch', '--show-current') || null;
  const head = git('rev-parse', '--short', 'HEAD');
  const status = git('status', '--short');

  let baseRef = null;
  let diffStat = null;
  for (const ref of ['origin/main', 'main']) {
    const base = git('merge-base', ref, 'HEAD');
    if (base) {
      baseRef = ref;
      diffStat = git('diff', '--stat=100', base);
      break;
    }
  }

  const localOpenspec = resolve(root, 'node_modules/.bin/openspec');
  const openspec = existsSync(localOpenspec)
    ? capture(localOpenspec, ['list'], root, 8_000)
    : capture('openspec', ['list'], root, 8_000);

  let ci = null;
  if (branch) {
    const json = capture(
      'gh',
      ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'workflowName,status,conclusion,createdAt,headSha,url'],
      root,
      5_000,
    );
    ci = summarizeRun(json);
  }

  return { branch, head, status, baseRef, diffStat, openspec, ci };
}

/**
 * @param {string | null} json `gh run list --json` output
 * @returns {string | null}
 */
export function summarizeRun(json) {
  if (!json) return null;
  try {
    const [run] = JSON.parse(json);
    if (!run) return 'none for this branch';
    const state = run.status === 'completed' ? run.conclusion || 'completed' : run.status;
    const sha = typeof run.headSha === 'string' ? run.headSha.slice(0, 7) : '?';
    return `${run.workflowName}: ${state} @ ${sha} (${run.createdAt}) ${run.url}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
function head(text, max) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more`];
}

/**
 * Format the probes into the context block, capped at MAX_LINES lines.
 *
 * @param {Probes} probes
 * @returns {string}
 */
export function formatContext(probes) {
  const lines = ['# Session context (line-mcp)'];
  lines.push(
    `Branch: ${probes.branch ?? `(detached${probes.head ? ` at ${probes.head}` : ''})`}` +
      (probes.branch && probes.head ? ` @ ${probes.head}` : ''),
  );

  if (probes.status !== null) {
    if (probes.status === '') lines.push('Working tree: clean');
    else lines.push('Working tree (git status --short):', ...head(probes.status, STATUS_LINES).map((l) => `  ${l}`));
  }

  if (probes.baseRef && probes.diffStat !== null) {
    if (probes.diffStat === '') {
      lines.push(`Diff vs merge-base with ${probes.baseRef}: none`);
    } else {
      const statLines = probes.diffStat.split('\n');
      const summary = statLines.pop()?.trim() ?? '';
      lines.push(`Diff vs merge-base with ${probes.baseRef}: ${summary}`);
      lines.push(...head(statLines.join('\n'), DIFF_FILES).map((l) => `  ${l.trim()}`));
    }
  }

  if (probes.openspec !== null) {
    const openspec = head(probes.openspec, OPENSPEC_LINES);
    if (openspec.length === 1) lines.push(`OpenSpec: ${openspec[0].trim()}`);
    else lines.push('OpenSpec (openspec list):', ...openspec.map((l) => `  ${l.trim()}`));
  }

  if (probes.ci) lines.push(`Last CI run: ${probes.ci}`);

  return lines.slice(0, MAX_LINES).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${formatContext(gather())}\n`);
  } catch {
    // Never fail the session.
  }
  process.exit(0);
}
