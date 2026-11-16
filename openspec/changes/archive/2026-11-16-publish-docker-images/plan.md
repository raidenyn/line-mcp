# Docker Image Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish both existing Docker runtime targets to private GitHub Container Registry packages on main pushes and releases, with tags that identify the built commit and moving tags that never go backwards.

**Architecture:** A single workflow with two jobs. `prepare` turns whichever event fired into a checkout ref, tag, commit SHA, newest-stable-release flag, and major version. `publish` runs a two-entry matrix (`server → line-mcp-full`, `line-mcp → line-mcp`) that checks out that ref and builds/pushes `linux/amd64` images to GHCR with `docker/metadata-action` tags, `flavor: latest=false`, an explicit revision label, and per-image registry cache inside the private packages.

**Tech Stack:** GitHub Actions, `docker/setup-buildx-action`, `docker/metadata-action`, `docker/build-push-action`, Vitest + `yaml` for workflow contract tests.

**Spec:** `openspec/changes/publish-docker-images/specs/docker-image-publishing/spec.md` (design: `openspec/changes/publish-docker-images/design.md`, tasks: `openspec/changes/publish-docker-images/tasks.md`)

## Global Constraints

- Images are `ghcr.io/<owner>/line-mcp-full` (target `server`) and `ghcr.io/<owner>/line-mcp` (target `line-mcp`), `linux/amd64` only.
- GHCR only. Packages stay private. No Docker Hub, no `docker.io` login, no public registry.
- Release tags: `X.Y.Z` always; `X.Y`, `X`, and `latest` only when the tag is the newest stable remote `v*`; never `X` when the major is `0`; plus `sha-<short>`. Main tags: `edge`, `sha-<short>`.
- `flavor: latest=false` on both metadata steps; never `type=sha`; revision label comes from `prepare`.
- No `pull_request` trigger; no push from untrusted builds.
- Workflow permissions are exactly `contents: read`; the registry uses `GHCR_PUBLISH_TOKEN` from the `ghcr-publish` environment, never `GITHUB_TOKEN`. `provenance: false`, `sbom: false`.
- Concurrency: group `publish-docker`, `cancel-in-progress: false`, `queue: max`.
- Publication refuses unless `vars.GHCR_PACKAGES_PRIVATE == 'true'`; both packages are linked with an asset-free placeholder and bootstrapped private (inherited access disabled, no repository Actions access) by a maintainer before merge.
- The workflow never runs outside `raidenyn/line-mcp` (`prepare` carries a repository guard).
- Every `workflow_dispatch`, tagged or untagged, must run from `refs/heads/main`.
- `edge` advances only when the published commit still equals the remote `main` head.
- The build job verifies `git rev-parse HEAD` equals the commit `prepare` resolved.
- Do not modify `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `THIRD_PARTY_NOTICES.md`, `provenance.json`, or the README provenance-policy bullet.
- Conventional Commits; every task ends in its own commit. Pre-PR gate: `npm run lint && npm run build && npm run test:unit && npm run test:smoke`.
- Work in a `feat/publish-docker-images` branch created from `origin/main` (the current checkout may already be a dedicated branch; if so, stay on it).

## Review Focus

- The merge's own `main` push runs before the bootstrap → run fails loudly with a runbook pointer, no package is created. (Task 2 bootstrap case.)
- A maintainer publishes a GitHub prerelease → run succeeds, pushes nothing, no tag moves. (Task 2 behavioural cases.)
- A manual dispatch re-publishes `v1.2.0` after `main` advanced → `sha-<short>` and the revision label name the `v1.2.0` commit, and `latest`/`1.x`/`1` do not move. (Task 2 commit-resolution cases + Task 3 gating test; digest equality is post-merge only.)
- A manual dispatch, tagged or untagged, from a non-`main` branch → run fails before any push. (Task 2 behavioural case.)
- A release dispatch with a missing or malformed tag → run fails before any push. (Task 2 behavioural cases.)
- A queued `edge` run executes after a newer push → `edge` stays on the newer commit; only `sha-<short>` is added. (Task 2 `edge` case + Task 3 `enable` assertion.)
- A user without granted package access tries to pull → registry denies; docs say access is granted by the maintainer. (Task 4 documentation + Task 5 post-merge check.)

---

### Task 1: Workflow triggers, permissions, and concurrency

**Files:**
- Create: `.github/workflows/publish-docker.yml`
- Create: `tests/release/docker-publish-workflow.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workflow name `Publish Docker`; parsed `workflow` object and `source` string reused by every later task; concurrency group `publish-docker` with `queue: max`.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: FAIL — `ENOENT` for `.github/workflows/publish-docker.yml`.

- [ ] **Step 3: Create `.github/workflows/publish-docker.yml`**

```yaml
# Publishes both runtime targets to GitHub Container Registry.
# GHCR only: every image bundles LINE's proprietary LTSM assets, and the
# repository's provenance policy approves Docker images for internal use only.
# The packages must stay private; do not add a Docker Hub or other public push.
name: Publish Docker

on:
  push:
    branches: [main]
  repository_dispatch:
    types: [release-published]
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: >-
          Release tag to publish (e.g. v1.2.3). Leave empty to publish edge
          from the current main commit.
        required: false
        type: string

permissions:
  contents: read

concurrency:
  group: publish-docker
  cancel-in-progress: false
  queue: max
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts
git commit -m "ci: add docker publish workflow triggers"
```

---

### Task 2: Resolve publication inputs from the event

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Test: `tests/release/docker-publish-workflow.test.ts`

**Interfaces:**
- Consumes: Task 1's file and parsed fixture.
- Produces: `jobs.prepare` with `outputs.ref`, `outputs.tag`, `outputs.publish`, `outputs.latest`, `outputs.edge`, `outputs.sha`, `outputs.short_sha`, `outputs.major` (all strings), written by the step with `id: resolve`.

- [ ] **Step 1: Add failing tests**

`readFileSync` is already imported by the Task 1 tests in this file; add only
the new imports below (`spawnSync`, and `chmodSync`/`mkdtempSync`/`writeFileSync`
from `node:fs`).

```typescript
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  printf '%s\\trefs/heads/main\\n' "\${FAKE_MAIN:-${SHA_MAIN}}"
elif [[ "$args" == *--tags* ]]; then
  if [ "\${FAKE_TAGS_FAIL:-0}" = 1 ]; then
    exit 1
  fi
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    printf '%s\\trefs/tags/%s\\n' "${SHA_TAG}" "$tag"
  done <<< "\${FAKE_TAGS:-}"
elif [[ "$args" == *'^{}'* ]]; then
  if [ "\${FAKE_ANNOTATED:-1}" = 1 ] && [ "\${FAKE_TAG_MISSING:-0}" != 1 ]; then
    printf '%s\\trefs/tags/peeled^{}\\n' "${SHA_TAG}"
  fi
elif [[ "$args" == *refs/tags/* ]]; then
  if [ "\${FAKE_TAG_MISSING:-0}" != 1 ]; then
    if [ "\${FAKE_ANNOTATED:-1}" = 1 ]; then
      printf '%s\\trefs/tags/tag\\n' "dddddddddddddddddddddddddddddddddddddddd"
    else
      printf '%s\\trefs/tags/tag\\n' "${SHA_TAG}"
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: FAIL — `jobs.prepare` is undefined.

- [ ] **Step 3: Add the `prepare` job**

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    if: github.repository == 'raidenyn/line-mcp'
    permissions:
      contents: read
    outputs:
      ref: ${{ steps.resolve.outputs.ref }}
      tag: ${{ steps.resolve.outputs.tag }}
      publish: ${{ steps.resolve.outputs.publish }}
      latest: ${{ steps.resolve.outputs.latest }}
      edge: ${{ steps.resolve.outputs.edge }}
      sha: ${{ steps.resolve.outputs.sha }}
      short_sha: ${{ steps.resolve.outputs.short_sha }}
      major: ${{ steps.resolve.outputs.major }}
    steps:
      - name: Resolve publication inputs
        id: resolve
        env:
          EVENT_NAME: ${{ github.event_name }}
          REF: ${{ github.ref }}
          SHA: ${{ github.sha }}
          DISPATCH_TAG: ${{ github.event.client_payload.tag }}
          DISPATCH_PAYLOAD: ${{ toJSON(github.event.client_payload) }}
          RELEASE_TAG: ${{ github.event.release.tag_name }}
          RELEASE_PRERELEASE: ${{ github.event.release.prerelease }}
          INPUT_TAG: ${{ inputs.tag }}
          GHCR_PACKAGES_PRIVATE: ${{ vars.GHCR_PACKAGES_PRIVATE }}
        shell: bash
        run: |
          set -euo pipefail

          publish=true
          latest=false
          edge=false
          major=''
          tag=''
          sha="$SHA"
          short_sha="${SHA:0:7}"
          ref="$SHA"

          write_outputs() {
            {
              printf 'publish=%s\n' "$publish"
              printf 'latest=%s\n' "$latest"
              printf 'edge=%s\n' "$edge"
              printf 'tag=%s\n' "$tag"
              printf 'sha=%s\n' "$sha"
              printf 'short_sha=%s\n' "$short_sha"
              printf 'major=%s\n' "$major"
              printf 'ref=%s\n' "$ref"
            } >> "$GITHUB_OUTPUT"
          }

          # Prereleases are skipped before any tag validation.
          if [ "$EVENT_NAME" = 'release' ] && [ "$RELEASE_PRERELEASE" = 'true' ]; then
            publish=false
            write_outputs
            exit 0
          fi

          # Never create a package from scratch: the bootstrap makes both
          # packages private (with inherited access disabled) before merge.
          if [ "${GHCR_PACKAGES_PRIVATE:-}" != 'true' ]; then
            printf '::error::GHCR_PACKAGES_PRIVATE is not true; run the GHCR Private-Package Bootstrap in docs/RELEASING.md first\n' >&2
            exit 1
          fi

          case "$EVENT_NAME" in
            repository_dispatch) tag="$DISPATCH_TAG" ;;
            release) tag="$RELEASE_TAG" ;;
            workflow_dispatch) tag="$INPUT_TAG" ;;
          esac

          if [ "$EVENT_NAME" = 'repository_dispatch' ] && [ -z "$tag" ]; then
            printf '::error::release-published dispatch carried no tag (payload: %s)\n' "$DISPATCH_PAYLOAD" >&2
            exit 1
          fi

          if [ -n "$tag" ] && ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            printf '::error::unsupported tag %s: expected vX.Y.Z\n' "$tag" >&2
            exit 1
          fi

          # Any manual dispatch, tagged or not, must run from main.
          if [ "$EVENT_NAME" = 'workflow_dispatch' ] && [ "$REF" != 'refs/heads/main' ]; then
            printf '::error::workflow_dispatch must run from refs/heads/main, got %s\n' "$REF" >&2
            exit 1
          fi

          REMOTE="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"

          if [ -n "$tag" ]; then
            sha=$(git ls-remote "$REMOTE" "refs/tags/$tag^{}" | cut -f1)
            if [ -z "$sha" ]; then
              sha=$(git ls-remote "$REMOTE" "refs/tags/$tag" | cut -f1)
            fi
            if [ -z "$sha" ]; then
              printf '::error::cannot resolve a commit for tag %s\n' "$tag" >&2
              exit 1
            fi
            short_sha="${sha:0:7}"
            major="${tag#v}"
            major="${major%%.*}"

            listing=$(git ls-remote --tags --refs --sort=-v:refname "$REMOTE" 'v*')
            newest=$(printf '%s\n' "$listing" \
              | sed 's#.*refs/tags/##' \
              | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
              | sort -V \
              | tail -n1)
            if [ "$newest" = "$tag" ]; then
              latest=true
            fi
          fi

          # `edge` only advances while this run still matches main's head, so a
          # queued run or a stale re-run cannot move it backwards.
          if [ -z "$tag" ]; then
            head=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
            if [ "$head" = "$sha" ]; then
              edge=true
            fi
          fi

          if [ -n "$tag" ]; then
            ref="refs/tags/$tag"
          else
            ref="$sha"
          fi

          write_outputs
```

The repository is public, so the anonymous `git ls-remote` works. If it ever
becomes private, switch to an authenticated `git ls-remote` or a checkout in
this job. Do not pass any registry credential into this job.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: PASS (all resolve cases plus the wiring tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts
git commit -m "ci: resolve docker publication inputs from events"
```

---

### Task 3: Publish both images to GHCR

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Test: `tests/release/docker-publish-workflow.test.ts`

**Interfaces:**
- Consumes: `needs.prepare.outputs.{ref,tag,publish,latest,edge,sha,short_sha,major}`.
- Produces: `jobs.publish` with matrix entries `{ target: 'server', image: 'line-mcp-full' }` and `{ target: 'line-mcp', image: 'line-mcp' }`; metadata steps `meta-release` and `meta-edge`; build step `build`.

- [ ] **Step 1: Add failing tests**

```typescript
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
      'cache-from': 'type=registry,ref=ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:buildcache',
      'cache-to': 'type=registry,ref=ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:buildcache,mode=max',
      labels: '${{ steps.meta-release.outputs.labels || steps.meta-edge.outputs.labels }}',
      tags: '${{ steps.meta-release.outputs.tags || steps.meta-edge.outputs.tags }}',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: FAIL — `jobs.publish` is undefined.

- [ ] **Step 3: Add the `publish` job**

Jobs and steps (exact ids and inputs):

1. `publish` with `runs-on: ubuntu-latest`, `environment: ghcr-publish`, `needs: prepare`, `if: needs.prepare.outputs.publish == 'true'`, matrix as above, `fail-fast: false`.
2. `actions/checkout@v4` with `ref: ${{ needs.prepare.outputs.ref }}`.
3. `Verify checked-out commit` (plain `run` step): `test "$(git rev-parse HEAD)" = "${{ needs.prepare.outputs.sha }}"`, so a tag moved between resolution and checkout cannot mislabel the image.
4. `docker/setup-buildx-action@v3`.
5. `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.repository_owner }}`, `password: ${{ secrets.GHCR_PUBLISH_TOKEN }}`.
6. `meta-release` (`id: meta-release`, `if: needs.prepare.outputs.tag != ''`), `docker/metadata-action@v5`,
   - `images: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}`
   - `flavor: latest=false`
   - `labels:` `org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}`
   - `tags`:

```yaml
type=semver,pattern={{version}},value=${{ needs.prepare.outputs.tag }}
type=semver,pattern={{major}}.{{minor}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' }}
type=semver,pattern={{major}},value=${{ needs.prepare.outputs.tag }},enable=${{ needs.prepare.outputs.latest == 'true' && needs.prepare.outputs.major != '0' }}
type=raw,value=latest,enable=${{ needs.prepare.outputs.latest == 'true' }}
type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}
```

7. `meta-edge` (`id: meta-edge`, `if: needs.prepare.outputs.tag == ''`), same `images`, `flavor: latest=false`, same `labels`, `tags`:

```yaml
type=raw,value=edge,enable=${{ needs.prepare.outputs.edge == 'true' }}
type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}
```

8. `build` (`id: build`), `docker/build-push-action@v6` with the inputs asserted above, including `context: .` and both the labels and tags selections.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts`
Expected: PASS (all resolve cases, prepare wiring, and publish tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts
git commit -m "ci: publish both docker targets to private ghcr"
```

---

### Task 4: Document private pulls, tags, and the runbook

**Files:**
- Modify: `README.md` (Docker section, CI/workflow list)
- Modify: `docs/RELEASING.md`
- Modify: `docs/ARCHITECTURE.md`
- Test: `tests/release/release-documentation.test.ts`

**Interfaces:**
- Consumes: image names, tag names, and the private-visibility rule from Tasks 1–3.
- Produces: documentation strings asserted below.

- [ ] **Step 1: Add failing assertions**

Extend `tests/release/release-documentation.test.ts`:

```typescript
it('documents authenticated pulls of the private images', () => {
  const readme = readFileSync('README.md', 'utf8');
  expect(readme).toContain('docker login ghcr.io');
  expect(readme).toContain('ghcr.io/raidenyn/line-mcp-full:');
  expect(readme).toContain('ghcr.io/raidenyn/line-mcp:');
  expect(readme).toContain('@sha256:');
  expect(readme).toContain('`edge`');
  expect(readme).toContain("`sha-<short>`");
  expect(readme).toContain('must stay private');
  expect(readme).toContain('must grant access');
});

it('documents publishing, re-publishing, and private visibility', () => {
  const runbook = readFileSync('docs/RELEASING.md', 'utf8');
  expect(runbook).toContain('## Docker Images');
  expect(runbook).toContain('### GHCR Private-Package Bootstrap');
  expect(runbook).toContain('GHCR_PACKAGES_PRIVATE');
  expect(runbook).toContain('GHCR_PUBLISH_TOKEN');
  expect(runbook).toContain('ghcr-publish');
  expect(runbook).toContain('Inherit access');
  expect(runbook).toContain('org.opencontainers.image.source');
  expect(runbook).toContain('Publish Docker');
  expect(runbook).toContain('must stay private');
  expect(runbook).toContain('read:packages');
  expect(runbook).toContain('released');
});

it('records the publication workflow in the architecture reference', () => {
  const architecture = readFileSync('docs/ARCHITECTURE.md', 'utf8');
  expect(architecture).toContain('publish-docker.yml');
  expect(architecture).toContain('ghcr.io');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/release/release-documentation.test.ts`
Expected: FAIL on the first new assertion.

- [ ] **Step 3: Update `README.md`**

In the Docker section, before the compose instructions:

- Show `docker login ghcr.io -u <github-user> --password-stdin` with a token
  that has `read:packages`, and state that the maintainer must grant access to
  the packages — a valid token alone is not enough.
- Pull commands: `docker pull ghcr.io/raidenyn/line-mcp-full:latest` (composed,
  ten tools) and `ghcr.io/raidenyn/line-mcp:latest` (standalone, five tools).
- Two run examples with their own volumes and ports, repeating the
  never-share-a-data-root warning: composed on `-p 3000:3000 -v
  bank-mcp-data:/data`, standalone on `-p 3100:3000 -v line-mcp-data:/data`.
- State the packages "must stay private" because the images bundle LINE's
  proprietary LTSM assets, linking
  `packages/line-client/THIRD_PARTY_NOTICES.md` and
  `packages/line-client/assets/ltsm/provenance.json`, and that public
  distribution is pending the issue #75 review.
- Add a tag table: `latest` (newest release), `X.Y.Z` / `X.Y` (release; `X` may
  be omitted on `0.x`), `edge` (newest `main`), `sha-<short>` (per-commit
  reference; rebuilding a commit yields a new digest).
- Add a digest-pinning example:
  `docker pull ghcr.io/raidenyn/line-mcp-full@sha256:<digest>`.
- Keep the existing compose and source-build instructions below the pull path.
- Add the new workflow to the workflow/CI list.

- [ ] **Step 4: Update `docs/RELEASING.md`**

Add a `## Docker Images` section with a `### GHCR Private-Package Bootstrap`
subsection covering, in order:

- A pre-check that neither package name already exists public; GHCR cannot make
  a public package private again, so an existing public package must be removed
  by the owner and the bootstrap redone.
- An **asset-free placeholder** pushed with
  `--label org.opencontainers.image.source=https://github.com/raidenyn/line-mcp`.
  Explain that the label links the package, inheritance can only be disabled
  after linking, and no runtime image may be pushed until it is off.
- In each linked package: Private visibility and untick "Inherit access from
  source repository"; explicitly no `raidenyn/line-mcp` Actions package access.
- The `ghcr-publish` environment restricted to `main` and `v*`, holding the
  classic `GHCR_PUBLISH_TOKEN`, which the workflow uses instead of
  `GITHUB_TOKEN`.
- An unrelated-account denial check in the linked state.
- `gh variable set GHCR_PACKAGES_PRIVATE --body true`, done by a maintainer, not
  an agent.
- After the first automatic `edge` push: re-check inheritance, repeat the denial
  check including a fork-origin credential path, then delete only the
  placeholder versions. Never delete either package; if one is deleted, unset
  the variable, stop any run that could republish, and redo the bootstrap.

Then cover automatic publication when the release dispatch arrives; the two
images and targets; manual re-publication via `workflow_dispatch` with a `tag`
run from `main`, including the fallbacks for a bare tag push, for tags created
before this workflow existed, and for promoting a prerelease (which fires
`released`, not `published`, and only works when the tag is already `vX.Y.Z`);
that prereleases are skipped; that re-publishing an older tag does not move
`latest`/`X.Y`/`X`; that a re-run should be the whole workflow, not only failed
jobs; that the GHCR packages "must stay private"; and that readers need
`read:packages` plus access granted by the maintainer. Name the workflow
`Publish Docker` and its file `publish-docker.yml`.

- [ ] **Step 5: Update `docs/ARCHITECTURE.md`**

Add a short entry for `.github/workflows/publish-docker.yml` under the CI or
delivery section: triggers, the two `ghcr.io` image names, GHCR-only private
publication, and where the runbook lives.

- [ ] **Step 6: Run documentation tests**

Run: `npx vitest run tests/release/release-documentation.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/RELEASING.md docs/ARCHITECTURE.md tests/release/release-documentation.test.ts
git commit -m "docs: document private docker image publication"
```

---

### Task 5: Full gate and workflow lint

**Files:** none.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the repository gate**

Run: `npm run lint && npm run build && npm run test:unit && npm run test:smoke`
Expected: all pass.

- [ ] **Step 2: Run the Docker smoke suite**

Run: `npx vitest run tests/docker/docker-smoke.test.ts`
Expected: both targets build and pass `healthz` plus `tools/list`.

- [ ] **Step 3: Run the release test files**

Run: `npx vitest run tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts tests/release/release-workflow.test.ts`
Expected: all pass, including the untouched release contract.

- [ ] **Step 4: Lint the workflow YAML**

Run: `npx --yes actionlint .github/workflows/publish-docker.yml` (skip if unavailable and say so).
Expected: no findings. If actionlint rejects `queue: max` as an unknown key, note it in the PR instead of removing the key — the GitHub docs define it.

- [ ] **Step 5: Hand off the private-package bootstrap to the maintainer**

**This step is maintainer-only. An agent must stop here, say the bootstrap is
outstanding, and never run `gh variable set` — the variable is the only
enforced control, and an agent cannot perform the registry/UI steps that are
supposed to precede it.**

The repository is public, so a linked package can inherit its access, and
linking happens when a package is first published. Publishing the real runtime
image during the bootstrap would therefore upload the LTSM assets while
inheritance is still on, and granting this public repository's token package
access is a documented fork-read risk. Before merging, the maintainer:

1. Checks both names with `gh api /users/raidenyn/packages/container/<name>` (or
   the package pages). If either exists and is **public**, stop: GHCR cannot
   make a public package private again, so the owner must remove it and the
   bootstrap restarts.
2. Pushes an **asset-free placeholder** with the source label to each package —
   the label links the package, and `FROM scratch` uploads no application files:
   ```bash
   echo "$PAT" | docker login ghcr.io -u <github-user> --password-stdin
   printf 'FROM scratch\n' | docker build \
     --label org.opencontainers.image.source=https://github.com/raidenyn/line-mcp \
     -t ghcr.io/raidenyn/line-mcp-full:bootstrap -
   docker push ghcr.io/raidenyn/line-mcp-full:bootstrap
   printf 'FROM scratch\n' | docker build \
     --label org.opencontainers.image.source=https://github.com/raidenyn/line-mcp \
     -t ghcr.io/raidenyn/line-mcp:bootstrap -
   docker push ghcr.io/raidenyn/line-mcp:bootstrap
   ```
3. In each **linked** package's settings: Private visibility and untick
   "Inherit access from source repository". Do **not** grant
   `raidenyn/line-mcp` Actions access.
4. Creates a `ghcr-publish` environment restricted to the `main` branch and
   `v*` tags, and stores the classic `write:packages` PAT there as
   `GHCR_PUBLISH_TOKEN`. The workflow uses that token; `GITHUB_TOKEN` never
   authenticates to GHCR.
5. Confirms an unrelated signed-in account is denied a pull — after linking, so
   the check is meaningful.
6. Sets the repository variable:
   ```bash
   gh variable set GHCR_PACKAGES_PRIVATE --body true
   ```
7. After the first automatic `edge` push lands, re-opens both package settings,
   confirms inheritance is still off, repeats the denial check (including a
   fork-origin credential path), and only then deletes the placeholder
   versions. Never delete either package; if one is deleted, run
   `gh variable delete GHCR_PACKAGES_PRIVATE`, stop any run that could
   republish, and redo this step.

- [ ] **Step 6: Commit any fixes and open the PR**

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts README.md docs/RELEASING.md docs/ARCHITECTURE.md
git commit -m "ci: tighten docker publication verification"
```

If there is nothing to commit, skip this step. Do not stage
`openspec/changes/publish-docker-images/` in this commit.

PR title: `ci: publish private container images to GHCR`. In the PR body, ask
the maintainer to confirm the placeholder-based private bootstrap, the
`ghcr-publish` environment with `GHCR_PUBLISH_TOKEN`, and
`GHCR_PACKAGES_PRIVATE=true` before merge — do not assert that they are done —
and list what only post-merge verification can prove: the actual GHCR push, the
first release-tag publication, and that after the first `edge` push inheritance
is still off and both an unrelated account and a fork-origin credential path
are denied. State explicitly that public distribution and any Docker Hub mirror
are out of scope pending the issue #75 provenance review.

---

### Task 6: Publish labeled PR images

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Modify: `tests/release/docker-publish-workflow.test.ts`
- Modify: `docs/RELEASING.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: the existing `prepare` outputs and the `publish` job.
- Produces: a ninth `prepare` output `pr`; a `meta-pr` metadata step; PR runs that publish `pr-<number>` and `sha-<short>` only.

- [ ] **Step 1: Add the trigger and failing tests**

Trigger:

```yaml
  pull_request:
    types: [labeled]
```

Tests:
- the trigger object now includes `pull_request: { types: ['labeled'] }`;
- `prepare` exposes nine outputs including `pr`;
- behavioural cases with the new env vars (`PR_LABEL`, `PR_HEAD_REPO`, `PR_NUMBER`, `PR_HEAD_SHA`): a `publish-docker` label on a same-repo PR sets `publish=true`, `pr=96`, `ref=<head sha>`, `sha=<head sha>`, `latest=false`, `edge=false`, `tag=''`; another label exits 0 with `publish=false`; a fork head exits 0 with `publish=false` and a warning; the gate still fails when `GHCR_PACKAGES_PRIVATE` is unset;
- `meta-pr` is asserted line by line (`pr-<number>`, `sha-<short>`), and the build's tags/labels selection includes the third fallback.

- [ ] **Step 2: Extend `prepare`**

Add `PR_LABEL`, `PR_HEAD_REPO`, `PR_NUMBER`, `PR_HEAD_SHA` to the step env and `pr: ${{ steps.resolve.outputs.pr }}` to the job outputs. In the script, after the prerelease skip and before the bootstrap gate:

1. Initialise `pr=''`.
2. If `EVENT_NAME = pull_request`:
   - when `PR_LABEL != 'publish-docker'`, write outputs with `publish=false` and exit 0;
   - when `PR_HEAD_REPO != GITHUB_REPOSITORY`, write outputs with `publish=false`, emit `::warning::` that fork PRs are unsupported, and exit 0;
   - otherwise write `publish=true`, `pr=$PR_NUMBER`, `sha=$PR_HEAD_SHA`, `short_sha=${PR_HEAD_SHA:0:7}`, `ref=$PR_HEAD_SHA`, `tag=''`, `latest=false`, `edge=false`, `major=''`, and exit 0 before the tag logic.
3. Keep the `GHCR_PACKAGES_PRIVATE` gate in the publishing path (after the label/fork checks) so an unlabeled PR does not fail, but a labeled one refuses without the bootstrap.

- [ ] **Step 3: Add `meta-pr`**

```yaml
      - name: Metadata (pull request)
        id: meta-pr
        if: needs.prepare.outputs.pr != ''
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}
          flavor: latest=false
          labels: |
            org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}
          tags: |
            type=raw,value=pr-${{ needs.prepare.outputs.pr }}
            type=raw,value=sha-${{ needs.prepare.outputs.short_sha }}
```

Extend the build step's `tags` and `labels` to
`${{ steps.meta-release.outputs.* || steps.meta-edge.outputs.* || steps.meta-pr.outputs.* }}`.

- [ ] **Step 4: Documentation**

In `docs/RELEASING.md`, document: adding the `publish-docker` label publishes
the PR head as `pr-<number>` and `sha-<short>`; only same-repository PRs; the
owner must approve the `ghcr-publish` deployment on every PR and release run;
re-adding the label republishes; PR tags never move `latest`/`edge`/release
tags. Note that the environment's deployment-branch policy must permit PR refs
(approval is the gate) and that fork PRs are refused. Add the path to
`docs/ARCHITECTURE.md`.

- [ ] **Step 5: Verify and commit**

Run `npx vitest run tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts`, `npm run lint`, and the docker smoke test against a locally built PR image. Commit:

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts docs/RELEASING.md docs/ARCHITECTURE.md
git commit -m "ci: publish labeled pull requests to private ghcr"
```

---

### Task 7: Convert publication to public GHCR

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Modify: `tests/release/docker-publish-workflow.test.ts`
- Modify: `tests/release/release-documentation.test.ts`
- Modify: `README.md`, `CLAUDE.md`, `docs/RELEASING.md`, `docs/ARCHITECTURE.md`
- Modify: `packages/line-client/THIRD_PARTY_NOTICES.md`
- Modify: `packages/line-client/assets/ltsm/provenance.json`

**Interfaces:**
- Consumes: the existing workflow, tests, and docs.
- Produces: public-package design with `GITHUB_TOKEN` auth; no PAT, no
  `GHCR_PACKAGES_PRIVATE` gate, no bootstrap; `NOASSERTION` licence labels.

- [ ] **Step 1: Update the failing tests**

- `workflow.permissions` remains `{ contents: 'read' }`; the `publish` job gains
  `permissions: { contents: 'read', packages: 'write' }`.
- Login uses `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}`; the workflow
  source contains no `GHCR_PUBLISH_TOKEN` and no `GHCR_PACKAGES_PRIVATE`.
- `prepare` no longer has a gate output/case; remove the bootstrap-refusal case.
- `meta-release`, `meta-edge`, and `meta-pr` each assert
  `org.opencontainers.image.licenses=NOASSERTION` in `labels`.
- Documentation assertions: README has anonymous `docker pull`, no
  `docker login ghcr.io`, no "must grant access"/"must stay private", includes
  the irreversible-visibility warning; RELEASING has the visibility-flip section,
  no `GHCR_PUBLISH_TOKEN`/`GHCR_PACKAGES_PRIVATE`/bootstrap heading; policy files
  contain the dated acceptance and keep npm unapproved.

- [ ] **Step 2: Change the workflow**

- Add `permissions: { contents: read, packages: write }` to the `publish` job.
- Login: `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`.
- Remove the `GHCR_PACKAGES_PRIVATE` env/check and the `pr`-independent gate
  failure; keep the label/fork early exits.
- Add the licence label to all three metadata steps.
- Rewrite the header comment: public packages, owner-accepted LTSM risk,
  `GITHUB_TOKEN`, no PAT.
- Keep `environment: ghcr-publish`, `queue: max`, `type=registry` cache,
  `provenance: false`, `sbom: false`, and all tag logic.

- [ ] **Step 3: Amend policy and documentation**

- `THIRD_PARTY_NOTICES.md`: add a dated owner risk acceptance approving public
  container images; keep public npm blocked.
- `provenance.json`: add `approvedDistributionForms.publicContainerImage` with
  the date; correct `sourceRepository` to say the repository is public; keep
  `publicNpmPublish` NOT approved.
- `README.md`: Docker section uses anonymous pulls with no login, keeps the tag
  table and digest pinning, adds the irreversible-visibility warning, and updates
  the provenance bullet; remove "access must be granted".
- `CLAUDE.md`: public container images approved; npm publish still forbidden.
- `docs/RELEASING.md`: replace the bootstrap with the first-publication flip
  (first push creates private packages, owner changes visibility once, cannot be
  undone), anonymous verification, approval on every deployment, and no PAT.
- `docs/ARCHITECTURE.md`: public GHCR, `GITHUB_TOKEN`, no PAT/bootstrap.

- [ ] **Step 4: Verify**

`openspec validate publish-docker-images`; `npx vitest run tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts`; `npm run lint`; `npm run build`; `npm run test:smoke`; then rebuild both images and run `tests/docker/docker-smoke.test.ts` with `SMOKE_SERVER_IMAGE`/`SMOKE_STANDALONE_IMAGE`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts README.md CLAUDE.md docs/RELEASING.md docs/ARCHITECTURE.md packages/line-client/THIRD_PARTY_NOTICES.md packages/line-client/assets/ltsm/provenance.json
git commit -m "feat: publish public container images with the workflow token"
```

---

### Task 8: Remove automatic publishing on merge

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Modify: `tests/release/docker-publish-workflow.test.ts`
- Modify: `README.md`, `docs/RELEASING.md`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: the existing workflow and tests.
- Produces: a workflow with no `push` trigger; `edge` only from an untagged manual dispatch.

- [ ] **Step 1: Update the failing tests**

- The parsed `on` object contains only `repository_dispatch`, `release`, `workflow_dispatch`, and `pull_request`, and the test asserts `on` has no `push` key.
- Remove the two push edge cases; keep the untagged-dispatch edge cases and the main-only refusal.

- [ ] **Step 2: Remove the trigger**

Delete the `push:` block. Do not change any job logic: the untagged-dispatch path already produces `edge` and `sha`.

- [ ] **Step 3: Update documentation**

- `README.md`: remove the claim that every `main` push publishes `edge`; state that publication starts from a release dispatch, a published Release, a tagged manual dispatch, an untagged manual preview, or the `publish-docker` PR label.
- `docs/RELEASING.md`: the first publication comes from a release/manual dispatch, not a merge; merging publishes nothing.
- `docs/ARCHITECTURE.md`: list the triggers without `push`.

- [ ] **Step 4: Verify and commit**

Run `npx vitest run tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts`, `npm run lint`, `npm run build`, `openspec validate publish-docker-images`. Commit:

```bash
git add .github/workflows/publish-docker.yml tests/release/docker-publish-workflow.test.ts README.md docs/RELEASING.md docs/ARCHITECTURE.md
git commit -m "ci: stop publishing on merge to main"
```

---

### Task 9: Move workflows to Node 24 actions

**Files:**
- Modify: `.github/workflows/publish-docker.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `tests/release/release-workflow.test.ts`, `tests/release/ci-commit-policy.test.ts`, `tests/release/docker-publish-workflow.test.ts`

**Interfaces:**
- Consumes: current action pins.
- Produces: every action runs on Node 24; no deprecation warning.

- [ ] **Step 1: Update the action pins**

| Old | New |
| --- | --- |
| `actions/checkout@v4` | `actions/checkout@v7` |
| `actions/setup-node@v4` | `actions/setup-node@v7` |
| `docker/setup-buildx-action@v3` | `docker/setup-buildx-action@v4` |
| `docker/login-action@v3` | `docker/login-action@v4` |
| `docker/metadata-action@v5` | `docker/metadata-action@v6` |
| `docker/build-push-action@v6` | `docker/build-push-action@v7` |

- [ ] **Step 2: Update test assertions**

Replace the old `uses` strings in the three test files; keep every other assertion unchanged.

- [ ] **Step 3: Verify and commit**

Run `npx vitest run tests/release/release-workflow.test.ts tests/release/ci-commit-policy.test.ts tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts`, `npm run lint`, `npm run build`. Commit:

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/publish-docker.yml tests/release/release-workflow.test.ts tests/release/ci-commit-policy.test.ts tests/release/docker-publish-workflow.test.ts
git commit -m "ci: update actions to node24 runtimes"
```
