import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release documentation', () => {
  it('documents enforced commits and perf releases for contributors', () => {
    const guide = readFileSync('CLAUDE.md', 'utf8');
    expect(guide).toContain('`perf` → patch');
    expect(guide).toContain('commit-msg');
    expect(guide).toContain('CI');
    expect(guide).toContain('docs/RELEASING.md');
  });

  it('documents bootstrap and normal release operations', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('v0.1.0');
    expect(runbook).toContain('gh release create');
    expect(runbook).toContain('workflow_dispatch');
    expect(runbook).toContain('No releasable commits');
    expect(runbook).toContain('release-published');
  });
});