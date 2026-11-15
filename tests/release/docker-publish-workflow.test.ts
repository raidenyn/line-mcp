import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.github/workflows/publish-docker.yml', 'utf8');
const workflow = parse(source) as {
  concurrency: { 'cancel-in-progress': boolean; group: string; queue: string };
  jobs: Record<string, unknown>;
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
};

describe('publish workflow', () => {
  it('runs on main pushes, release dispatch, published releases, and manual dispatch', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      repository_dispatch: { types: ['release-published'] },
      release: { types: ['published'] },
      workflow_dispatch: {
        inputs: {
          tag: {
            description: expect.any(String),
            required: false,
            type: 'string',
          },
        },
      },
    });
    expect(workflow.on).not.toHaveProperty('pull_request');
  });

  it('queues releases instead of cancelling them and holds contents-only permissions', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'publish-docker',
      queue: 'max',
    });
  });
});
