import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function lint(message: string) {
  return spawnSync('npm', ['run', '--silent', 'commitlint', '--'], {
    cwd: root,
    encoding: 'utf8',
    input: message,
  });
}

describe('commit message policy', () => {
  it.each([
    'feat: add release automation',
    'fix(oauth): reject stale state',
    'perf!: replace the message index',
    'chore: update tooling\n\nBREAKING CHANGE: require Node 24',
  ])('accepts %s', (message) => {
    const result = lint(message);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    'style: reformat files',
    'missing conventional prefix',
    "Merge branch 'main'",
    'Revert "feat: add release automation"',
    `feat: ${'x'.repeat(100)}`,
  ])('rejects %s', (message) => {
    expect(lint(message).status).not.toBe(0);
  });
});
