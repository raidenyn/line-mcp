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

const SHA_MAIN = 'a'.repeat(40);
const SHA_TAG = 'b'.repeat(40);

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

const cases: ResolveCase[] = [
  {
    name: 'prerelease with a malformed tag is skipped, not rejected',
    env: { EVENT_NAME: 'release', RELEASE_PRERELEASE: 'true', RELEASE_TAG: 'v1.2.3-rc.1' },
    exit: 0,
    expect: { publish: 'false', tag: '' },
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
    expect: {
      latest: 'true',
      major: '1',
      publish: 'true',
      sha: SHA_TAG,
      short_sha: SHA_TAG.slice(0, 7),
    },
  },
  {
    name: 'lightweight tag falls back to the direct ref',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3', FAKE_ANNOTATED: '0' },
    exit: 0,
    expect: { sha: SHA_TAG },
  },
  {
    name: 'a newer release tag makes this release not newest',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.2.3' },
    tags: ['v1.2.3', 'v1.3.0'],
    exit: 0,
    expect: { latest: 'false' },
  },
  {
    name: 'a release candidate cannot outrank its stable release',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v1.3.0' },
    tags: ['v1.3.0', 'v1.3.0-rc.1'],
    exit: 0,
    expect: { latest: 'true' },
  },
  {
    name: 'zero major is parsed but never published as a bare major tag',
    env: { EVENT_NAME: 'repository_dispatch', DISPATCH_TAG: 'v0.2.0' },
    tags: ['v0.2.0'],
    exit: 0,
    expect: { major: '0' },
  },
  {
    name: 'edge holds when main has moved on',
    env: { EVENT_NAME: 'push', FAKE_MAIN: 'c'.repeat(40) },
    exit: 0,
    expect: { edge: 'false' },
  },
  {
    name: 'edge advances when this run still matches main',
    env: { EVENT_NAME: 'push', FAKE_MAIN: SHA_MAIN },
    exit: 0,
    expect: { edge: 'true' },
  },
  {
    name: 'untagged manual dispatch from main moves edge',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_MAIN: SHA_MAIN },
    exit: 0,
    expect: { edge: 'true', ref: SHA_MAIN },
  },
  {
    name: 'untagged manual dispatch at a stale head does not move edge',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_MAIN: 'c'.repeat(40) },
    exit: 0,
    expect: { edge: 'false' },
  },
  {
    name: 'release event publishes the release tag',
    env: { EVENT_NAME: 'release', FAKE_ANNOTATED: '0', RELEASE_TAG: 'v1.2.3' },
    tags: ['v1.2.3'],
    exit: 0,
    expect: { latest: 'true', publish: 'true', tag: 'v1.2.3' },
  },
  {
    name: 'tagged manual dispatch from main publishes the tag',
    env: { EVENT_NAME: 'workflow_dispatch', FAKE_ANNOTATED: '0', INPUT_TAG: 'v1.2.3' },
    tags: ['v1.2.3'],
    exit: 0,
    expect: { publish: 'true', tag: 'v1.2.3' },
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
      REF: 'refs/heads/main',
      RELEASE_PRERELEASE: 'false',
      RELEASE_TAG: '',
      SHA: SHA_MAIN,
      ...testCase.env,
    },
  });
  const parsed = Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=')];
      }),
  );
  return { parsed, status: result.status, stderr: result.stderr };
}

describe('prepare resolve script', () => {
  it.each(cases)('$name', (testCase) => {
    const { parsed, status, stderr } = runResolve(testCase);
    expect(status).toBe(testCase.exit);
    if (testCase.stderr) {
      expect(stderr).toContain(testCase.stderr);
    }
    for (const [key, value] of Object.entries(testCase.expect)) {
      expect(parsed).toHaveProperty(key, value);
    }
  });

  it('exposes every output the publish job consumes', () => {
    expect(Object.keys(prepare.outputs).sort()).toEqual(
      ['edge', 'latest', 'major', 'publish', 'ref', 'sha', 'short_sha', 'tag'],
    );
  });

  it('feeds the event payload through the environment', () => {
    expect(resolveStep().env).toMatchObject({
      DISPATCH_PAYLOAD: '${{ toJSON(github.event.client_payload) }}',
      DISPATCH_TAG: '${{ github.event.client_payload.tag }}',
      INPUT_TAG: '${{ inputs.tag }}',
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
  });

  it('labels each image with the built commit', () => {
    for (const id of ['meta-release', 'meta-edge']) {
      const step = publish.steps.find((candidate) => candidate.id === id)!;
      expect(String(step.with?.labels)).toContain(
        'org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}',
      );
    }
  });

  it('builds amd64, pushes, and scopes cache per image', () => {
    const build = publish.steps.find((step) => step.id === 'build')!;
    expect(build.uses).toBe('docker/build-push-action@v6');
    expect(build.with).toMatchObject({
      context: '.',
      target: '${{ matrix.target }}',
      platforms: 'linux/amd64',
      push: true,
      provenance: false,
      sbom: false,
      'cache-from': 'type=gha,scope=${{ matrix.image }}',
      'cache-to': 'type=gha,scope=${{ matrix.image }},mode=max',
      labels: '${{ steps.meta-release.outputs.labels || steps.meta-edge.outputs.labels }}',
      tags: '${{ steps.meta-release.outputs.tags || steps.meta-edge.outputs.tags }}',
    });
  });
});
