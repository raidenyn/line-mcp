# Semantic Release and Commit Policy Enforcement - Design

**Date:** 2026-07-18
**Status:** Approved
**Issues:** [#39](https://github.com/raidenyn/line-mcp/issues/39), integration contract with [#38](https://github.com/raidenyn/line-mcp/issues/38)

## Problem

The repository follows Conventional Commits by convention, but nothing checks
commit messages. It also has no release automation: maintainers must choose
versions, create tags, and write GitHub Release notes manually. This makes the
SemVer policy documented in `CLAUDE.md` advisory rather than reliable and
leaves no dependable release event for the future Docker publishing workflow.

All package manifests currently report `1.0.0`, despite the project having no
release tags. The release history needs an explicit pre-1.0 baseline before
automation starts.

## Goals

- Enforce one Conventional Commits policy in a local `commit-msg` hook and CI.
- Derive SemVer releases from commits on `main` with semantic-release.
- Publish deliberate, manually dispatched `vX.Y.Z` tags and GitHub Releases.
- Establish `v0.1.0` as the initial tag and GitHub Release.
- Provide a token-safe event that issue #38 can use to publish Docker images.
- Keep Git tags and GitHub Releases canonical; do not create release commits.

## Non-goals

- Publishing any npm package.
- Updating package manifests on every release.
- Maintaining a committed `CHANGELOG.md`.
- Releasing automatically on every push to `main`.
- Implementing the Docker publishing workflow from issue #38.

## Approach

Use semantic-release for release analysis and GitHub publishing, and use
commitlint for the shared commit policy. Husky gives contributors immediate
local feedback, while CI remains authoritative when hooks are absent or
bypassed. This favors mature Conventional Commits tooling over a custom parser
or custom release implementation.

## Commit Policy

`commitlint.config.cjs` extends `@commitlint/config-conventional` and therefore
enforces the full conventional preset, including its header and subject rules.
It restricts commit types to the repository's documented set:

- `feat`
- `fix`
- `refactor`
- `test`
- `docs`
- `chore`
- `ci`
- `build`
- `perf`

Scopes remain optional. Breaking changes use `!` in the header or a
`BREAKING CHANGE:` footer. Commitlint default ignores are disabled so every
commit in the selected range must satisfy the policy rather than silently
allowing generated merge or revert subjects.

A tracked `.husky/commit-msg` hook runs commitlint against Git's message file.
The root `prepare` script installs Husky after dependency installation. A named
root script exposes the same command for direct use and CI.

The existing CI workflow gains a separate commit-policy job with full Git
history:

- For a pull request, validate every commit from the PR base SHA through the PR
  head SHA, then validate the PR title separately. The title check protects the
  canonical squash-merge commit subject.
- For a push to `main`, validate every newly landed commit between the event's
  before and after SHAs. The all-zero initial-push SHA is handled by validating
  the new tip directly.
- Check out the PR head, not GitHub's synthetic merge commit.

Invalid input fails with commitlint's normal rule-specific diagnostics. Local
`--no-verify` remains available for Git itself, but cannot bypass CI.

## Release Policy

`.releaserc.json` defines:

- Release branch: `main` only.
- Tag format: `v${version}`.
- `@semantic-release/commit-analyzer` using Conventional Commits.
- `@semantic-release/release-notes-generator` for generated notes.
- `@semantic-release/github` for the tag and GitHub Release.

Release mapping is explicit:

| Commit | Release |
|---|---|
| Breaking change | Major |
| `feat` | Minor |
| `fix`, `perf` | Patch |
| All other allowed types | None |

The GitHub plugin's issue/PR comments and labels are disabled. This keeps the
workflow permission surface to `contents: write`; no external token is needed.
No changelog, npm, or git plugin is used, so semantic-release does not modify or
commit repository files.

## Release Workflow

`.github/workflows/release.yml` is triggered only by `workflow_dispatch`. It:

1. Checks out `refs/heads/main` with full history and tags, regardless of the
   ref selected in the dispatch UI.
2. Sets up the repository's Node 24 runtime and installs locked dependencies
   with `npm ci`.
3. Refreshes `origin/main` immediately before release and fails if the checked
   out commit is stale.
4. Records tags already present at `HEAD`.
5. Runs semantic-release with the built-in `GITHUB_TOKEN`.
6. Detects whether semantic-release created a new `vX.Y.Z` tag at `HEAD`.
7. If a tag was created, emits a `repository_dispatch` event named
   `release-published` with the tag in `client_payload`.

A workflow concurrency group allows only one release run at a time and does not
cancel a run already publishing. If no releasable commits exist after the
latest version tag, semantic-release exits successfully without a tag, Release,
or dispatch event. GitHub API or authentication errors fail the run. A stale
checkout fails before publishing and can be safely redispatched. Existing tags
make semantic-release reruns idempotent.

## Docker Publishing Contract

Tags and Release events created with `GITHUB_TOKEN` do not reliably trigger
ordinary downstream workflows because of GitHub's recursion protection.
GitHub explicitly permits `repository_dispatch` as an exception, so issue #38
should listen for the `release-published` event and consume
`github.event.client_payload.tag`. It may retain tag/release triggers for
maintainer-created releases, but the repository dispatch is the supported path
from this automated workflow.

Emitting the event before issue #38 is implemented is harmless: GitHub accepts
the dispatch even when no workflow currently handles it.

## Version Bootstrap

The implementation resets the root and all six workspace manifest versions
from `1.0.0` to `0.1.0`. Internal `@raidenyn/*` workspace dependency ranges are
changed from `^1.0.0` to `^0.1.0`, and `package-lock.json` is regenerated so its
root, workspace, and dependency metadata agree.

After the implementation is merged to `main`, a maintainer performs the
one-time bootstrap at that exact `main` commit:

1. Create and push the `v0.1.0` tag.
2. Publish the initial GitHub Release for `v0.1.0`.

The first semantic-release run then analyzes only commits after `v0.1.0`.
Later tags and GitHub Releases advance independently while all private package
manifests remain at `0.1.0`.

## Documentation

Update `CLAUDE.md` to state that `perf` maps to a patch release and that commit
messages are enforced locally and in CI. Add a concise maintainer runbook that
covers the one-time `v0.1.0` bootstrap, manual release dispatch, no-op behavior,
and the Git tag/GitHub Release source of truth. No architecture documentation
change is required because package and runtime boundaries do not change.

## Testing And Verification

Automated policy tests use the production configurations rather than duplicate
their rules:

- Commitlint accepts valid scoped/unscoped headers and both breaking-change
  forms.
- Commitlint rejects unknown types, malformed headers, and full-preset style
  violations.
- Representative commit sets produce major, minor, patch, and no-release
  outcomes, including `perf` as patch.
- CI range selection covers PR commits, PR titles, pushes to `main`, and an
  all-zero before SHA.

Workflow review verifies fixed-`main` checkout, full history, minimal
permissions, concurrency, stale-HEAD protection, no-op behavior, and dispatch
only after a newly created tag. Hook verification invokes the tracked hook with
valid and invalid temporary message files.

Before a PR, run the mandatory repository gate:

```bash
npm run lint && npm run build && npm run test:unit && npm run test:smoke
```

The post-merge `v0.1.0` tag and GitHub Release prove the bootstrap path. The
first later releasable commit and manual workflow dispatch provide the real
end-to-end semantic-release proof.

## Acceptance Criteria

- Invalid commit messages fail locally and in CI with actionable diagnostics.
- Every PR commit and the PR title are checked against the same policy.
- `perf` produces a patch; `fix` a patch; `feat` a minor; breaking changes a
  major; other allowed types produce no release.
- A manual run refuses a checkout that differs from `origin/main` at preflight
  and cannot race another release run.
- A releasable run creates one `vX.Y.Z` tag and GitHub Release with generated
  notes, then emits `release-published` with that tag.
- A run with only non-releasable commits succeeds without creating or
  dispatching anything.
- The project starts from a visible `v0.1.0` tag and GitHub Release.
- No external secret, npm publication, release commit, or committed changelog
  is introduced.
