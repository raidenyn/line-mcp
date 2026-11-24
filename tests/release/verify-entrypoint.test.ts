import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
// Plain ESM without declarations: the inner-loop helper is a script, not part
// of the TypeScript build.
import { hasChangedFiles, resolveBase, selectLintTargets } from '../../scripts/verify-changed.mjs';

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
    // The single build must go through the npm script, not an inline second one.
    expect(scripts.verify).not.toContain('tsc -b');
    // #118 made strict OpenSpec validation part of the pre-PR gate.
    expect(scripts.verify).toContain('npx openspec validate --all --strict');

    const tests = scripts.verify.slice(scripts.verify.indexOf('vitest run'));
    expect(tests).toContain('--reporter=dot');
    for (const path of ['packages', 'tests/architecture', 'tests/release', 'tests/harness', 'tests/smoke']) {
      expect(tests).toContain(path);
    }

    // test:smoke builds again; verify must run the suites directly.
    expect(scripts.verify).not.toContain('test:smoke');
    expect(scripts.verify).not.toContain('test:unit');
  });

  it('adds the docker and packaging rungs only in verify:all', () => {
    expect(scripts['verify:all']).toContain('npm run verify');
    // The smoke test skips itself without a daemon, so the rung must build first.
    expect(scripts['verify:all']).toContain('docker build --target server');
    expect(scripts['verify:all']).toContain('docker build --target line-mcp');
    expect(scripts['verify:all']).toContain('tests/docker/docker-smoke.test.ts');
    expect(scripts['verify:all']).toContain('tests/artifacts/line-client-pack.test.ts');
    expect(scripts['verify:all'].match(/--reporter=dot/g)).toHaveLength(2);
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
    const guide = readFileSync('AGENTS.md', 'utf8');
    expect(guide).toContain('Verification ladder');
    expect(guide).toMatch(/npm run verify(?![:\w])/);
    for (const command of ['npm run verify:changed', 'npm run verify:all', 'npm run test:e2e']) {
      expect(guide).toContain(command);
    }
    expect(guide).toContain('Measured');
  });
});

describe('verify:changed selection', () => {
  it('lints changed JS/TS files, including untracked ones, once each', () => {
    expect(
      selectLintTargets(
        'packages/a/src/x.ts\0README.md\0packages/a/src/x.ts\0',
        'scripts/tool.mjs\0tests/new.test.ts\0notes.md\0',
      ),
    ).toEqual(['packages/a/src/x.ts', 'scripts/tool.mjs', 'tests/new.test.ts']);
  });

  it('returns no targets when nothing changed', () => {
    expect(selectLintTargets('', '\0')).toEqual([]);
  });

  it('distinguishes an empty diff from a changed file', () => {
    expect(hasChangedFiles('', '')).toBe(false);
    expect(hasChangedFiles('\0', '\0')).toBe(false);
    expect(hasChangedFiles('README.md\0', '')).toBe(true);
  });

  it('resolves origin/main first and falls back to HEAD with a warning flag', () => {
    expect(
      resolveBase((args: string[]) =>
        args[0] === 'merge-base' && args[1] === 'origin/main' ? 'abc\n' : null,
      ),
    ).toEqual({ base: 'abc', ref: 'origin/main', fallback: false });

    expect(
      resolveBase((args: string[]) => (args[0] === 'rev-parse' ? 'def\n' : null)),
    ).toEqual({ base: 'def', ref: 'HEAD', fallback: true });

    expect(resolveBase(() => null)).toBeNull();
  });
});
