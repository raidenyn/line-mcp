import { describe, expect, it, vi } from 'vitest';
// Plain ESM without declarations: the planner is a workflow helper, not part of
// the TypeScript build.
import { plan } from '../../scripts/release-plan.mjs';

type NextRelease = {
  gitHead: string;
  gitTag: string;
  notes: string;
  version: string;
};

type ReleaseResult = false | { nextRelease: NextRelease };

const nextRelease: NextRelease = {
  gitHead: '9fceb02d0ae598e95dc970b74767f19372d61af8',
  gitTag: 'v1.2.0',
  notes: '## 1.2.0\n\n### Features\n\n* add account export',
  version: '1.2.0',
};

function harness(result: ReleaseResult | (() => Promise<ReleaseResult>)) {
  const notes: string[] = [];
  const outputs: Array<[string, string]> = [];
  const run = vi.fn(async () => (typeof result === 'function' ? result() : result));
  return {
    deps: {
      run,
      writeNotes: (value: string) => notes.push(value),
      writeOutput: (key: string, value: string) => outputs.push([key, value]),
    },
    notes,
    outputs,
    run,
  };
}

describe('release plan', () => {
  it('reports no release and writes no notes when semantic-release finds nothing', async () => {
    const { deps, notes, outputs, run } = harness(false);

    await plan(deps);

    expect(outputs).toEqual([['released', 'false']]);
    expect(notes).toEqual([]);
    // A dry run on main only: no ci override, which would hide CI behaviour.
    expect(run).toHaveBeenCalledWith({ branches: ['main'], dryRun: true });
  });

  it('writes the planned version, tag, commit and notes', async () => {
    const { deps, notes, outputs } = harness({ nextRelease });

    await plan(deps);

    expect(outputs).toEqual([
      ['released', 'true'],
      ['version', '1.2.0'],
      ['tag', 'v1.2.0'],
      ['sha', nextRelease.gitHead],
    ]);
    expect(notes).toEqual([nextRelease.notes]);
  });

  it('propagates a semantic-release failure', async () => {
    const { deps, notes, outputs } = harness(async () => {
      throw new Error('EGITNOPERMISSION');
    });

    await expect(plan(deps)).rejects.toThrow('EGITNOPERMISSION');
    expect(outputs).toEqual([]);
    expect(notes).toEqual([]);
  });
});
