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
  it('runs on main pushes, release dispatch, published releases, labeled pull requests, and manual dispatch', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      repository_dispatch: { types: ['release-published'] },
      release: { types: ['published'] },
      pull_request: { types: ['labeled'] },
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
    // Only adding a label may publish: a push or edit to a PR never republishes.
    expect(workflow.on).not.toHaveProperty('pull_request_target');
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

const SHA_MAIN = 'a'.repeat(40);
const SHA_TAG = 'b'.repeat(40);
const SHA_PR = 'e'.repeat(40);

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

const OUTPUT_KEYS = [
  'edge',
  'latest',
  'major',
  'pr',
  'publish',
  'ref',
  'sha',
  'short_sha',
  'tag',
];
const SHORT_TAG = SHA_TAG.slice(0, 7);
const SHORT_MAIN = SHA_MAIN.slice(0, 7);
const SHORT_PR = SHA_PR.slice(0, 7);

// Every success case states the complete output map, so an extra or missing
// key in the emitted outputs cannot slip through.
const defaults = (overrides: Record<string, string>): Record<string, string> => ({
  edge: 'false',
  latest: 'false',
  major: '',
  pr: '',
  publish: 'true',
  ref: SHA_MAIN,
  sha: SHA_MAIN,
  short_sha: SHORT_MAIN,
  tag: '',
  ...overrides,
});

const cases: ResolveCase[] = [
  {
    name: 'prerelease with a malformed tag is skipped, not rejected',
    env: { EVENT_NAME: 'release', RELEASE_PRERELEASE: 'true', RELEASE_TAG: 'v1.2.3-rc.1' },
    exit: 0,
    expect: defaults({ publish: 'false' }),
  },
  {
    name: 'prerelease is skipped before the private-package gate even without the variable',
    env: {
      EVENT_NAME: 'release',
      GHCR_PACKAGES_PRIVATE: '',
      RELEASE_PRERELEASE: 'true',
      RELEASE_TAG: 'v1.2.3',
    },
    exit: 0,
    expect: defaults({ publish: 'false' }),
  },
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
    expect: defaults({ pr: '96', ref: SHA_PR, sha: SHA_PR, short_sha: SHORT_PR }),
  },
  {
    name: 'another label on a pull request publishes nothing',
    env: {
      EVENT_NAME: 'pull_request',
      PR_HEAD_REPO: 'owner/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: 'bug',
      PR_NUMBER: '96',
    },
    exit: 0,
    expect: defaults({ publish: 'false' }),
  },
  {
    name: 'an unlabeled pull request succeeds even without the private bootstrap variable',
    env: {
      EVENT_NAME: 'pull_request',
      GHCR_PACKAGES_PRIVATE: '',
      PR_HEAD_REPO: 'owner/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: 'bug',
      PR_NUMBER: '96',
    },
    exit: 0,
    expect: defaults({ publish: 'false' }),
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
    expect: defaults({ publish: 'false' }),
    stderr: '::warning::fork pull requests cannot publish images',
  },
  {
    name: 'a labeled pull request still requires the private bootstrap',
    env: {
      EVENT_NAME: 'pull_request',
      GHCR_PACKAGES_PRIVATE: '',
      PR_HEAD_REPO: 'owner/repo',
      PR_HEAD_SHA: SHA_PR,
      PR_LABEL: 'publish-docker',
      PR_NUMBER: '96',
    },
    exit: 1,
    expect: {},
    stderr: 'GHCR Private-Package Bootstrap',
  },
  {
    name: 'dispatch without a tag fails',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: '' },
    exit: 1,
    expect: {},
    stderr: 'carried no tag',
  },
  {
    name: 'publication is refused until the private bootstrap is recorded',
    env: { EVENT_NAME: 'push', GHCR_PACKAGES_PRIVATE: '' },
    exit: 1,
    expect: {},
    stderr: 'GHCR Private-Package Bootstrap',
  },
  {
    name: 'two-component tag is rejected',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2' },
    exit: 1,
    expect: {},
  },
  {
    name: 'tagged manual dispatch off main is rejected',
    env: { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/x', INPUT_TAG: 'v1.2.3' },
    exit: 1,
    expect: {},
  },
  {
    name: 'untagged manual dispatch off main is rejected',
    env: { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/x', INPUT_TAG: '' },
    exit: 1,
    expect: {},
  },
  {
    name: 'annotated tag resolves the peeled commit',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3', FAKE_ANNOTATED: '1' },
    tags: ['v1.2.3'],
    exit: 0,
    expect: defaults({
      latest: 'true',
      major: '1',
      ref: 'refs/tags/v1.2.3',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.2.3',
    }),
  },
  {
    name: 'lightweight tag falls back to the direct ref',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3', FAKE_ANNOTATED: '0' },
    exit: 0,
    expect: defaults({
      major: '1',
      ref: 'refs/tags/v1.2.3',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.2.3',
    }),
  },
  {
    name: 'a newer release tag makes this release not newest',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3' },
    tags: ['v1.2.3', 'v1.3.0'],
    exit: 0,
    expect: defaults({
      latest: 'false',
      major: '1',
      ref: 'refs/tags/v1.2.3',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.2.3',
    }),
  },
  {
    name: 'a release candidate cannot outrank its stable release',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.3.0' },
    tags: ['v1.3.0', 'v1.3.0-rc.1'],
    exit: 0,
    expect: defaults({
      latest: 'true',
      major: '1',
      ref: 'refs/tags/v1.3.0',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.3.0',
    }),
  },
  {
    name: 'zero major is parsed but never published as a bare major tag',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v0.2.0' },
    tags: ['v0.2.0'],
    exit: 0,
    expect: defaults({
      latest: 'true',
      major: '0',
      ref: 'refs/tags/v0.2.0',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v0.2.0',
    }),
  },
  {
    name: 'edge holds when main has moved on',
    env: { EVENT_NAME: 'push', FAKE_MAIN: 'c'.repeat(40) },
    exit: 0,
    expect: defaults({ edge: 'false' }),
  },
  {
    name: 'edge advances when this run still matches main',
    env: { EVENT_NAME: 'push', FAKE_MAIN: SHA_MAIN },
    exit: 0,
    expect: defaults({ edge: 'true' }),
  },
  {
    name: 'untagged manual dispatch from main moves edge',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_MAIN: SHA_MAIN },
    exit: 0,
    expect: defaults({ edge: 'true', ref: SHA_MAIN }),
  },
  {
    name: 'untagged manual dispatch at a stale head does not move edge',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_MAIN: 'c'.repeat(40) },
    exit: 0,
    expect: defaults({ edge: 'false' }),
  },
  {
    name: 'release event publishes the release tag',
    env: { EVENT_NAME: 'release', FAKE_ANNOTATED: '0', RELEASE_TAG: 'v1.2.3' },
    tags: ['v1.2.3'],
    exit: 0,
    expect: defaults({
      latest: 'true',
      major: '1',
      ref: 'refs/tags/v1.2.3',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.2.3',
    }),
  },
  {
    name: 'tagged manual dispatch from main publishes the tag',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_ANNOTATED: '0', INPUT_TAG: 'v1.2.3' },
    tags: ['v1.2.3'],
    exit: 0,
    expect: defaults({
      latest: 'true',
      major: '1',
      ref: 'refs/tags/v1.2.3',
      sha: SHA_TAG,
      short_sha: SHORT_TAG,
      tag: 'v1.2.3',
    }),
  },
  {
    name: 'a tag missing from the remote fails',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3', FAKE_TAG_MISSING: '1' },
    exit: 1,
    expect: {},
    stderr: 'cannot resolve',
  },
  {
    name: 'a failed tag listing fails instead of silently defaulting latest',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3', FAKE_TAGS_FAIL: '1' },
    exit: 1,
    expect: {},
  },
];

function runResolve(testCase: ResolveCase) {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'));
  const fakeGit = join(dir, 'git');
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *refs/heads/main* && "$args" != *--tags* ]]; then
  printf '%s\trefs/heads/main\n' "\${FAKE_MAIN:-${SHA_MAIN}}"
elif [[ "$args" == *--tags* ]]; then
  if [ "\${FAKE_TAGS_FAIL:-0}" = 1 ]; then
    exit 1
  fi
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    printf '%s\trefs/tags/%s\n' "${SHA_TAG}" "$tag"
  done <<< "\${FAKE_TAGS:-}"
elif [[ "$args" == *'^{}'* ]]; then
  if [ "\${FAKE_ANNOTATED:-1}" = 1 ] && [ "\${FAKE_TAG_MISSING:-0}" != 1 ]; then
    printf '%s\trefs/tags/peeled^{}\n' "${SHA_TAG}"
  fi
elif [[ "$args" == *refs/tags/* ]]; then
  if [ "\${FAKE_TAG_MISSING:-0}" != 1 ]; then
    if [ "\${FAKE_ANNOTATED:-1}" = 1 ]; then
      printf '%s\trefs/tags/tag\n' "dddddddddddddddddddddddddddddddddddddddd"
    else
      printf '%s\trefs/tags/tag\n' "${SHA_TAG}"
    fi
  fi
else
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
      DISPATCH_PAYLOAD: '{}',
      DISPATCH_TAG: '',
      FAKE_TAGS: (testCase.tags ?? []).join('\n'),
      GHCR_PACKAGES_PRIVATE: 'true',
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: 'https://github.com',
      INPUT_TAG: '',
      PATH: `${dir}:${process.env.PATH}`,
      PR_HEAD_REPO: '',
      PR_HEAD_SHA: '',
      PR_LABEL: '',
      PR_NUMBER: '',
      REF: 'refs/heads/main',
      RELEASE_PRERELEASE: 'false',
      RELEASE_TAG: '',
      SHA: SHA_MAIN,
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
    }
  });

  it('exposes every output the publish job consumes', () => {
    expect(Object.keys(prepare.outputs).sort()).toEqual(OUTPUT_KEYS);
    expect(prepare.outputs).toEqual({
      edge: '${{ steps.resolve.outputs.edge }}',
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

  it('feeds the event payload through the environment', () => {
    expect(resolveStep().env).toMatchObject({
      DISPATCH_PAYLOAD: '${{ toJSON(github.event.client_payload) }}',
      DISPATCH_TAG: '${{ github.event.client_payload.tag }}',
      INPUT_TAG: '${{ inputs.tag }}',
      PR_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      PR_LABEL: '${{ github.event.label.name }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      RELEASE_PRERELEASE: '${{ github.event.release.prerelease }}',
      RELEASE_TAG: '${{ github.event.release.tag_name }}',
    });
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
  steps: Step[];
  strategy?: { 'fail-fast'?: boolean; matrix?: { include?: Array<Record<string, string>> } };
};

const tagLines = (step: Step) =>
  String(step.with?.tags)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

describe('publish job', () => {
  it('gates on prepare, uses the protected environment, and maps both targets', () => {
    expect(publish.needs).toBe('prepare');
    expect(publish.environment).toBe('ghcr-publish');
    expect(publish.if).toBe("needs.prepare.outputs.publish == 'true'");
    expect(publish.strategy?.matrix?.include).toEqual([
      { target: 'server', image: 'line-mcp-full' },
      { target: 'line-mcp', image: 'line-mcp' },
    ]);
  });

  it('checks out the resolved ref, verifies the commit, and uses the isolated registry token', () => {
    const checkout = publish.steps.find((step) => step.uses === 'actions/checkout@v4')!;
    expect(checkout.with).toMatchObject({ ref: '${{ needs.prepare.outputs.ref }}' });
    const verify = publish.steps.find((step) => step.name === 'Verify checked-out commit')!;
    expect(verify.run).toContain('git rev-parse HEAD');
    expect(verify.run).toContain('${{ needs.prepare.outputs.sha }}');
    const logins = publish.steps.filter((step) => step.uses === 'docker/login-action@v3');
    expect(logins).toHaveLength(1);
    expect(logins[0].with).toMatchObject({
      registry: 'ghcr.io',
      username: '${{ github.repository_owner }}',
      password: '${{ secrets.GHCR_PUBLISH_TOKEN }}',
    });
    expect(String(logins[0].with?.password)).not.toContain('GITHUB_TOKEN');
    expect(source).not.toContain('docker.io');
    expect(source).not.toContain('DOCKERHUB');
  });

  it('prevents automatic latest and gates every moving tag on the newest release', () => {
    const release = publish.steps.find((step) => step.id === 'meta-release')!;
    const edge = publish.steps.find((step) => step.id === 'meta-edge')!;
    const tags = String(release.with?.tags);
    expect(release.with?.flavor).toBe('latest=false');
    expect(edge.with?.flavor).toBe('latest=false');
    expect(tags).toContain('type=semver,pattern={{version}}');
    expect(tags).toContain("enable=${{ needs.prepare.outputs.latest == 'true' }}");
    expect(tags).toContain("needs.prepare.outputs.major != '0'");
    expect(tags).toContain('type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}');
    expect(tags).not.toContain('type=sha');
    expect(String(edge.with?.tags)).toContain(
      "type=raw,value=edge,enable=${{ needs.prepare.outputs.edge == 'true' }}",
    );
    expect(String(edge.with?.tags)).not.toContain('type=sha');

    // Each complete line, so a dropped or weakened gate cannot pass unnoticed.
    expect(tagLines(release)).toEqual([
      'type=semver,pattern={{version}},value=${{ needs.prepare.outputs.tag }}',
      "type=semver,pattern={{major}}.{{minor}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' }}",
      "type=semver,pattern={{major}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' && needs.prepare.outputs.major != '0' }}",
      "type=raw,value=latest,enable=${{ needs.prepare.outputs.latest == 'true' }}",
      'type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}',
    ]);
    expect(tagLines(edge)).toEqual([
      "type=raw,value=edge,enable=${{ needs.prepare.outputs.edge == 'true' }}",
      'type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}',
    ]);

    // Releases and edge builds share one build step, so exactly one metadata
    // step may run: the tagged one for a tag, the edge one for a tagless
    // non-PR run, and the PR one only for a labeled PR.
    expect(release.if).toBe("needs.prepare.outputs.tag != ''");
    expect(edge.if).toBe("needs.prepare.outputs.tag == '' && needs.prepare.outputs.pr == ''");
  });

  it('publishes a labeled pull request as only pr-<number> and sha-<short>', () => {
    const pr = publish.steps.find((step) => step.id === 'meta-pr')!;
    expect(pr.name).toBe('Metadata (pull request)');
    expect(pr.uses).toBe('docker/metadata-action@v5');
    expect(pr.if).toBe("needs.prepare.outputs.pr != ''");
    expect(pr.with).toMatchObject({
      images: 'ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}',
      flavor: 'latest=false',
    });
    expect(tagLines(pr)).toEqual([
      'type=raw,value=pr-${{ needs.prepare.outputs.pr }}',
      'type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}',
    ]);
    // A PR image never receives a moving release or edge tag.
    expect(String(pr.with?.tags)).not.toContain('latest');
    expect(String(pr.with?.tags)).not.toContain('edge');
  });

  it('labels each image with the built commit', () => {
    for (const id of ['meta-release', 'meta-edge', 'meta-pr']) {
      const step = publish.steps.find((candidate) => candidate.id === id)!;
      expect(String(step.with?.labels)).toContain(
        'org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}',
      );
    }
  });

  it('builds amd64, pushes, and keeps the layer cache in the private package', () => {
    const build = publish.steps.find((step) => step.id === 'build')!;
    expect(build.uses).toBe('docker/build-push-action@v6');
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
      labels:
        '${{ steps.meta-release.outputs.labels || steps.meta-edge.outputs.labels || steps.meta-pr.outputs.labels }}',
      tags: '${{ steps.meta-release.outputs.tags || steps.meta-edge.outputs.tags || steps.meta-pr.outputs.tags }}',
    });
  });

  it('never exports layers to a GHA cache that forks could restore', () => {
    // The images carry LINE's proprietary LTSM assets, and fork pull-request
    // workflows can restore default-branch GHA caches, so no GHA cache may
    // ever carry these layers.
    expect(source).not.toContain('type=gha');
    expect(source).not.toContain('gha');
    const build = publish.steps.find((step) => step.id === 'build')!;
    for (const key of ['cache-from', 'cache-to']) {
      const value = String(build.with?.[key]);
      expect(value.startsWith('type=registry,ref=ghcr.io/')).toBe(true);
      expect(value).toContain(':buildcache');
    }
    expect(String(build.with?.['cache-to'])).toContain('mode=max');
    // The login step must precede the build, otherwise cache push and pull
    // would be anonymous.
    const login = publish.steps.findIndex((step) => step.uses === 'docker/login-action@v3');
    const buildIndex = publish.steps.findIndex((step) => step.id === 'build');
    expect(login).toBeGreaterThanOrEqual(0);
    expect(login).toBeLessThan(buildIndex);
  });
});
