import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runStep } from './support/run-step';

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
};

const source = readFileSync('.github/workflows/release.yml', 'utf8');
const workflow = parse(source) as Workflow;

const job = (name: string) => workflow.jobs[name];
const step = (jobName: string, stepName: string) => {
  const found = job(jobName).steps?.find((candidate) => candidate.name === stepName);
  if (!found) throw new Error(`${jobName} has no step named ${stepName}`);
  return found;
};

const runSteps = () =>
  Object.entries(workflow.jobs).flatMap(([jobName, value]) =>
    (value.steps ?? []).flatMap((candidate) =>
      candidate.run === undefined ? [] : [{ jobName, step: candidate }],
    ),
  );

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-workflow-'));
  return {
    file(name: string, content = '') {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
    path: (name: string) => join(dir, name),
    read(name: string) {
      return readFileSync(join(dir, name), 'utf8');
    },
  };
};

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

describe('release workflow shape', () => {
  it('is manual, serialized, and read-only by default', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'release',
    });
  });

  it('runs authorize, plan, draft, images, publish in order', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      'authorize',
      'draft',
      'images',
      'plan',
      'publish',
    ]);
    expect(job('authorize').needs).toBeUndefined();
    expect(job('plan').needs).toBe('authorize');
    expect(job('draft').needs).toBe('plan');
    expect(job('draft').if).toBe("needs.plan.outputs.released == 'true'");
    // The draft holds the release before any image is built, so the images
    // stage waits for it as well as for the plan it takes the tag from.
    expect(job('images').needs).toEqual(['plan', 'draft']);
    expect(job('publish').needs).toEqual(['plan', 'draft', 'images']);
  });

  it('grants each job only the permissions it needs', () => {
    expect(job('authorize').permissions).toBeUndefined();
    expect(job('plan').permissions).toEqual({ contents: 'write' });
    expect(job('draft').permissions).toEqual({ contents: 'write' });
    expect(job('images').permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job('publish').permissions).toEqual({ contents: 'write', packages: 'read' });
  });

  it('calls the reusable image workflow with the planned tag', () => {
    expect(job('images').uses).toBe('./.github/workflows/publish-docker.yml');
    expect(job('images').with).toEqual({ tag: '${{ needs.plan.outputs.tag }}' });
    // The draft consumes plan outputs; it exposes none of its own.
    expect(job('draft').outputs).toBeUndefined();
  });

  it('only reads outputs of jobs it directly needs', () => {
    // GitHub resolves `needs.<job>.outputs` only for direct dependencies; a
    // transitive reference silently expands to an empty string.
    for (const [jobName, value] of Object.entries(workflow.jobs)) {
      const declared = typeof value.needs === 'string' ? value.needs : (value.needs ?? []);
      for (const match of JSON.stringify(value).matchAll(/needs\.([a-z]+)\.outputs/g)) {
        expect(declared, `${jobName} reads ${match[0]}`).toContain(match[1]);
      }
    }
  });

  it('checks out complete history on the default ref without credentials', () => {
    const checkout = job('plan').steps?.find((candidate) => candidate.uses === 'actions/checkout@v7');
    expect(checkout?.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
  });

  it('plans the release after verifying main and the baseline tag', () => {
    expect(job('plan').steps?.map((candidate) => candidate.name ?? candidate.uses)).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
      'Install dependencies',
      'Verify current main',
      'Verify baseline tag exists',
      'Plan the release',
      'Verify main unchanged',
      'Upload the release notes',
    ]);

    expect(step('plan', 'Install dependencies').run).toBe('npm ci --ignore-scripts');
    expect(step('plan', 'Verify current main').run).toContain('refs/remotes/origin/main');
    expect(step('plan', 'Verify current main').run).toContain('Dispatch a new Release run');
    const baseline = step('plan', 'Verify baseline tag exists');
    expect(baseline.run).toContain('refs/tags/v0.1.0');
    expect(baseline.run).toContain('exit 1');
  });

  it('plans with the release planner and keeps the token in that step only', () => {
    const plan = step('plan', 'Plan the release');
    expect(plan.id).toBe('plan');
    expect(plan.run).toBe('npm run release:plan');
    expect(plan.env).toEqual({
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      RELEASE_NOTES_FILE: '${{ runner.temp }}/release-notes.md',
    });
    const tokenSteps = (job('plan').steps ?? []).filter((candidate) =>
      JSON.stringify(candidate).includes('secrets.GITHUB_TOKEN'),
    );
    expect(tokenSteps).toEqual([plan]);
    expect(job('plan').env).toBeUndefined();
  });

  it('maps the plan outputs onto the job', () => {
    expect(job('plan').outputs).toEqual({
      released: '${{ steps.plan.outputs.released }}',
      sha: '${{ steps.plan.outputs.sha }}',
      tag: '${{ steps.plan.outputs.tag }}',
      version: '${{ steps.plan.outputs.version }}',
    });
  });

  it('fails a no-release plan only when main moved', () => {
    const unchanged = step('plan', 'Verify main unchanged');
    expect(unchanged.if).toBe("steps.plan.outputs.released != 'true'");
    expect(unchanged.run).toContain('git rev-parse HEAD');
    expect(unchanged.run).toContain('refs/heads/main');
    expect(unchanged.run).toContain('dispatch a new Release');
    expect(unchanged.run).toContain('re-run keeps the original commit');
  });

  it('publishes the notes as one artifact that draft and publish download', () => {
    const upload = step('plan', 'Upload the release notes');
    expect(upload.uses).toBe('actions/upload-artifact@v5');
    expect(upload.if).toBe("steps.plan.outputs.released == 'true'");
    expect(upload.with).toEqual({
      'if-no-files-found': 'error',
      name: 'release-notes',
      path: '${{ runner.temp }}/release-notes.md',
    });

    for (const name of ['draft', 'publish']) {
      const download = step(name, 'Download the release notes');
      expect(download.uses).toBe('actions/download-artifact@v5');
      expect(download.with).toEqual({ name: 'release-notes', path: '${{ runner.temp }}' });
    }
  });

  it('repeats the same authorization step first in every writing job', () => {
    const guard = job('authorize').steps?.[0];
    expect(guard?.id).toBe('authorize');
    expect(guard?.env).toEqual({
      ACTOR: '${{ github.triggering_actor }}',
      OWNER: '${{ github.repository_owner }}',
      REF: '${{ github.ref }}',
      REPO: '${{ github.repository }}',
    });

    for (const name of ['draft', 'publish']) {
      const first = job(name).steps?.[0];
      expect(first?.name).toBe('Authorize the owner on main');
      expect(first?.id).toBe('authorize');
      expect(first?.run).toBe(guard?.run);
      expect(first?.env).toEqual(guard?.env);
    }
  });

  it('creates the draft without a checkout and without a tag', () => {
    const draft = job('draft');
    expect(draft.steps?.some((candidate) => candidate.uses?.startsWith('actions/checkout'))).toBe(
      false,
    );
    expect(draft.env).toEqual({
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });

    const create = step('draft', 'Create the draft release');
    expect(create.env).toEqual({
      NOTES: '${{ runner.temp }}/release-notes.md',
      SHA: '${{ needs.plan.outputs.sha }}',
      TAG: '${{ needs.plan.outputs.tag }}',
    });
    expect(create.run).toContain('gh api --paginate "repos/$GH_REPO/releases"');
    expect(create.run).toContain('gh release create "$TAG" --draft --target "$SHA" --title "$TAG"');
    expect(create.run).toContain('--notes-file "$NOTES"');
    expect(create.run).toContain('git ls-remote --tags "$REMOTE"');
    expect(create.run).toContain('gh api --method DELETE');
  });

  it('publishes the draft after reading the image digests', () => {
    const publish = job('publish');
    expect(
      publish.steps?.some((candidate) => candidate.uses?.startsWith('actions/checkout')),
    ).toBe(false);
    expect(publish.env).toEqual({
      GH_REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });

    const login = step('publish', 'Log in to GHCR');
    expect(login.uses).toBe('docker/login-action@v4');
    expect(login.with).toEqual({
      password: '${{ secrets.GITHUB_TOKEN }}',
      registry: 'ghcr.io',
      username: '${{ github.actor }}',
    });

    const release = step('publish', 'Publish the release');
    expect(release.run).toContain('docker buildx imagetools inspect');
    expect(release.run).toContain("--format '{{.Manifest.Digest}}'");
    expect(release.run).toContain(
      'gh release edit "$TAG" --draft=false --target "$SHA" --notes-file "$body"',
    );
    expect(release.run).toContain('refs/tags/$TAG^{}');
    expect(release.run).toContain('## Docker images');
  });

  it('never dispatches, pushes, commits, or publishes to npm', () => {
    const runs = runSteps();
    expect(runs.length).toBeGreaterThan(0);
    for (const { jobName, step: candidate } of runs) {
      const run = candidate.run ?? '';
      const where = `${jobName}: ${candidate.name}`;
      expect(run, where).not.toContain('repository_dispatch');
      expect(run, where).not.toMatch(/^npm run release$/m);
      expect(run, where).not.toContain('git push');
      expect(run, where).not.toContain('git commit');
      expect(run, where).not.toContain('npm publish');
    }
    expect(source).not.toContain('repository_dispatch');
  });

  it('exists where the publish guard looks for it', () => {
    const guard = readFileSync('.github/workflows/publish-docker.yml', 'utf8');
    const reference = guard.match(
      /\$GITHUB_REPOSITORY\/(\.github\/workflows\/[^@]+)@refs\/heads\/main/,
    );
    expect(reference?.[1]).toBe('.github/workflows/release.yml');
    expect(existsSync(reference?.[1] ?? '')).toBe(true);
  });
});

const authorizeCopies = [
  { jobName: 'authorize', step: job('authorize').steps?.[0] },
  { jobName: 'draft', step: job('draft').steps?.[0] },
  { jobName: 'publish', step: job('publish').steps?.[0] },
];

type AuthorizeCase = {
  env?: Record<string, string>;
  exit: number;
  name: string;
  stderr?: string;
};

const authorizeCases: AuthorizeCase[] = [
  {
    exit: 0,
    name: 'the owner on main passes',
  },
  {
    env: { ACTOR: 'Raidenyn' },
    exit: 0,
    name: 'the owner login is compared case-insensitively',
  },
  {
    env: { ACTOR: 'collaborator' },
    exit: 1,
    name: 'a collaborator is refused',
    stderr: 'only the repository owner can run Release',
  },
  {
    env: { ACTOR: '' },
    exit: 1,
    name: 'a missing actor is refused',
    stderr: 'only the repository owner can run Release',
  },
  {
    env: { REF: 'refs/heads/feature' },
    exit: 1,
    name: 'a branch ref is refused',
    stderr: 'Release must be dispatched from refs/heads/main',
  },
  {
    env: { REF: 'refs/tags/v1.2.3' },
    exit: 1,
    name: 'a tag ref is refused',
    stderr: 'Release must be dispatched from refs/heads/main',
  },
  {
    env: { REPO: 'someone/line-mcp', OWNER: 'someone' },
    exit: 1,
    name: 'another repository is refused',
    stderr: 'Release runs only in raidenyn/line-mcp',
  },
];

const AUTHORIZE_ENV = {
  ACTOR: 'raidenyn',
  OWNER: 'raidenyn',
  REF: 'refs/heads/main',
  REPO: 'raidenyn/line-mcp',
};

describe('authorize script', () => {
  it('is present in all three writing jobs', () => {
    for (const copy of authorizeCopies) {
      expect(copy.step?.run, copy.jobName).toBe(authorizeCopies[0].step?.run);
    }
  });

  it.each(authorizeCases)('$name', (testCase) => {
    for (const copy of authorizeCopies) {
      const result = runStep(copy.step?.run ?? '', {
        env: { ...AUTHORIZE_ENV, ...testCase.env },
        fakes: {},
      });
      expect(result.status, copy.jobName).toBe(testCase.exit);
      expect(result.output, copy.jobName).toEqual({});
      if (testCase.stderr) {
        expect(result.stderr, copy.jobName).toContain(`::error::${testCase.stderr}`);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
      }
    }
  });

  it('names each refusal distinctly', () => {
    const messages = authorizeCases
      .filter((testCase) => testCase.exit !== 0)
      .map((testCase) =>
        runStep(authorizeCopies[0].step?.run ?? '', {
          env: { ...AUTHORIZE_ENV, ...testCase.env },
          fakes: {},
        }).stderr.trim(),
      );
    expect(messages).toHaveLength(5);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

const DRAFT_GIT = `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" != 'ls-remote' ]; then
  printf 'unexpected git invocation: %s\\n' "$*" >&2
  exit 1
fi
count=0
if [ -f "\${FAKE_GIT_COUNT:?}" ]; then
  count=$(cat "$FAKE_GIT_COUNT")
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GIT_COUNT"
if [ -n "\${FAKE_TAG_FAIL_AT:-}" ] && [ "$count" = "$FAKE_TAG_FAIL_AT" ]; then
  printf 'fatal: unable to access the remote\\n' >&2
  exit 128
fi
sha="\${FAKE_TAG_SHA:-}"
marker="\${FAKE_TAG_AFTER_CREATE:-}"
if [ -n "$sha" ] && { [ -z "$marker" ] || [ -e "$marker" ]; }; then
  printf '%s\\t%s\\n' "$sha" "\${@: -1}"
fi
`;

const DRAFT_GH = `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$FAKE_LOG"
command="$1"
shift
case "$command" in
  api)
    if [ "\${FAKE_GH_API_FAIL:-0}" = 1 ]; then
      printf 'gh: server error\\n' >&2
      exit 1
    fi
    case "$*" in
      *"--method DELETE"*)
        printf 'delete %s\\n' "\${@: -1}" >> "$FAKE_LOG"
        ;;
      *)
        printf '%s\\n' "\${FAKE_RELEASES:-}"
        ;;
    esac
    ;;
  release)
    if [ "$1" != 'create' ]; then
      printf 'unexpected gh release subcommand: %s\\n' "$1" >&2
      exit 1
    fi
    shift
    notes=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = '--notes-file' ]; then
        notes="$argument"
      fi
      previous="$argument"
    done
    cat "$notes" >> "\${FAKE_NOTES_LOG:?}"
    if [ -n "\${FAKE_TAG_AFTER_CREATE:-}" ]; then
      : > "$FAKE_TAG_AFTER_CREATE"
    fi
    ;;
  *)
    printf 'unexpected gh invocation: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`;

type DraftCase = {
  creates?: boolean;
  env?: Record<string, string>;
  exit: number;
  name: string;
  releases?: string[];
  stderr?: string;
};

const draftCases: DraftCase[] = [
  {
    exit: 0,
    name: 'no existing release creates the draft',
  },
  {
    exit: 0,
    name: 'two stale drafts for the tag are both replaced',
    releases: ['v1.2.3\ttrue\t11', 'v1.2.3\ttrue\t22', 'v1.1.0\ttrue\t33'],
  },
  {
    env: { FAKE_RELEASES: 'v1.2.3\tfalse\t44' },
    exit: 1,
    name: 'an already published release blocks the draft',
    stderr: 'v1.2.3 is already published',
  },
  {
    env: { FAKE_TAG_SHA: OTHER_SHA },
    exit: 1,
    name: 'an existing remote tag blocks the draft',
    stderr: 'git tag v1.2.3 already exists',
  },
  {
    env: { FAKE_GH_API_FAIL: '1' },
    exit: 1,
    name: 'a failed release listing blocks the draft',
    stderr: 'cannot list releases',
  },
  {
    env: { FAKE_TAG_FAIL_AT: '1' },
    exit: 1,
    name: 'a failed pre-create tag query refuses the draft',
    releases: ['v1.2.3\ttrue\t55'],
    stderr: 'cannot read tags from',
  },
  {
    env: { FAKE_TAG_FAIL_AT: '2' },
    exit: 1,
    name: 'a failed post-create tag query fails the run',
    creates: true,
    stderr: 'cannot verify that drafting created no tag',
  },
  {
    creates: true,
    env: { FAKE_TAG_AFTER_CREATE: '@created', FAKE_TAG_SHA: OTHER_SHA },
    exit: 1,
    name: 'a tag created by the draft fails the run',
    stderr: 'must not tag',
  },
];

const DANGEROUS_NOTES = '# 1.2.3\n\n* fix: keep `x` $(rm -rf /) "q"\n';

describe('draft step', () => {
  const create = step('draft', 'Create the draft release');

  function runDraft(testCase: DraftCase) {
    const dir = scratch();
    const env: Record<string, string> = {
      FAKE_GIT_COUNT: dir.path('git-count'),
      FAKE_LOG: dir.file('log'),
      FAKE_NOTES_LOG: dir.file('notes-log'),
      FAKE_RELEASES: (testCase.releases ?? []).join('\n'),
      GH_REPO: 'raidenyn/line-mcp',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'raidenyn/line-mcp',
      GITHUB_SERVER_URL: 'https://github.com',
      NOTES: dir.file('release-notes.md', DANGEROUS_NOTES),
      SHA,
      TAG: 'v1.2.3',
      ...testCase.env,
    };
    // `@name` env values stand for a path inside this case's scratch directory.
    for (const [key, value] of Object.entries(env)) {
      if (value.startsWith('@')) env[key] = dir.path(value.slice(1));
    }
    const result = runStep(create.run ?? '', {
      env,
      fakes: { git: DRAFT_GIT, gh: DRAFT_GH },
    });
    return { ...result, log: dir.read('log'), notes: dir.read('notes-log') };
  }

  it.each(draftCases)('$name', (testCase) => {
    const result = runDraft(testCase);
    expect(result.status).toBe(testCase.exit);
    if (testCase.stderr) {
      expect(result.stderr).toContain(testCase.stderr);
      expect(result.stderr).toContain('::error::');
    }
    if (testCase.exit === 0 || testCase.creates) {
      expect(result.log).toContain(
        `gh release create v1.2.3 --draft --target ${SHA} --title v1.2.3 --notes-file`,
      );
    } else {
      expect(result.log).not.toContain('release create');
    }
  });

  it('deletes only the stale drafts for its own tag', () => {
    const result = runDraft({
      exit: 0,
      name: 'two stale drafts for the tag are both replaced',
      releases: ['v1.2.3\ttrue\t11', 'v1.2.3\ttrue\t22', 'v1.1.0\ttrue\t33'],
    });
    expect(result.log).toContain('delete repos/raidenyn/line-mcp/releases/11');
    expect(result.log).toContain('delete repos/raidenyn/line-mcp/releases/22');
    expect(result.log).not.toContain('releases/33');
    expect(result.log.indexOf('releases/11')).toBeLessThan(
      result.log.indexOf('release create'),
    );
  });

  it('asserts no tag exists before and after creating the draft', () => {
    const result = runDraft({ exit: 0, name: 'no existing release creates the draft' });
    const tagQueries = result.log.match(/git ls-remote --tags/g) ?? [];
    expect(tagQueries).toHaveLength(2);
    expect(result.log.indexOf('git ls-remote --tags')).toBeLessThan(
      result.log.indexOf('release create'),
    );
  });

  it('refuses before deleting or creating when the tag query fails', () => {
    const result = runDraft({
      env: { FAKE_TAG_FAIL_AT: '1' },
      exit: 1,
      name: 'a failed pre-create tag query refuses the draft',
      releases: ['v1.2.3\ttrue\t55'],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::cannot read tags from');
    expect(result.log).not.toContain('delete');
    expect(result.log).not.toContain('release create');
  });

  it('passes the notes to gh as a file, byte for byte', () => {
    const result = runDraft({ exit: 0, name: 'no existing release creates the draft' });
    expect(result.notes).toBe(DANGEROUS_NOTES);
  });
});

const MAIN_GIT = `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  'rev-parse HEAD')
    printf '%s\\n' "\${FAKE_HEAD:?}"
    ;;
  ls-remote*)
    if [ "\${FAKE_LS_REMOTE_FAIL:-0}" = 1 ]; then
      printf 'fatal: unable to access the remote\\n' >&2
      exit 128
    fi
    if [ -n "\${FAKE_REMOTE_HEAD:-}" ]; then
      printf '%s\\trefs/heads/main\\n' "$FAKE_REMOTE_HEAD"
    fi
    ;;
  *)
    printf 'unexpected git invocation: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`;

type MainCase = {
  env?: Record<string, string>;
  exit: number;
  name: string;
  stderr?: string;
};

const mainCases: MainCase[] = [
  { exit: 0, name: 'main still at the checked-out commit passes' },
  {
    env: { FAKE_REMOTE_HEAD: OTHER_SHA },
    exit: 1,
    name: 'main moving during planning fails',
    stderr: 'dispatch a new Release',
  },
  {
    env: { FAKE_REMOTE_HEAD: '' },
    exit: 1,
    name: 'a missing remote head fails',
    stderr: 'dispatch a new Release',
  },
  {
    env: { FAKE_LS_REMOTE_FAIL: '1' },
    exit: 1,
    name: 'an unreadable remote fails',
    stderr: 'cannot read',
  },
];

describe('verify main unchanged step', () => {
  const verify = step('plan', 'Verify main unchanged');

  it.each(mainCases)('$name', (testCase) => {
    const dir = scratch();
    const result = runStep(verify.run ?? '', {
      env: {
        FAKE_HEAD: SHA,
        FAKE_LOG: dir.file('log'),
        FAKE_REMOTE_HEAD: SHA,
        GITHUB_REPOSITORY: 'raidenyn/line-mcp',
        GITHUB_SERVER_URL: 'https://github.com',
        ...testCase.env,
      },
      fakes: { git: MAIN_GIT },
    });
    expect(result.status).toBe(testCase.exit);
    expect(result.output).toEqual({});
    if (testCase.stderr) {
      expect(result.stderr).toContain(testCase.stderr);
      expect(result.stderr).toContain('::error::');
    }
  });
});

const PUBLISH_GH = `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" != 'release' ] || [ "$2" != 'edit' ]; then
  printf 'unexpected gh invocation: %s\\n' "$*" >&2
  exit 1
fi
shift 2
notes=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--notes-file' ]; then
    notes="$argument"
  fi
  previous="$argument"
done
cat "$notes" >> "\${FAKE_NOTES_LOG:?}"
`;

const PUBLISH_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" != 'buildx' ] || [ "$2" != 'imagetools' ] || [ "$3" != 'inspect' ]; then
  printf 'unexpected docker invocation: %s\\n' "$*" >&2
  exit 1
fi
reference="$4"
case "$reference" in
  *line-mcp-full:*)
    printf '%s\\n' "\${FAKE_DIGEST_FULL:?}"
    ;;
  *line-mcp:*)
    printf '%s\\n' "\${FAKE_DIGEST_BASE:?}"
    ;;
  *)
    printf 'unexpected image reference: %s\\n' "$reference" >&2
    exit 1
    ;;
esac
`;

const PUBLISH_GIT = `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" != 'ls-remote' ]; then
  printf 'unexpected git invocation: %s\\n' "$*" >&2
  exit 1
fi
reference="\${@: -1}"
case "$reference" in
  *'^{}')
    if [ -n "\${FAKE_PEELED_SHA:-}" ]; then
      printf '%s\\t%s\\n' "$FAKE_PEELED_SHA" "$reference"
    fi
    ;;
  "refs/tags/\${FAKE_TAG:?}")
    if [ -n "\${FAKE_TAG_SHA:-}" ]; then
      printf '%s\\t%s\\n' "$FAKE_TAG_SHA" "$reference"
    fi
    ;;
  *)
    printf 'unexpected tag reference: %s\\n' "$reference" >&2
    exit 1
    ;;
esac
`;

const DIGEST_FULL = `sha256:${'1'.repeat(64)}`;
const DIGEST_BASE = `sha256:${'2'.repeat(64)}`;

type PublishCase = {
  env?: Record<string, string>;
  exit: number;
  name: string;
  notes: string;
  stderr?: string;
};

const PUBLISH_NOTES = '# 1.2.3\n\n* fix: keep `x` $(rm -rf /) "q"\n';
const STALE_NOTES = `${PUBLISH_NOTES}\n## Docker images\n\n### \`ghcr.io/raidenyn/line-mcp-full:1.1.0\`\n\n- \`docker pull ghcr.io/raidenyn/line-mcp-full:1.1.0\`\n`;

const publishCases: PublishCase[] = [
  { exit: 0, name: 'a fresh body gets one image section', notes: PUBLISH_NOTES },
  {
    exit: 0,
    name: 'a body with an old image section gets exactly one',
    notes: STALE_NOTES,
  },
  {
    env: { FAKE_TAG_SHA: OTHER_SHA },
    exit: 1,
    name: 'a tag on another commit fails',
    notes: PUBLISH_NOTES,
    stderr: 'not the planned commit',
  },
];

describe('publish step', () => {
  const publish = step('publish', 'Publish the release');

  function runPublish(testCase: PublishCase) {
    const dir = scratch();
    const notes = dir.file('release-notes.md', testCase.notes);
    const env: Record<string, string> = {
      FAKE_DIGEST_BASE: DIGEST_BASE,
      FAKE_DIGEST_FULL: DIGEST_FULL,
      FAKE_LOG: dir.file('log'),
      FAKE_NOTES_LOG: dir.file('notes-log'),
      FAKE_TAG: 'v1.2.3',
      FAKE_TAG_SHA: SHA,
      GH_REPO: 'raidenyn/line-mcp',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'raidenyn/line-mcp',
      GITHUB_SERVER_URL: 'https://github.com',
      NOTES: notes,
      SHA,
      TAG: 'v1.2.3',
      ...testCase.env,
    };
    const result = runStep(publish.run ?? '', {
      env,
      fakes: { docker: PUBLISH_DOCKER, gh: PUBLISH_GH, git: PUBLISH_GIT },
    });
    return { ...result, body: dir.read('notes-log'), log: dir.read('log') };
  }

  it.each(publishCases)('$name', (testCase) => {
    const result = runPublish(testCase);
    expect(result.status).toBe(testCase.exit);
    if (testCase.stderr) {
      expect(result.stderr).toContain(testCase.stderr);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain(SHA);
      expect(result.stderr).toContain(OTHER_SHA);
    }
  });

  it('links both images with a pull command, a digest, and a package page', () => {
    const result = runPublish({ exit: 0, name: 'fresh', notes: PUBLISH_NOTES });
    expect(result.body.split('## Docker images')).toHaveLength(2);
    expect(result.body).toContain(PUBLISH_NOTES.trimEnd());
    expect(result.body).toContain('`docker pull ghcr.io/raidenyn/line-mcp-full:1.2.3`');
    expect(result.body).toContain(`\`ghcr.io/raidenyn/line-mcp-full@${DIGEST_FULL}\``);
    expect(result.body).toContain(
      'https://github.com/raidenyn/line-mcp/pkgs/container/line-mcp-full',
    );
    expect(result.body).toContain('`docker pull ghcr.io/raidenyn/line-mcp:1.2.3`');
    expect(result.body).toContain(`\`ghcr.io/raidenyn/line-mcp@${DIGEST_BASE}\``);
    expect(result.body).toContain('https://github.com/raidenyn/line-mcp/pkgs/container/line-mcp');
    expect(result.body.indexOf('## Docker images')).toBeGreaterThan(
      result.body.indexOf(PUBLISH_NOTES.trimEnd()),
    );
  });

  it('reads each digest from the registry before publishing', () => {
    const result = runPublish({ exit: 0, name: 'fresh', notes: PUBLISH_NOTES });
    expect(result.log).toContain(
      'docker buildx imagetools inspect ghcr.io/raidenyn/line-mcp-full:1.2.3 --format {{.Manifest.Digest}}',
    );
    expect(result.log).toContain(
      'docker buildx imagetools inspect ghcr.io/raidenyn/line-mcp:1.2.3 --format {{.Manifest.Digest}}',
    );
    expect(result.log).toContain(
      `gh release edit v1.2.3 --draft=false --target ${SHA} --notes-file`,
    );
    expect(result.log.indexOf('imagetools inspect')).toBeLessThan(
      result.log.indexOf('release edit'),
    );
  });

  it('strips the previous section instead of duplicating it', () => {
    const result = runPublish({
      exit: 0,
      name: 'stale',
      notes: STALE_NOTES,
    });
    expect(result.body.match(/## Docker images/g)).toHaveLength(1);
    expect(result.body).not.toContain('1.1.0');
    expect(result.body).toContain('ghcr.io/raidenyn/line-mcp-full:1.2.3');
  });

  it('prefers the peeled tag commit when the tag is annotated', () => {
    const result = runPublish({
      env: { FAKE_PEELED_SHA: SHA, FAKE_TAG_SHA: OTHER_SHA },
      exit: 0,
      name: 'annotated',
      notes: PUBLISH_NOTES,
    });
    expect(result.status).toBe(0);
    expect(result.log).toContain('refs/tags/v1.2.3^{}');
  });
});
