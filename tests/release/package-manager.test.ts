import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Guards the pnpm workspace contract from
 * openspec/changes/migrate-to-pnpm/specs/workspace-package-management.
 *
 * Every file is read inside the test that needs it, so a missing file fails
 * that test's assertion instead of breaking collection of the whole suite.
 */

type DependencySection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

type Manifest = {
  name?: string;
  packageManager?: string;
  workspaces?: unknown;
} & Partial<Record<DependencySection, Record<string, string>>>;

const DEPENDENCY_SECTIONS: DependencySection[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Test tooling the root declares once for every package. */
const SHARED_TEST_TOOLING = ['vitest'];

const BUILTINS = new Set(builtinModules);

function readJson<T>(path: string): T {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed as T;
}

function readRootManifest(): Manifest {
  return readJson<Manifest>('package.json');
}

function packageDirs(): string[] {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join('packages', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

function allManifestPaths(): string[] {
  return ['package.json', ...packageDirs().map((dir) => join('packages', dir, 'package.json'))];
}

function readWorkspaceConfig(): Record<string, unknown> | undefined {
  if (!existsSync('pnpm-workspace.yaml')) return undefined;
  return parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as Record<string, unknown>;
}

function declared(manifest: Manifest, sections: DependencySection[]): Set<string> {
  return new Set(sections.flatMap((section) => Object.keys(manifest[section] ?? {})));
}

function listFiles(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path, extensions);
    return extensions.test(entry.name) ? [path] : [];
  });
}

/** Package names of the bare module specifiers a file imports or requires. */
function bareImports(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return info.importedFiles
    .map((ref) => ref.fileName)
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'))
    .filter((specifier) => !specifier.startsWith('node:'))
    .map((specifier) => {
      const parts = specifier.split('/');
      return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    })
    .filter((name) => !BUILTINS.has(name));
}

function undeclaredImports(files: string[], allowed: Set<string>): string[] {
  return files.flatMap((file) =>
    bareImports(file)
      .filter((name) => !allowed.has(name))
      .map((name) => `${file} imports undeclared ${name}`),
  );
}

describe('package manager', () => {
  it('pins an exact pnpm version', () => {
    expect(readRootManifest().packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('tracks only the pnpm lockfile', () => {
    expect(existsSync('pnpm-lock.yaml')).toBe(true);
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((file) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/.test(file));
    expect(tracked).toEqual([]);
  });

  it('declares the workspace, build allowlist and no implicit installs', () => {
    const config = readWorkspaceConfig();
    expect(config, 'pnpm-workspace.yaml is missing').toBeDefined();
    expect(config).toMatchObject({
      packages: ['packages/*'],
      allowBuilds: { 'better-sqlite3': true, fsevents: false },
      verifyDepsBeforeRun: false,
      hoistWorkspacePackages: false,
    });
    expect(Object.keys((config?.allowBuilds ?? {}) as Record<string, unknown>).sort()).toEqual(['better-sqlite3', 'fsevents']);
  });

  it('links internal packages with the workspace protocol', () => {
    const wrong = allManifestPaths().flatMap((path) => {
      const manifest = readJson<Manifest>(path);
      return DEPENDENCY_SECTIONS.flatMap((section) =>
        Object.entries(manifest[section] ?? {})
          .filter(([name, range]) => name.startsWith('@raidenyn/') && range !== 'workspace:^')
          .map(([name, range]) => `${path} ${section}.${name} = ${range}`),
      );
    });
    expect(wrong).toEqual([]);
  });

  it('declares every root-level bare import in the root manifest', () => {
    const root = declared(readRootManifest(), ['dependencies', 'devDependencies']);
    const files = [
      ...listFiles('tests', /\.(ts|mjs|js)$/),
      ...listFiles('scripts', /\.(mjs|js)$/),
      'vitest.config.ts',
      'eslint.config.js',
    ];
    expect(undeclaredImports(files, root)).toEqual([]);
  });

  it('declares every bare import in the package that makes it', () => {
    const problems = packageDirs().flatMap((dir) => {
      const manifest = readJson<Manifest>(join('packages', dir, 'package.json'));
      const allowed = declared(manifest, ['dependencies', 'devDependencies', 'peerDependencies']);
      for (const tool of SHARED_TEST_TOOLING) allowed.add(tool);
      return undeclaredImports(listFiles(join('packages', dir, 'src'), /\.ts$/), allowed);
    });
    expect(problems).toEqual([]);
  });

  it('sets up pinned pnpm before node and installs frozen in every job', () => {
    type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
    type Workflow = { jobs: Record<string, { steps?: Step[] }> };
    const expected: Record<string, Record<string, string>> = {
      '.github/workflows/ci.yml': {
        'commit-policy': 'pnpm install --frozen-lockfile',
        check: 'pnpm install --frozen-lockfile',
        'pack-line-client': 'pnpm install --frozen-lockfile',
        docker: 'pnpm install --frozen-lockfile',
        smoke: 'pnpm install --frozen-lockfile',
      },
      '.github/workflows/release.yml': {
        plan: 'pnpm install --frozen-lockfile --ignore-scripts',
      },
    };
    const legacy = /(^|[^p])\bnpm (ci|run|ls)\b|\bnpx\b/;

    for (const [file, jobs] of Object.entries(expected)) {
      const workflow = parse(readFileSync(file, 'utf8')) as Workflow;
      const nodeJobs = Object.entries(workflow.jobs)
        .filter(([, job]) => (job.steps ?? []).some((step) => step.uses === 'actions/setup-node@v7'))
        .map(([name]) => name)
        .sort();
      expect(nodeJobs, file).toEqual(Object.keys(jobs).sort());

      for (const [name, install] of Object.entries(jobs)) {
        const steps = workflow.jobs[name].steps ?? [];
        const where = `${file} ${name}`;
        const pnpmSetup = steps.findIndex((step) => step.uses === 'pnpm/action-setup@v6');
        const nodeSetup = steps.findIndex((step) => step.uses === 'actions/setup-node@v7');
        expect(pnpmSetup, where).toBeGreaterThanOrEqual(0);
        expect(pnpmSetup, where).toBeLessThan(nodeSetup);
        expect(steps[pnpmSetup].with, where).toBeUndefined();
        expect(steps[nodeSetup].with?.cache, where).toBe('pnpm');

        const installs = steps.filter((step) => /\bpnpm install\b/.test(step.run ?? ''));
        expect(installs, where).toHaveLength(1);
        expect(installs[0].run?.trim(), where).toBe(install);
        for (const step of steps) expect(step.run ?? '', `${where}: ${step.name}`).not.toMatch(legacy);
      }
    }

    const check = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;
    expect(check.jobs.check.steps).toContainEqual(
      expect.objectContaining({ name: 'Peer dependency check', run: 'node scripts/check-peers.mjs' }),
    );
  });

  it('pins the Docker builder to the same pnpm', () => {
    const pinned = readRootManifest().packageManager?.replace(/^pnpm@/, '');
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile.match(/^ARG PNPM_VERSION=(\S+)$/m)?.[1]).toBe(pinned);
    for (const needle of [
      'npm install -g pnpm@${PNPM_VERSION}',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'pnpm install --frozen-lockfile',
      'pnpm prune --prod',
    ]) {
      expect(dockerfile).toContain(needle);
    }
    expect(dockerfile).not.toContain('package-lock.json');
    expect(dockerfile).not.toMatch(/\bnpm ci\b/);
  });
});
