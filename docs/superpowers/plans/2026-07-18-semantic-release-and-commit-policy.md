# Semantic Release and Commit Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Conventional Commits locally and in CI, reset the project baseline to `0.1.0`, and add deliberate semantic-release automation for tags and GitHub Releases.

**Architecture:** Commitlint is the single commit-policy implementation used by a Husky hook, CI commit-range checks, and direct tests. Semantic-release owns version analysis, tags, release notes, and GitHub Releases; a manual GitHub Actions workflow wraps it with main-branch freshness, concurrency, and a `repository_dispatch` handoff for future Docker publishing.

**Tech Stack:** Node.js 24, npm workspaces, TypeScript, Vitest, commitlint 21, Husky 9, semantic-release 25, GitHub Actions, YAML 2.

## Global Constraints

- Work only on `ci/semantic-release`, created from `origin/main`; never commit to `main`.
- Allowed commit types are exactly `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`, and `perf`.
- Release mapping is breaking change to major, `feat` to minor, `fix` or `perf` to patch, and every other allowed type to no release.
- Release only from `main`, tag as `v${version}`, and trigger releases only with `workflow_dispatch`.
- Use only `GITHUB_TOKEN`; do not add external release secrets.
- Never publish npm packages, create release commits, or commit a generated `CHANGELOG.md`.
- Keep all root and workspace manifests at `0.1.0` after bootstrap; later tags are the version source of truth.
- Never edit `packages/line-client/assets/ltsm/*` or run `npm publish`.
- Before a PR, run `npm run lint && npm run build && npm run test:unit && npm run test:smoke`.

---

### Task 1: Local Commit Policy

**Files:**
- Create: `commitlint.config.cjs`
- Create: `.husky/commit-msg`
- Create: `tests/release/commit-policy.test.ts`
- Modify: `package.json:9-33`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Git commit message file path supplied as `.husky/commit-msg "$1"`.
- Produces: `npm run commitlint -- [commitlint arguments]` and an installed Husky `commit-msg` hook.

- [ ] **Step 1: Install the commit-policy test and runtime tooling**

Run:

```bash
npm install --save-dev --save-exact @commitlint/cli@21.2.1 @commitlint/config-conventional@21.2.0 husky@9.1.7 yaml@2.9.0
```

Expected: npm updates `package.json` and `package-lock.json`; no production dependency changes.

- [ ] **Step 2: Write the failing commit-policy test and include release tests in the unit suite**

Create `tests/release/commit-policy.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function lint(message: string) {
  return spawnSync('npm', ['run', '--silent', 'commitlint', '--'], {
    cwd: root,
    encoding: 'utf8',
    input: message,
  });
}

describe('commit message policy', () => {
  it.each([
    'feat: add release automation',
    'fix(oauth): reject stale state',
    'perf!: replace the message index',
    'chore: update tooling\n\nBREAKING CHANGE: require Node 24',
  ])('accepts %s', (message) => {
    const result = lint(message);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    'style: reformat files',
    'missing conventional prefix',
    "Merge branch 'main'",
    'Revert "feat: add release automation"',
    `feat: ${'x'.repeat(100)}`,
  ])('rejects %s', (message) => {
    expect(lint(message).status).not.toBe(0);
  });
});
```

Change the root test script to:

```json
"test:unit": "vitest run packages tests/architecture tests/release"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/release/commit-policy.test.ts`

Expected: FAIL because the `commitlint` npm script/configuration does not exist.

- [ ] **Step 4: Add the shared commitlint configuration and scripts**

Create `commitlint.config.cjs`:

```js
// eslint-disable-next-line no-undef -- commitlint loads CommonJS configuration
module.exports = {
  defaultIgnores: false,
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'ci', 'build', 'perf'],
    ],
  },
};
```

Add these root scripts without changing existing commands:

```json
"commitlint": "commitlint",
"prepare": "husky"
```

Create `.husky/commit-msg`:

```sh
npx --no -- commitlint --edit "$1"
```

Run:

```bash
chmod +x .husky/commit-msg
npm run prepare
```

Expected: Husky configures the repository hook path and the tracked hook is executable.

- [ ] **Step 5: Run focused tests and direct hook checks**

Run:

```bash
npx vitest run tests/release/commit-policy.test.ts
good_message="$(mktemp)"
bad_message="$(mktemp)"
printf '%s\n' 'fix: verify commit hook' > "$good_message"
printf '%s\n' 'invalid commit' > "$bad_message"
.husky/commit-msg "$good_message"
if .husky/commit-msg "$bad_message"; then exit 1; fi
rm -f "$good_message" "$bad_message"
```

Expected: Vitest passes, the valid message exits 0, and the invalid message emits commitlint errors and is converted into an expected shell success by the `if` guard.

- [ ] **Step 6: Commit the local policy**

```bash
git add package.json package-lock.json commitlint.config.cjs .husky/commit-msg tests/release/commit-policy.test.ts
git commit -m "ci: enforce conventional commits locally"
```

---

### Task 2: CI Commit And PR Title Enforcement

**Files:**
- Create: `tests/release/ci-commit-policy.test.ts`
- Modify: `.github/workflows/ci.yml:9-115`

**Interfaces:**
- Consumes: GitHub `pull_request` base/head SHAs and title, or `push` before/after SHAs.
- Produces: A `commit-policy` CI job that validates PR commits, PR titles, and new `main` commits.

- [ ] **Step 1: Write the failing CI contract test**

Create `tests/release/ci-commit-policy.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe('CI commit policy job', () => {
  const steps = workflow.jobs['commit-policy']?.steps ?? [];

  it('checks out complete PR-head history', () => {
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
    });
  });

  it('validates PR commits and the squash title', () => {
    expect(steps.find((step) => step.name === 'Validate PR commits')?.run)
      .toContain('--from "${{ github.event.pull_request.base.sha }}" --to "${{ github.event.pull_request.head.sha }}"');
    const title = steps.find((step) => step.name === 'Validate PR title');
    expect(title?.env?.PR_TITLE).toBe('${{ github.event.pull_request.title }}');
    expect(title?.run).toContain('printf');
  });

  it('handles normal and all-zero push ranges separately', () => {
    expect(steps.find((step) => step.name === 'Validate pushed commits')?.if)
      .toContain("github.event.before != '0000000000000000000000000000000000000000'");
    expect(steps.find((step) => step.name === 'Validate initial pushed commit')?.if)
      .toContain("github.event.before == '0000000000000000000000000000000000000000'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/release/ci-commit-policy.test.ts`

Expected: FAIL because `jobs.commit-policy` is absent.

- [ ] **Step 3: Add the CI job**

Insert this job before the existing `check` job in `.github/workflows/ci.yml`:

```yaml
  commit-policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - name: Validate PR commits
        if: github.event_name == 'pull_request'
        run: npm run commitlint -- --from "${{ github.event.pull_request.base.sha }}" --to "${{ github.event.pull_request.head.sha }}" --verbose

      - name: Validate PR title
        if: github.event_name == 'pull_request'
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: printf '%s\n' "$PR_TITLE" | npm run commitlint

      - name: Validate pushed commits
        if: github.event_name == 'push' && github.event.before != '0000000000000000000000000000000000000000'
        run: npm run commitlint -- --from "${{ github.event.before }}" --to "${{ github.sha }}" --verbose

      - name: Validate initial pushed commit
        if: github.event_name == 'push' && github.event.before == '0000000000000000000000000000000000000000'
        run: git show -s --format=%B "${{ github.sha }}" | npm run commitlint
```

- [ ] **Step 4: Run the CI contract and commit-policy tests**

Run: `npx vitest run tests/release/commit-policy.test.ts tests/release/ci-commit-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit CI enforcement**

```bash
git add .github/workflows/ci.yml tests/release/ci-commit-policy.test.ts
git commit -m "ci: validate commit messages and PR titles"
```

---

### Task 3: Semantic Release Policy

**Files:**
- Create: `.releaserc.json`
- Create: `tests/release/release-policy.test.ts`
- Modify: `package.json:9-40`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Conventional Commits after the latest `vX.Y.Z` tag.
- Produces: `npm run release` and semantic-release configuration for major/minor/patch/no-release analysis.

- [ ] **Step 1: Install pinned release tooling**

Run:

```bash
npm install --save-dev --save-exact semantic-release@25.0.8 @semantic-release/commit-analyzer@13.0.1 @semantic-release/release-notes-generator@14.1.1 @semantic-release/github@12.0.9 conventional-changelog-conventionalcommits@10.2.1
```

Expected: only root development dependencies and the lockfile change.

- [ ] **Step 2: Write the failing release-policy test**

Create `tests/release/release-policy.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/release/release-policy.test.ts`

Expected: FAIL with `ENOENT` for `.releaserc.json`.

- [ ] **Step 4: Add semantic-release configuration and script**

Create `.releaserc.json`:

```json
{
  "branches": ["main"],
  "tagFormat": "v${version}",
  "plugins": [
    [
      "@semantic-release/commit-analyzer",
      {
        "preset": "conventionalcommits",
        "releaseRules": [
          { "type": "perf", "release": "patch" },
          { "type": "refactor", "release": false },
          { "type": "test", "release": false },
          { "type": "docs", "release": false },
          { "type": "chore", "release": false },
          { "type": "ci", "release": false },
          { "type": "build", "release": false }
        ]
      }
    ],
    ["@semantic-release/release-notes-generator", { "preset": "conventionalcommits" }],
    [
      "@semantic-release/github",
      {
        "failComment": false,
        "failTitle": false,
        "releasedLabels": false,
        "successComment": false
      }
    ]
  ]
}
```

Add the root script:

```json
"release": "semantic-release"
```

- [ ] **Step 5: Run focused policy tests**

Run: `npx vitest run tests/release/commit-policy.test.ts tests/release/release-policy.test.ts`

Expected: PASS for every commitlint and SemVer fixture.

- [ ] **Step 6: Commit release policy**

```bash
git add package.json package-lock.json .releaserc.json tests/release/release-policy.test.ts
git commit -m "ci: configure semantic release policy"
```

---

### Task 4: Manual Release Workflow And Docker Handoff

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `tests/release/release-workflow.test.ts`

**Interfaces:**
- Consumes: latest `origin/main`, existing `v*` tags, `.releaserc.json`, and `GITHUB_TOKEN`.
- Produces: a Git tag, GitHub Release, and `repository_dispatch` event `release-published` with `client_payload.tag` only when a new release is created.

- [ ] **Step 1: Write the failing workflow contract test**

Create `tests/release/release-workflow.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const source = readFileSync('.github/workflows/release.yml', 'utf8');
const workflow = parse(source) as {
  concurrency: { 'cancel-in-progress': boolean; group: string };
  jobs: Record<string, { steps: Step[] }>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
};
const steps = workflow.jobs.release.steps;

describe('release workflow', () => {
  it('is manual, serialized, and contents-only', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'write' });
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'release',
    });
  });

  it('checks out complete main history and rejects stale HEAD', () => {
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v4');
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, ref: 'refs/heads/main' });
    expect(steps.find((step) => step.name === 'Verify current main')?.run)
      .toContain('refs/remotes/origin/main');
  });

  it('releases and dispatches only for a newly detected tag', () => {
    expect(steps.find((step) => step.name === 'Run semantic-release')?.run)
      .toBe('npm run release');
    expect(steps.find((step) => step.id === 'release-tag')?.run)
      .toContain('comm -13');
    const dispatch = steps.find((step) => step.name === 'Dispatch Docker publishing');
    expect(dispatch?.if).toBe("steps.release-tag.outputs.tag != ''");
    expect(dispatch?.run).toContain('release-published');
    expect(dispatch?.run).toContain('client_payload');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/release/release-workflow.test.ts`

Expected: FAIL with `ENOENT` for `.github/workflows/release.yml`.

- [ ] **Step 3: Add the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: refs/heads/main

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - name: Verify current main
        run: |
          git fetch origin refs/heads/main:refs/remotes/origin/main --tags
          test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"

      - name: Record tags at HEAD
        run: git tag --points-at HEAD --list 'v*' | sort > "$RUNNER_TEMP/release-tags-before"

      - name: Run semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run release

      - name: Detect new release tag
        id: release-tag
        shell: bash
        run: |
          git tag --points-at HEAD --list 'v*' | sort > "$RUNNER_TEMP/release-tags-after"
          mapfile -t new_tags < <(comm -13 "$RUNNER_TEMP/release-tags-before" "$RUNNER_TEMP/release-tags-after")
          if (( ${#new_tags[@]} > 1 )); then
            printf 'Expected at most one new release tag, found %s\n' "${#new_tags[@]}" >&2
            exit 1
          fi
          if (( ${#new_tags[@]} == 1 )); then
            printf 'tag=%s\n' "${new_tags[0]}" >> "$GITHUB_OUTPUT"
          fi

      - name: Dispatch Docker publishing
        if: steps.release-tag.outputs.tag != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RELEASE_TAG: ${{ steps.release-tag.outputs.tag }}
        run: |
          jq -n --arg tag "$RELEASE_TAG" \
            '{event_type: "release-published", client_payload: {tag: $tag}}' \
            | gh api --method POST "repos/${{ github.repository }}/dispatches" --input -
```

- [ ] **Step 4: Run workflow and policy contract tests**

Run: `npx vitest run tests/release`

Expected: PASS, including fixed-main checkout, minimal permissions, concurrency, tag-delta detection, and conditional dispatch.

- [ ] **Step 5: Commit the release workflow**

```bash
git add .github/workflows/release.yml tests/release/release-workflow.test.ts
git commit -m "ci: add manual semantic release workflow"
```

---

### Task 5: Reset The Project Version Baseline

**Files:**
- Create: `tests/release/version-baseline.test.ts`
- Modify: `package.json`
- Modify: `packages/bank-mcp/package.json`
- Modify: `packages/line-client-sqlite/package.json`
- Modify: `packages/line-client/package.json`
- Modify: `packages/line-mcp/package.json`
- Modify: `packages/mcp-runtime/package.json`
- Modify: `packages/server/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: root and six workspace manifests plus all internal `@raidenyn/*` dependency ranges.
- Produces: a consistent private monorepo baseline at version `0.1.0` with internal ranges `^0.1.0`.

- [ ] **Step 1: Write the failing baseline contract test**

Create `tests/release/version-baseline.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifests = [
  'package.json',
  'packages/bank-mcp/package.json',
  'packages/line-client-sqlite/package.json',
  'packages/line-client/package.json',
  'packages/line-mcp/package.json',
  'packages/mcp-runtime/package.json',
  'packages/server/package.json',
];
const workspaceNames = new Set(manifests.slice(1).map((path) => {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name: string };
  return manifest.name;
}));

describe('0.1.0 version baseline', () => {
  it.each(manifests)('%s has the baseline version', (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
    expect(manifest.version).toBe('0.1.0');
  });

  it.each(manifests)('%s uses the baseline internal ranges', (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (workspaceNames.has(name)) expect(range).toBe('^0.1.0');
    }
  });

  it('records root and workspace versions in the lockfile', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe('0.1.0');
    expect(lock.packages[''].version).toBe('0.1.0');
    for (const path of manifests.slice(1)) {
      expect(lock.packages[path.replace('/package.json', '')].version).toBe('0.1.0');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/release/version-baseline.test.ts`

Expected: FAIL because manifests and lock metadata still contain `1.0.0`.

- [ ] **Step 3: Reset manifest versions and internal ranges**

Run:

```bash
npm version 0.1.0 --workspaces --include-workspace-root --no-git-tag-version
```

In root and workspace `package.json` files, replace every internal workspace
range shown below; do not change external package ranges:

```text
"@raidenyn/bank-mcp": "^1.0.0"          -> "^0.1.0"
"@raidenyn/line-client": "^1.0.0"       -> "^0.1.0"
"@raidenyn/line-client-sqlite": "^1.0.0"-> "^0.1.0"
"@raidenyn/line-mcp": "^1.0.0"          -> "^0.1.0"
"@raidenyn/mcp-runtime": "^1.0.0"       -> "^0.1.0"
```

Regenerate lock metadata:

```bash
npm install --package-lock-only
```

- [ ] **Step 4: Verify the baseline and workspace dependency graph**

Run:

```bash
npx vitest run tests/release/version-baseline.test.ts
npm install
npm ls --all
```

Expected: the baseline test passes and `npm ls --all` exits 0 with workspace links satisfying `^0.1.0`.

- [ ] **Step 5: Commit the baseline reset**

```bash
git add package.json package-lock.json packages/*/package.json tests/release/version-baseline.test.ts
git commit -m "chore: reset project version to 0.1.0"
```

---

### Task 6: Maintainer Release Documentation

**Files:**
- Create: `docs/RELEASING.md`
- Create: `tests/release/release-documentation.test.ts`
- Modify: `CLAUDE.md:11-47,75-83`

**Interfaces:**
- Consumes: commit policy, release workflow, and one-time bootstrap procedure from prior tasks.
- Produces: contributor guidance and exact post-merge maintainer commands.

- [ ] **Step 1: Write the failing documentation contract test**

Create `tests/release/release-documentation.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release documentation', () => {
  it('documents enforced commits and perf releases for contributors', () => {
    const guide = readFileSync('CLAUDE.md', 'utf8');
    expect(guide).toContain('`perf` → patch');
    expect(guide).toContain('commit-msg');
    expect(guide).toContain('CI');
    expect(guide).toContain('docs/RELEASING.md');
  });

  it('documents bootstrap and normal release operations', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('v0.1.0');
    expect(runbook).toContain('gh release create');
    expect(runbook).toContain('workflow_dispatch');
    expect(runbook).toContain('No releasable commits');
    expect(runbook).toContain('release-published');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/release/release-documentation.test.ts`

Expected: FAIL because `docs/RELEASING.md` is absent and `CLAUDE.md` lacks the new policy text.

- [ ] **Step 3: Update contributor guidance**

Add this command to the `CLAUDE.md` command block:

```bash
npm run commitlint  # validate a commit message/range with commitlint
```

Replace the SemVer mapping line with:

```markdown
- Semver mapping: `feat` → minor, `fix` / `perf` → patch, breaking → major.
- A Husky `commit-msg` hook checks local commits; CI checks every PR commit and
  the PR title, so `--no-verify` cannot bypass repository enforcement.
```

Add this doc-map entry:

```markdown
- `docs/RELEASING.md` — commit enforcement, version policy, release workflow,
  and the one-time `v0.1.0` bootstrap runbook.
```

- [ ] **Step 4: Write the maintainer runbook**

Create `docs/RELEASING.md` with these sections and commands:

```markdown
# Releasing

Git tags and GitHub Releases are the version source of truth. Package manifests
remain at the private-project baseline `0.1.0`; this repository never publishes
npm packages and semantic-release never commits version or changelog files.

## Commit Policy

Commits and PR titles use `type(scope?): subject`. The Husky `commit-msg` hook
provides local feedback, and CI validates every PR commit plus its title.
Breaking changes produce a major release, `feat` a minor release, `fix` and
`perf` a patch release, and all other allowed types no release.

## One-time v0.1.0 Bootstrap

Run only after the release-automation PR is merged and `main` is checked out at
the intended baseline commit:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --verify-tag --title "v0.1.0" --notes "Initial release."
```

Do not move or recreate the baseline tag after publishing it.

## Normal Release

Wait for CI on `main`, then run the `Release` workflow with
`workflow_dispatch`. The workflow always checks current `main`. No releasable
commits is a successful no-op. A release creates `vX.Y.Z`, publishes generated
GitHub Release notes, and emits `release-published` for the Docker workflow.

Rerun a failed workflow after correcting the reported permission, API, or stale
checkout error. Semantic-release will not recreate an existing version.
```

- [ ] **Step 5: Run documentation and release tests**

Run: `npx vitest run tests/release`

Expected: PASS for commit policy, CI/workflow contracts, release mapping, version baseline, and documentation.

- [ ] **Step 6: Commit documentation**

```bash
git add CLAUDE.md docs/RELEASING.md tests/release/release-documentation.test.ts
git commit -m "docs: add release maintainer runbook"
```

---

### Task 7: Full Verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all deliverables from Tasks 1-6.
- Produces: evidence that the branch satisfies repository and feature gates.

- [ ] **Step 1: Run all release-policy tests**

Run: `npx vitest run tests/release`

Expected: all release tests pass.

- [ ] **Step 2: Run the mandatory pre-PR gate**

Run:

```bash
npm run lint && npm run build && npm run test:unit && npm run test:smoke
```

Expected: all four commands exit 0.

- [ ] **Step 3: Verify dependency closure and hook behavior**

Run:

```bash
npm ls --all
good_message="$(mktemp)"
bad_message="$(mktemp)"
printf '%s\n' 'ci: verify final commit policy' > "$good_message"
printf '%s\n' 'not conventional' > "$bad_message"
.husky/commit-msg "$good_message"
if .husky/commit-msg "$bad_message"; then exit 1; fi
rm -f "$good_message" "$bad_message"
```

Expected: dependency closure and the valid hook invocation exit 0; the invalid message is rejected as expected.

- [ ] **Step 4: Inspect final branch state**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree, only intended Conventional Commits, and no whitespace errors.

## Post-merge Maintainer Gate

Do not execute this section on the feature branch. After the PR is reviewed,
merged, and `main` CI succeeds, a maintainer follows `docs/RELEASING.md` to
create and publish `v0.1.0` at the exact baseline commit. Verify with:

```bash
git fetch origin --tags
test "$(git rev-parse v0.1.0^{commit})" = "$(git rev-parse origin/main)"
gh release view v0.1.0 --json tagName,isDraft,isPrerelease,url
```

Expected: the tag points to the intended `main` commit and the GitHub Release is published, not draft or prerelease. Do not manually dispatch semantic-release until at least one later releasable commit has landed.
