import { readFileSync } from 'node:fs';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { describe, expect, it } from 'vitest';

type AnalyzerOptions = {
  preset: string;
  releaseRules: Array<{ release: false | 'patch'; type: string }>;
};

function analyzerOptions(): AnalyzerOptions {
  const config = JSON.parse(readFileSync('.releaserc.json', 'utf8')) as {
    plugins: Array<string | [string, Record<string, unknown>]>;
  };
  const entry = config.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer',
  );
  if (!Array.isArray(entry)) throw new Error('commit analyzer configuration missing');
  return entry[1] as unknown as AnalyzerOptions;
}

async function releaseType(...messages: string[]) {
  return analyzeCommits(analyzerOptions(), {
    commits: messages.map((message, index) => ({ hash: String(index), message })),
    logger: { log: () => undefined },
  });
}

describe('semantic release policy', () => {
  it.each([
    ['fix: correct pagination', 'patch'],
    ['perf: index messages', 'patch'],
    ['feat: add account export', 'minor'],
    ['chore!: require Node 24', 'major'],
    ['chore: update tooling\n\nBREAKING CHANGE: remove Node 20', 'major'],
    ['docs: explain releases', null],
  ] as const)('maps %s to %s', async (message, expected) => {
    await expect(releaseType(message)).resolves.toBe(expected);
  });

  it('selects the highest release type in a commit set', async () => {
    await expect(releaseType('fix: one', 'feat: two')).resolves.toBe('minor');
  });
});
