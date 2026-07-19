import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const source = readFileSync('.github/workflows/release.yml', 'utf8');
const workflow = parse(source) as {
  concurrency: { 'cancel-in-progress': boolean; group: string };
  jobs: Record<string, { steps: Step[] }>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
};
const steps = workflow.jobs.release.steps;

describe('release workflow', () => {
  it('is manual, serialized, and contents-only', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'write' });
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'release',
    });
  });

  it('checks out complete main history and rejects stale HEAD', () => {
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, ref: 'refs/heads/main' });
    expect(steps.find((step) => step.name === 'Verify current main')?.run)
      .toContain('refs/remotes/origin/main');
  });

  it('refuses to run without the v0.1.0 baseline tag', () => {
    const baseline = steps.find((step) => step.name === 'Verify baseline tag exists');
    expect(baseline?.run).toContain('refs/tags/v0.1.0');
    expect(baseline?.run).toContain('exit 1');
  });

  it('releases and dispatches only for a newly detected tag', () => {
    expect(steps.find((step) => step.name === 'Run semantic-release')?.run)
      .toBe('npm run release');
    expect(steps.find((step) => step.id === 'release-tag')?.run)
      .toContain('comm -13');
    const dispatch = steps.find((step) => step.name === 'Dispatch Docker publishing');
    expect(dispatch?.if).toBe("steps.release-tag.outputs.tag != ''");
    expect(dispatch?.run).toContain('release-published');
    expect(dispatch?.run).toContain('client_payload');
  });
});
