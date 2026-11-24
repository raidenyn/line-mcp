import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM without declarations: the hook is a script, not part of the
// TypeScript build.
import { formatContext, MAX_LINES, summarizeRun } from '../../.claude/hooks/session-context.mjs';

const HOOK = resolve('.claude/hooks/session-context.mjs');

const probes = {
  branch: 'feat/x',
  head: 'abc1234',
  status: ' M a.ts\n?? b.ts',
  baseRef: 'origin/main',
  diffStat: ' a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
  openspec: 'No active changes found.',
  ci: 'CI: success @ abc1234 (2026-11-23T10:00:00Z) https://example.test/run/1',
};

describe('session-context formatting', () => {
  it('prints the branch, status, diff summary, OpenSpec and CI lines', () => {
    expect(formatContext(probes).split('\n')).toEqual([
      '# Session context (line-mcp)',
      'Branch: feat/x @ abc1234',
      'Working tree (git status --short):',
      '   M a.ts',
      '  ?? b.ts',
      'Diff vs merge-base with origin/main: 1 file changed, 1 insertion(+), 1 deletion(-)',
      '  a.ts | 2 +-',
      'OpenSpec: No active changes found.',
      'Last CI run: CI: success @ abc1234 (2026-11-23T10:00:00Z) https://example.test/run/1',
    ]);
  });

  it('leaves out probes that failed and reports a clean tree', () => {
    const text = formatContext({
      ...probes,
      branch: null,
      status: '',
      baseRef: null,
      diffStat: null,
      openspec: null,
      ci: null,
    });
    expect(text.split('\n')).toEqual(['# Session context (line-mcp)', 'Branch: (detached at abc1234)', 'Working tree: clean']);
  });

  it(`never prints more than ${MAX_LINES} lines`, () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
    const text = formatContext({
      ...probes,
      status: many(40, '?? f'),
      diffStat: `${many(40, ' f')}\n 40 files changed`,
      openspec: many(40, 'change-'),
    });
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(text).toContain('more');
  });

  it('summarizes the last gh run and tolerates bad output', () => {
    const run = JSON.stringify([
      {
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-11-23T10:00:00Z',
        headSha: 'abcdef1234567',
        url: 'https://example.test/run/2',
      },
    ]);
    expect(summarizeRun(run)).toBe('CI: failure @ abcdef1 (2026-11-23T10:00:00Z) https://example.test/run/2');
    expect(summarizeRun(JSON.stringify([{ ...JSON.parse(run)[0], status: 'in_progress', conclusion: '' }]))).toContain(
      'CI: in_progress',
    );
    expect(summarizeRun('[]')).toBe('none for this branch');
    expect(summarizeRun('nope')).toBeNull();
    expect(summarizeRun(null)).toBeNull();
  });
});

describe('session-context hook script', () => {
  it('exits 0 with a short block that names the branch and no environment values', () => {
    const result = spawnSync('node', [HOOK], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, LINE_MCP_HOOK_CANARY: 'canary-secret-value' },
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('# Session context (line-mcp)');
    expect(lines[1]).toMatch(/^Branch: /);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(result.stdout).not.toContain('canary-secret-value');
  });

  it('still exits 0 when git, openspec and gh are unavailable', () => {
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      timeout: 60_000,
      // Only node itself is reachable; every probe fails.
      env: { PATH: '/nonexistent' },
      cwd: '/',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Session context (line-mcp)');
  });
});
