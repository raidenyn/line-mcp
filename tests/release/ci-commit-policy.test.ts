import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe('CI commit policy job', () => {
  const steps = workflow.jobs['commit-policy']?.steps ?? [];

  it('checks out complete PR-head history', () => {
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
    });
  });

  it('validates PR commits and the squash title', () => {
    expect(steps.find((step) => step.name === 'Validate PR commits')?.run)
      .toContain('--from "${{ github.event.pull_request.base.sha }}" --to "${{ github.event.pull_request.head.sha }}"');
    const title = steps.find((step) => step.name === 'Validate PR title');
    expect(title?.env?.PR_TITLE).toBe('${{ github.event.pull_request.title }}');
    expect(title?.run).toContain('printf');
  });

  it('handles normal and all-zero push ranges separately', () => {
    expect(steps.find((step) => step.name === 'Validate pushed commits')?.if)
      .toContain("github.event.before != '0000000000000000000000000000000000000000'");
    expect(steps.find((step) => step.name === 'Validate initial pushed commit')?.if)
      .toContain("github.event.before == '0000000000000000000000000000000000000000'");
  });
});
