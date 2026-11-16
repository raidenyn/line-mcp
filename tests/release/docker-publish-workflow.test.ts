import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('is callable by Release and runs only when a pull request is labeled', () => {
    expect(workflow.on).toEqual({
      workflow_call: {
        inputs: {
          tag: {
            description: expect.any(String),
            required: false,
            type: 'string',
          },
        },
      },
      pull_request: { types: ['labeled'] },
    });
    // A merge to main publishes nothing, and only adding a label may publish:
    // a push, an edit, or another label never republishes.
    expect(workflow.on).not.toHaveProperty('push');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
  });

  it('retains none of the retired triggers, previews, or registry secrets', () => {
    for (const retired of [
      'repository_dispatch',
      'workflow_dispatch:',
      'release:',
      'edge',
      'prerelease',
      'GHCR_PUBLISH_TOKEN',
      'type=gha',
    ]) {
      expect(source).not.toContain(retired);
    }
  });

  it('queues releases instead of cancelling them and keeps prepare read-only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect((workflow.jobs.prepare as { permissions?: Record<string, string> }).permissions).toEqual({
      contents: 'read',
    });
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'publish-docker',
      queue: 'max',
    });
  });

  it('authenticates with the workflow token and no registry secret', () => {
    expect(source).not.toContain('GHCR_PACKAGES_PRIVATE');
    expect(source).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
  });
});

const SHA_MAIN = 'a'.repeat(40);
const SHA_PR = 'e'.repeat(40);
const SHORT_MAIN = SHA_MAIN.slice(0, 7);
const SHORT_PR = SHA_PR.slice(0, 7);
const RELEASE_WORKFLOW_REF = 'owner/repo/.github/workflows/release.yml@refs/heads/main';

type Step = {
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const prepare = workflow.jobs.prepare as {
  if?: string;
  outputs: Record<string, string>;
  steps: Step[];
};

const resolveStep = () => prepare.steps.find((step) => step.id === 'resolve')!;

type ResolveCase = {
  env?: Record<string, string>;
  expect: Record<string, string>;
  exit: number;
  name: string;
  stderr?: string;
  tags?: string[];
};

const OUTPUT_KEYS = ['latest', 'major', 'pr', 'publish', 'ref', 'sha', 'short_sha', 'tag'];

// A successful release call builds the commit the caller planned (the tag does
// not exist yet) and defaults to the newest stable release.
const release = (overrides: Record<string, string>): Record<string, string> => ({
  latest: 'true',
  major: '1',
  pr: '',
  publish: 'true',
  ref: SHA_MAIN,
  sha: SHA_MAIN,
  short_sha: SHORT_MAIN,
  tag: 'v1.2.3',
  ...overrides,
});

// Every success case states the complete output map, so an extra or missing
// key in the emitted outputs cannot slip through.
const cases: ResolveCase[] = [
  {
    name: 'the publish-docker label on a same-repository PR publishes its head',
    env: {
      EVENT_NAME: 'pull_request',
      PR_HEAD_REPO: 'owner/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: 'publish-docker',
      PR_NUMBER: '96',
    },
    exit: 0,
    expect: {
      latest: 'false',
      major: '',
      pr: '96',
      publish: 'true',
      ref: SHA_PR,
      sha: SHA_PR,
      short_sha: SHORT_PR,
      tag: '',
    },
  },
  {
    name: 'an unlabeled pull request publishes nothing',
    env: {
      EVENT_NAME: 'pull_request',
      PR_HEAD_REPO: 'owner/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: '',
      PR_NUMBER: '96',
    },
    exit: 0,
    expect: {
      latest: 'false',
      major: '',
      pr: '',
      publish: 'false',
      ref: SHA_MAIN,
      sha: SHA_MAIN,
      short_sha: SHORT_MAIN,
      tag: '',
    },
  },
  {
    name: 'a fork pull request is refused with a warning',
    env: {
      EVENT_NAME: 'pull_request',
      PR_HEAD_REPO: 'contributor/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: 'publish-docker',
      PR_NUMBER: '96',
    },
    exit: 0,
    expect: {
      latest: 'false',
      major: '',
      pr: '',
      publish: 'false',
      ref: SHA_MAIN,
      sha: SHA_MAIN,
      short_sha: SHORT_MAIN,
      tag: '',
    },
    stderr: '::warning::fork pull requests cannot publish images',
  },
  {
    name: 'the Release caller publishes the planned commit',
    tags: ['v1.0.0', 'v1.1.0', 'v1.2.0'],
    exit: 0,
    expect: release({}),
  },
  {
    name: 'an older release leaves the moving tags alone',
    tags: ['v1.3.0', 'v1.4.2'],
    exit: 0,
    expect: release({ latest: 'false' }),
  },
  {
    name: 'a release candidate cannot outrank the release being published',
    tags: ['v1.2.0', 'v1.2.3-rc.1'],
    exit: 0,
    expect: release({}),
  },
  {
    name: 'zero major is parsed and reported',
    env: { TAG: 'v0.2.0' },
    tags: ['v0.1.0'],
    exit: 0,
    expect: release({ major: '0', tag: 'v0.2.0' }),
  },
  {
    name: 'a caller other than release.yml is refused',
    env: { WORKFLOW_REF: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
    exit: 1,
    expect: {},
    stderr: '::error::Publish Docker may be called only by',
  },
  {
    name: 'release.yml from a ref other than main is refused',
    env: { WORKFLOW_REF: 'owner/repo/.github/workflows/release.yml@refs/heads/feature' },
    exit: 1,
    expect: {},
    stderr: '::error::Publish Docker may be called only by',
  },
  {
    name: 'a plain workflow_dispatch carries no caller and is refused',
    env: { WORKFLOW_REF: '' },
    exit: 1,
    expect: {},
    stderr: '::error::Publish Docker may be called only by',
  },
  {
    name: 'a caller event other than the dispatch is refused',
    env: { EVENT_NAME: 'release' },
    exit: 1,
    expect: {},
    stderr: '::error::Publish Docker runs only as part of',
  },
  {
    name: 'a release dispatch is refused',
    env: { EVENT_NAME: 'repository_dispatch' },
    exit: 1,
    expect: {},
    stderr: '::error::Publish Docker runs only as part of',
  },
  {
    name: 'a call from a branch other than main is refused',
    env: { REF: 'refs/heads/feature' },
    exit: 1,
    expect: {},
    stderr: '::error::Release must call Publish Docker from refs/heads/main',
  },
  {
    name: 'a call without a tag is refused',
    env: { TAG: '' },
    exit: 1,
    expect: {},
    stderr: '::error::unsupported tag',
  },
  {
    name: 'a malformed tag is refused',
    env: { TAG: 'v1.2' },
    exit: 1,
    expect: {},
    stderr: '::error::unsupported tag',
  },
  {
    name: 'a failed tag listing fails instead of silently defaulting latest',
    env: { FAKE_TAGS_FAIL: '1' },
    exit: 1,
    expect: {},
    stderr: '::error::cannot list release tags',
  },
];

function runResolve(testCase: ResolveCase) {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const fakeGit = join(dir, 'git');
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *--tags* ]]; then
  if [ "\${FAKE_TAGS_FAIL:-0}" = 1 ]; then
    exit 1
  fi
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    printf '%s\trefs/tags/%s\n' "${SHA_MAIN}" "$tag"
  done <<< "\${FAKE_TAGS:-}"
else
  printf 'unexpected git invocation: %s\\n' "$*" >&2
  exit 1
fi
`,
  );
  chmodSync(fakeGit, 0o755);
  const outputPath = join(dir, 'output');
  writeFileSync(outputPath, '');
  const result = spawnSync('bash', ['-c', resolveStep().run!], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'workflow_dispatch',
      FAKE_TAGS: (testCase.tags ?? []).join('\n'),
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: 'https://github.com',
      PATH: `${dir}:${process.env.PATH}`,
      PR_HEAD_REPO: '',
      PR_HEAD_SHA: '',
      PR_LABEL: '',
      PR_NUMBER: '',
      REF: 'refs/heads/main',
      SHA: SHA_MAIN,
      TAG: 'v1.2.3',
      WORKFLOW_REF: RELEASE_WORKFLOW_REF,
      ...testCase.env,
    },
  });
  const raw = readFileSync(outputPath, 'utf8');
  const parsed = Object.fromEntries(
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=')];
      }),
  );
  return { output: raw, parsed, status: result.status, stderr: result.stderr };
}

describe('prepare resolve script', () => {
  it.each(cases)('$name', (testCase) => {
    const { output, parsed, status, stderr } = runResolve(testCase);
    expect(status).toBe(testCase.exit);
    if (testCase.stderr) {
      expect(stderr).toContain(testCase.stderr);
    }
    if (testCase.exit === 0) {
      expect(Object.keys(parsed).sort()).toEqual(OUTPUT_KEYS);
      expect(parsed).toEqual(testCase.expect);
    } else {
      // A failed resolve must not hand partial outputs to the publish job.
      expect(output).toBe('');
      expect(stderr).not.toBe('');
    }
  });

  it('exposes every output the publish job consumes', () => {
    expect(Object.keys(prepare.outputs).sort()).toEqual(OUTPUT_KEYS);
    expect(prepare.outputs).toEqual({
      latest: '${{ steps.resolve.outputs.latest }}',
      major: '${{ steps.resolve.outputs.major }}',
      pr: '${{ steps.resolve.outputs.pr }}',
      publish: '${{ steps.resolve.outputs.publish }}',
      ref: '${{ steps.resolve.outputs.ref }}',
      sha: '${{ steps.resolve.outputs.sha }}',
      short_sha: '${{ steps.resolve.outputs.short_sha }}',
      tag: '${{ steps.resolve.outputs.tag }}',
    });
  });

  it('feeds the caller and pull-request context through the environment', () => {
    expect(resolveStep().env).toMatchObject({
      EVENT_NAME: '${{ github.event_name }}',
      REF: '${{ github.ref }}',
      SHA: '${{ github.sha }}',
      TAG: '${{ inputs.tag }}',
      WORKFLOW_REF: '${{ github.workflow_ref }}',
      PR_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      PR_LABEL: '${{ github.event.label.name }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
    });
    // The prepare job reads no repository variable: there is no package gate.
    expect(resolveStep().env).not.toHaveProperty('GHCR_PACKAGES_PRIVATE');
    expect(resolveStep().run).toContain('GITHUB_OUTPUT');
  });

  it('never runs from a fork', () => {
    expect(prepare.if).toBe("github.repository == 'raidenyn/line-mcp'");
  });
});

const publish = workflow.jobs.publish as {
  environment?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
  strategy?: { 'fail-fast'?: boolean; matrix?: { include?: Array<Record<string, string>> } };
};

const tagLines = (step: Step) =>
  String(step.with?.tags)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const allowlistStep = () => publish.steps.find((step) => step.name === 'Assert tag allowlist')!;

function runAllowlist(pr: string, tags: string[]) {
  return spawnSync('bash', ['-c', allowlistStep().run!], {
    encoding: 'utf8',
    env: { ...process.env, PR: pr, TAGS: tags.join('\n') },
  });
}

describe('publish job', () => {
  it('gates on prepare, uses the protected environment, and maps both targets', () => {
    expect(publish.needs).toBe('prepare');
    expect(publish.environment).toBe('ghcr-publish');
    expect(publish.if).toBe("needs.prepare.outputs.publish == 'true'");
    expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(publish.strategy?.matrix?.include).toEqual([
      { target: 'server', image: 'line-mcp-full' },
      { target: 'line-mcp', image: 'line-mcp' },
    ]);
  });

  it('checks out the resolved commit, verifies it, and logs in with the workflow token', () => {
    const checkout = publish.steps.find((step) => step.uses === 'actions/checkout@v7')!;
    expect(checkout.with).toMatchObject({ ref: '${{ needs.prepare.outputs.ref }}' });
    const verify = publish.steps.find((step) => step.name === 'Verify checked-out commit')!;
    expect(verify.run).toContain('git rev-parse HEAD');
    expect(verify.run).toContain('${{ needs.prepare.outputs.sha }}');
    const logins = publish.steps.filter((step) => step.uses === 'docker/login-action@v4');
    expect(logins).toHaveLength(1);
    expect(logins[0].with).toEqual({
      registry: 'ghcr.io',
      username: '${{ github.actor }}',
      password: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(source).not.toContain('docker.io');
    expect(source).not.toContain('DOCKERHUB');
  });

  it('prevents automatic latest and gates every moving tag on the newest release', () => {
    const step = publish.steps.find((candidate) => candidate.id === 'meta-release')!;
    expect(step.name).toBe('Extract release metadata');
    expect(step.uses).toBe('docker/metadata-action@v6');
    expect(step.if).toBe("needs.prepare.outputs.tag != ''");
    expect(step.with).toMatchObject({
      images: 'ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}',
      flavor: 'latest=false',
    });
    expect(String(step.with?.tags)).not.toContain('type=sha');
    // Each complete line, so a dropped or weakened gate cannot pass unnoticed.
    expect(tagLines(step)).toEqual([
      'type=semver,pattern={{version}},value=${{ needs.prepare.outputs.tag }}',
      "type=semver,pattern={{major}}.{{minor}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' }}",
      "type=semver,pattern={{major}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' && needs.prepare.outputs.major != '0' }}",
      "type=raw,value=latest,enable=${{ needs.prepare.outputs.latest == 'true' }}",
      'type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}',
    ]);
  });

  it('publishes a labeled pull request as only pr-<number> and sha-<short>', () => {
    const step = publish.steps.find((candidate) => candidate.id === 'meta-pr')!;
    expect(step.name).toBe('Metadata (pull request)');
    expect(step.uses).toBe('docker/metadata-action@v6');
    expect(step.if).toBe("needs.prepare.outputs.pr != ''");
    expect(step.with).toMatchObject({
      images: 'ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}',
      flavor: 'latest=false',
    });
    expect(tagLines(step)).toEqual([
      'type=raw,value=pr-${{ needs.prepare.outputs.pr }}',
      'type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}',
    ]);
    // A PR image never receives a moving release tag.
    expect(String(step.with?.tags)).not.toContain('latest');
  });

  it('labels each image with the built commit and a separated licence', () => {
    for (const id of ['meta-release', 'meta-pr']) {
      const step = publish.steps.find((candidate) => candidate.id === id)!;
      expect(String(step.with?.labels)).toContain(
        'org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}',
      );
      // The bundled LINE binaries are not covered by this project's license.
      expect(String(step.with?.labels)).toContain(
        'org.opencontainers.image.licenses=NOASSERTION',
      );
    }
  });

  it('builds only from the metadata step that ran', () => {
    const build = publish.steps.find((step) => step.id === 'build')!;
    expect(build.uses).toBe('docker/build-push-action@v7');
    expect(build.with).toMatchObject({
      context: '.',
      target: '${{ matrix.target }}',
      platforms: 'linux/amd64',
      push: true,
      provenance: false,
      sbom: false,
      'cache-from':
        'type=registry,ref=ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:buildcache',
      'cache-to':
        'type=registry,ref=ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:buildcache,mode=max',
      labels: '${{ steps.meta-release.outputs.labels || steps.meta-pr.outputs.labels }}',
      tags: '${{ steps.meta-release.outputs.tags || steps.meta-pr.outputs.tags }}',
    });
  });

  it('asserts the push tag allowlist after metadata and before the build', () => {
    const step = allowlistStep();
    expect(step.run).toContain('TAGS');
    expect(step.env).toMatchObject({
      PR: '${{ needs.prepare.outputs.pr }}',
      TAGS: '${{ steps.meta-release.outputs.tags || steps.meta-pr.outputs.tags }}',
    });
    const lastMetadata = Math.max(
      publish.steps.findIndex((candidate) => candidate.id === 'meta-release'),
      publish.steps.findIndex((candidate) => candidate.id === 'meta-pr'),
    );
    const allowlistIndex = publish.steps.indexOf(step);
    const buildIndex = publish.steps.findIndex((candidate) => candidate.id === 'build');
    expect(allowlistIndex).toBeGreaterThan(lastMetadata);
    expect(allowlistIndex).toBeLessThan(buildIndex);
  });

  it('never exports layers to a GHA cache that forks could restore', () => {
    // A registry cache keeps the layers with the image it belongs to and avoids
    // a default-branch GHA cache, which fork pull-request workflows can restore.
    const build = publish.steps.find((step) => step.id === 'build')!;
    for (const key of ['cache-from', 'cache-to']) {
      const value = String(build.with?.[key]);
      expect(value.startsWith('type=registry,ref=ghcr.io/')).toBe(true);
      expect(value).toContain(':buildcache');
    }
    expect(String(build.with?.['cache-to'])).toContain('mode=max');
    // The login step must precede the build, otherwise cache push and pull
    // would be anonymous.
    const login = publish.steps.findIndex((step) => step.uses === 'docker/login-action@v4');
    const buildIndex = publish.steps.findIndex((step) => step.id === 'build');
    expect(login).toBeGreaterThanOrEqual(0);
    expect(login).toBeLessThan(buildIndex);
  });
});

type AllowlistCase = {
  exit: number;
  name: string;
  pr: string;
  tags: string[];
};

const image = 'ghcr.io/owner/line-mcp-full';

const allowlistCases: AllowlistCase[] = [
  {
    name: 'a pull request may push pr-<number> and sha-<short>',
    pr: '96',
    tags: [`${image}:pr-96`, `${image}:sha-abc1234`],
    exit: 0,
  },
  {
    name: 'one forbidden tag fails the whole pull-request build',
    pr: '96',
    tags: [`${image}:pr-96`, `${image}:latest`],
    exit: 1,
  },
  {
    name: 'a pull request may not push latest',
    pr: '96',
    tags: [`${image}:latest`],
    exit: 1,
  },
  {
    name: 'a pull request may not push a patch version',
    pr: '96',
    tags: [`${image}:1.2.3`],
    exit: 1,
  },
  {
    name: 'a pull request may not push a minor version',
    pr: '96',
    tags: [`${image}:1.2`],
    exit: 1,
  },
  {
    name: 'a pull request may not push a bare major version',
    pr: '96',
    tags: [`${image}:1`],
    exit: 1,
  },
  {
    name: 'a pull request may not push the retired preview tag',
    pr: '96',
    tags: [`${image}:edge`],
    exit: 1,
  },
  {
    name: 'a pull request may not push a non-numeric pr tag',
    pr: '96',
    tags: [`${image}:pr-x`],
    exit: 1,
  },
  {
    name: 'a pull request may not push an uppercase short sha',
    pr: '96',
    tags: [`${image}:sha-ABC1234`],
    exit: 1,
  },
  {
    name: 'a release may not push a pull-request tag',
    pr: '',
    tags: [`${image}:pr-96`],
    exit: 1,
  },
  {
    name: 'a release may push its version tags',
    pr: '',
    tags: [
      `${image}:1.2.3`,
      `${image}:1.2`,
      `${image}:1`,
      `${image}:latest`,
      `${image}:sha-abc1234`,
    ],
    exit: 0,
  },
];

describe('assert tag allowlist script', () => {
  it.each(allowlistCases)('$name', (testCase) => {
    const result = runAllowlist(testCase.pr, testCase.tags);
    expect(result.status).toBe(testCase.exit);
    if (testCase.exit !== 0) {
      expect(result.stderr).toContain('::error::');
    }
  });
});
