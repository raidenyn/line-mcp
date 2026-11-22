import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
// Plain ESM without declarations: the inner-loop helper is a script, not part
// of the TypeScript build.
import { selectLintTargets } from '../../scripts/verify-changed.mjs';

type PackageJson = {
  engines?: Record<string, string>;
  scripts: Record<string, string>;
};

type Workflow = {
  jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
};

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
const scripts = packageJson.scripts;

describe('verification entrypoints', () => {
  it('runs lint, exactly one build, and the in-process suites in verify', () => {
    expect(scripts.verify).toContain('npm run lint');
    expect(scripts.verify.match(/npm run build/g)).toHaveLength(1);

    const tests = scripts.verify.slice(scripts.verify.indexOf('vitest run'));
    expect(tests).toContain('--reporter=dot');
    for (const path of ['packages', 'tests/architecture', 'tests/release', 'tests/smoke']) {
      expect(tests).toContain(path);
    }

    // test:smoke builds again; verify must run the suites directly.
    expect(scripts.verify).not.toContain('test:smoke');
    expect(scripts.verify).not.toContain('test:unit');
  });

  it('adds the docker and packaging rungs only in verify:all', () => {
    expect(scripts['verify:all']).toContain('npm run verify');
    expect(scripts['verify:all']).toContain('tests/docker/docker-smoke.test.ts');
    expect(scripts['verify:all']).toContain('tests/artifacts/line-client-pack.test.ts');
  });

  it('keeps the changed-file logic in a script, not a shell one-liner', () => {
    expect(scripts['verify:changed']).toBe('node scripts/verify-changed.mjs');
    expect(existsSync('scripts/verify-changed.mjs')).toBe(true);
  });

  it('pins Node 24 for local and CI installs', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('24');
    expect(packageJson.engines).toEqual({ node: '>=24 <25' });

    for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const workflow = parse(readFileSync(file, 'utf8')) as Workflow;
      const setupSteps = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.uses?.startsWith('actions/setup-node'));

      expect(setupSteps.length, file).toBeGreaterThan(0);
      for (const step of setupSteps) {
        expect(step.with?.['node-version-file'], file).toBe('.nvmrc');
        expect(step.with?.['node-version'], file).toBeUndefined();
      }
    }
  });

  it('documents the verification ladder and its measured rungs', () => {
    const guide = readFileSync('CLAUDE.md', 'utf8');
    expect(guide).toContain('Verification ladder');
    for (const command of [
      'npm run verify:changed',
      'npm run verify',
      'npm run verify:all',
      'npm run test:e2e',
    ]) {
      expect(guide).toContain(command);
    }
    expect(guide).toContain('Measured');
  });
});

describe('verify:changed selection', () => {
  it('lints only TypeScript files, including untracked ones, once each', () => {
    expect(
      selectLintTargets(
        'packages/a/src/x.ts\nREADME.md\npackages/a/src/x.ts\n',
        'tests/new.test.ts\nnotes.md\n',
      ),
    ).toEqual(['packages/a/src/x.ts', 'tests/new.test.ts']);
  });

  it('returns no targets when nothing changed', () => {
    expect(selectLintTargets('', '\n')).toEqual([]);
  });
});
