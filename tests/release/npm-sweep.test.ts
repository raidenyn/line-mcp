import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Keeps npm-era commands from creeping back after the pnpm migration. Only the
 * exact lines below may still mention them: rules that must keep matching
 * legacy invocations, the npm-consumer pack test, and negative assertions.
 *
 * Legacy command words are assembled from tokens so that this file never
 * matches its own grep.
 */

const NPM = ['np', 'm'].join('');
const NPX = ['np', 'x'].join('');

/** Legacy commands not preceded by `p` (so `pnpm run …` is fine). */
export const PATTERN = `(^|[^p])\\b${NPM} (ci|run|ls|start)\\b|\\b${NPX}\\b`;

const EXCLUDES = [
  ':!openspec/changes/**',
  ':!openspec/archived/**',
  ':!docs/superpowers/**',
  ':!specs/**',
  ':!packages/line-client/assets/**',
];

/** Intentional matches, as `file:text` (no line numbers). */
export const ALLOWED: ReadonlySet<string> = new Set([
  `tests/release/agent-policy.test.ts:    expect(allow).not.toContain('Bash(${NPX} vitest run *)');`,
  `tests/artifacts/line-client-pack.test.ts:    // \`${NPM} ls <pkg>\` exits non-zero (and prints "(empty)") when the named`,
  `tests/release/release-workflow.test.ts:      expect(run, where).not.toMatch(/^p?${NPM} run release$/m);`,
]);

/** Matches (`file:line:text`) whose `file:text` is not allowlisted. */
export function findUnexpected(matches: string[], allowed: ReadonlySet<string>): string[] {
  return matches.filter((match) => {
    const [, file, text] = /^([^:]+):\d+:(.*)$/.exec(match) ?? [];
    return file === undefined || !allowed.has(`${file}:${text}`);
  });
}

describe('npm command sweep', () => {
  it('accepts allowlisted lines and rejects new legacy commands', () => {
    const allowedMatches = [...ALLOWED].map((entry) => entry.replace(/^([^:]+):/, '$1:7:'));
    const fresh = [`README.md:1:${NPM} run build`, `docs/x.md:2:${NPX} vitest`];
    expect(findUnexpected([...allowedMatches, ...fresh], ALLOWED)).toEqual(fresh);
  });

  it('finds no unexpected npm-era commands in the tree', () => {
    const result = spawnSync('git', ['grep', '-nE', PATTERN, '--', '.', ...EXCLUDES], { encoding: 'utf8' });
    if (result.status === 1) return; // no matches at all
    expect(result.status, result.stderr).toBe(0);
    const matches = result.stdout.split('\n').filter(Boolean);
    expect(findUnexpected(matches, ALLOWED)).toEqual([]);
  });
});
