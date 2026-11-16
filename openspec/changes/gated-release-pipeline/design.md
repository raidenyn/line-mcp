## Context

Current state (observed in the repo):

- `.github/workflows/release.yml` — `workflow_dispatch`, `contents: write`, checks out `refs/heads/main` regardless of the dispatched ref, verifies HEAD equals `origin/main` and that `v0.1.0` exists, runs `npm run release` (`semantic-release` with commit-analyzer, release-notes-generator, `@semantic-release/github`), detects the new tag, then POSTs a `release-published` `repository_dispatch`.
- `.github/workflows/publish-docker.yml` — triggers: `repository_dispatch`, `release: published`, `pull_request: labeled`, `workflow_dispatch(tag?)`. A `prepare` job resolves ref/sha/tag/latest/edge/pr; a matrix `publish` job (`ghcr-publish` environment, `packages: write`, `GITHUB_TOKEN`) builds `server` → `line-mcp-full` and `line-mcp` → `line-mcp`.
- Versions exist only as git tags and GitHub Releases; `package.json` files stay at `0.1.0`; `v0.1.0` is the only release and has no images.
- Tests in `tests/release/` parse both workflows as YAML and execute the `prepare` resolve script against a fake `git`.

Constraints: no `npm publish`; no personal access token (workflow `GITHUB_TOKEN` only); GHCR only; the `ghcr-publish` environment's owner approval stays and the environment keeps serving PR-level publishing; the repo is a personal account (`raidenyn`), so "owner" is `github.repository_owner`; `main` is protected, so the workflow must not push commits.

## Goals / Non-Goals

**Goals:**
- Only the owner can start a release, only from `main`.
- No release-tagged image (`X.Y.Z`, `X.Y`, `X`, `latest`) is published except as part of a release run; labeled-PR builds push only `pr-<number>`/`sha-<short>`; no release is public without its images.
- No git tag exists until the release is published.
- Release notes cover commits since the latest release tag and end with image links.
- A failed run is recoverable by re-running it (same commit) or, if `main` has moved, by dispatching a new run.

**Non-Goals:**
- Version commits or changelog files (tags stay the source of truth).
- Prereleases, release channels, or multiple release branches.
- npm publication; registries other than GHCR; multi-arch images.
- Backfilling images for `v0.1.0`.
- Changing the Dockerfile, image names, tag scheme semantics, or visibility policy.

## Decisions

**1. One workflow, five stages.** `release.yml` jobs: `authorize` → `plan` → `draft` → `images` (reusable-workflow call) → `publish`. Job-level `needs` makes `publish` run only when `images` succeeded. Rationale: the whole flow is visible and re-runnable in one run; the alternative (separate workflows chained by dispatch) is what loses atomicity today.

**2. Authorization is a failing step, not a skipped job.** `authorize` exits non-zero unless `github.repository == 'raidenyn/line-mcp'`, `github.triggering_actor == github.repository_owner`, and `github.ref == 'refs/heads/main'`. A job-level `if` would show a green "skipped" run. `triggering_actor` (not `actor`) so a re-run by someone else is judged by who re-ran it; logins are compared case-insensitively. All other jobs `need` it. Because "Re-run failed jobs" keeps the outputs of jobs that already succeeded and does not re-run `authorize`, the same guard step (identical script, step id `authorize`) is also the first step of `draft` and `publish`, the jobs that hold `contents: write`; `images` is covered by the environment approval. The `ghcr-publish` environment approval remains the second layer for the image deployment: workflow files on `main` are protected by review, and a write-access collaborator can otherwise dispatch.

**3. `semantic-release` is only a planner.** `scripts/release-plan.mjs` calls the JS API with `{ dryRun: true, branches: ['main'] }` (no `ci` override: `env-ci` detects GitHub Actions and takes the branch from `GITHUB_REF`), and writes `released`, `version`, `tag`, `sha` (`nextRelease.gitHead`), and the notes file (`nextRelease.notes`). Rationale: stock `semantic-release` pushes the tag in core *before* plugins run, so `draftRelease: true` would still tag early — it conflicts with "no tag until publish". A dry run creates nothing: `prepare`/`publish`/`success`/`fail` are skipped and tag creation is skipped, while `generateNotes` still runs. `@semantic-release/github` is removed from `.releaserc.json` and `devDependencies` (the workflow creates the release with `gh`); it stays in `package-lock.json` as a transitive dependency of `semantic-release`, which is harmless because only listed plugins load. Commit-analyzer rules and the `conventionalcommits` preset (backed by the existing `conventional-changelog-conventionalcommits` devDependency) stay. "No releasable commits" → `released=false`, later jobs are skipped by `if`, run succeeds.

**3a. `plan` needs `contents: write`, kept away from install scripts.** `semantic-release` always probes push access with `git push --dry-run HEAD:main` and throws `EGITNOPERMISSION` on failure **even in dry-run** (it only returns `false` instead when the local branch is behind the remote), so a `contents: read` token cannot plan. The probe writes nothing. To limit the write token: checkout with `persist-credentials: false` and the default ref (a local `main` branch at `github.sha`, not a detached HEAD), `npm ci --ignore-scripts`, and `GITHUB_TOKEN` passed only in the planner step's env. Because `false` can also mean "`main` moved during planning", a `Verify main unchanged` step after the planner fails the run when `released=false` and `HEAD` is no longer the remote `main` head.

**4. The draft holds the release without a tag.** `draft` runs `gh release create vX.Y.Z --draft --target <sha> --title vX.Y.Z --notes-file notes.md` (deleting a stale draft for the same tag first; refusing if a published release or the tag already exists) and asserts `git ls-remote --tags` shows no `vX.Y.Z`. Publishing the draft (`gh release edit vX.Y.Z --draft=false --target <sha>`, repeating the target in the publishing request) makes GitHub create the tag at `target_commitish`; `publish` asserts it resolves to the planned SHA. `gh release edit <tag>` finds a draft by its pending tag name (GraphQL fallback in `gh`'s `FetchRelease`), so it works before the tag exists; deleting every stale draft first keeps that lookup unambiguous. `draft` and `publish` do not check out the repository: they set `GH_REPO: ${{ github.repository }}` and `GH_TOKEN`, and query tags with `git ls-remote "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"` (the public-repository form the `resolve` step already uses), never `origin`. Alternative rejected: tag-then-draft (`semantic-release` `draftRelease`) — see brainstorm Alternative B.

**5. The planned SHA is `github.sha`.** `plan` verifies `HEAD == origin/main` (as today). A re-run keeps the original `github.sha` and `github.ref`, so once `main` has moved a re-run fails this check and the owner dispatches a new run instead; the error says so. From then on the SHA is passed explicitly: images are built from it and the draft targets it, so a later push to `main` cannot change what ships. `Publish Docker` takes only `tag` and builds `github.sha` of the caller; it asserts that equals the checked-out commit.

**6. `Publish Docker` has two triggers: `workflow_call` and the labeled PR.** `on: { workflow_call: { inputs: { tag: { type: string, required: false } } }, pull_request: { types: [labeled] } }`. It drops `repository_dispatch`, `release`, `workflow_dispatch`, the prerelease branch, and the `edge` metadata step. The `prepare` `resolve` step decides the mode from the event: `pull_request` → PR mode (label must be `publish-docker`, head repo must be this repo, `tag` ignored); `workflow_dispatch` *as seen by a called workflow* (the `github` context of a called workflow is the caller's) with `github.workflow_ref == '<repository>/.github/workflows/release.yml@refs/heads/main'`, `github.ref == 'refs/heads/main'`, and a valid `tag` → release mode; anything else fails before any push. `workflow_ref` names the caller's file and ref, so another workflow that merely shares the `Release` name is refused (stronger than comparing `github.workflow`). The caller job grants `contents: read` and `packages: write`; the `publish` job keeps `environment: ghcr-publish` and the `GITHUB_TOKEN` login. The `concurrency` block (`group: publish-docker`, `queue: max`) stays: its group name differs from `Release`'s `release` group, so a called workflow cannot deadlock against its caller, and a queued release run is still not evicted by PR runs.

**6a. Enforced tag allowlist.** After the metadata steps and before `build`, an `Assert tag allowlist` step reads the tag list that will be pushed. In PR mode the tag part (after the last `:`) of every reference must match `^(pr-[0-9]+|sha-[0-9a-f]{7})$`, so a PR build can never create or move `latest`, `X.Y`, `X`, or `X.Y.Z`, even if the metadata configuration is edited wrongly. In release mode no tag may start with `pr-`. Tests execute the step against a table of tag lists. A failure stops the job before the push. This turns "PR builds never touch release tags" from convention into a checked invariant.

**7. Tag scheme is unchanged, with one wrinkle.** `X.Y.Z` and `sha-<short>` always; `X.Y`, `latest`, and `X` (never on `0.x`) only when the version is the newest stable. Since `vX.Y.Z` is not yet on the remote, "newest" compares the new version against `git ls-remote` stable tags **including the new one**. `sha-<short>` and the revision label name the planned commit.

**8. Image links in the notes.** `publish` appends a `## Docker images` section to the draft body: for each image a `docker pull …:X.Y.Z` line, the digest reference (`…@sha256:…`), and the package page. Digests are read after the push with `docker buildx imagetools inspect`. That job logs in to GHCR read-only (`packages: read`). Notes are not regenerated; only the section is appended, idempotently (strip a previous section before appending, so a re-run is stable).

**9. Docs/tests move with the code.** `docs/RELEASING.md` rewrites "Normal Release", deletes "Publication and re-publication", replaces the `edge`-based first-publication steps (1 and 4), and keeps "Pull-request images" with the tag allowlist added; the first publication is now the first `Release` run (or a labeled PR build, if that comes first). Workflow tests keep the existing technique (parse YAML; execute extracted bash with a fake `git`/`gh`) for the new `authorize`, `draft`, and `publish` scripts. To keep that testable, non-trivial bash lives in the workflow, as today, and is extracted by step id.

## Risks / Trade-offs

- [Superseded assumption: "the push probe is only a warning under `dryRun`"] → wrong. In `semantic-release` 25.0.8 `index.js`, `verifyAuth` failure throws `EGITNOPERMISSION` regardless of `dryRun`. Corrected by Decision 3a (`plan` gets `contents: write`, isolated from install scripts). No tag is created either way: tag/push calls sit in the non-`dryRun` branch.
- [`semantic-release` returns `false` when the branch is behind] → would look like "nothing to release"; caught by `Verify main unchanged` (Decision 3a).
- [Partial re-run by a collaborator] → "Re-run failed jobs" skips the succeeded `authorize` and runs with the original actor's privileges; the guard repeated in `draft` and `publish` refuses it (Decision 2).
- [A draft publish might not create the tag at the SHA as expected] → `publish` asserts `git ls-remote refs/tags/vX.Y.Z` equals the planned SHA and fails loudly otherwise; the release is already public at that point, so the runbook documents the manual fix.
- [Image tags pushed, then release never published] → `X.Y.Z`/`sha-<short>` exist without a release. Tags are mutable and the re-run overwrites them; `latest`/`X.Y`/`X` move at image-push time, slightly before the release is public. Accepted: pre-publication ordering is the point of the design. Documented in the runbook.
- [A queued or re-run `Release` whose `main` moved] → `plan` fails the staleness check (re-runs keep the original SHA); the owner dispatches a new run, which may plan a different version. Stale drafts for another version are left alone and listed in the runbook cleanup step.
- [Losing manual re-publish and `edge`] → deliberate. A broken image is fixed by a new release. Existing `edge` tags on GHCR are left for the owner to delete; `pr-*` tags stay valid.
- [A PR build and a release both write `sha-<short>`] → they are different commits (a PR head vs the release commit on `main`), and the allowlist keeps PR builds off every version and moving tag.
- [A same-repository PR can edit the workflow it triggers] → unchanged from today: the owner approval on `ghcr-publish` is the trust boundary, and the allowlist step is part of the workflow, so it is reviewed like any other change; a PR that removes it still needs the approval to push anything.
- [Owner-only check bypassed by editing the workflow on a branch] → `github.ref` must be `main` and `main` is protected; plus environment approval.
- [The caller guard is a string] → it compares `github.workflow_ref` to `${GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`; a test asserts the path equals the real file name. If GitHub ever reported the callee's ref instead, the guard fails closed (no push) on the first run.
- [Publishing makes the release "Latest"] → `make_latest` defaults to `true` for newly published releases; correct here because `semantic-release` on `main` only plans versions above the latest tag.
- [Tag created by `GITHUB_TOKEN` triggers nothing] → events caused by `GITHUB_TOKEN` start no workflows, and no workflow listens for tag or release events any more.

## Migration Plan

1. Merge the change (no image or release is created by merging).
2. No environment change: `ghcr-publish` keeps its required reviewer and its deployment-branch policy keeps permitting `main` and pull-request refs.
3. Run `Release` from `main`. First real run: approve the `ghcr-publish` deployment, confirm the draft becomes a release with links; then perform the one-time public visibility flip documented in `docs/RELEASING.md` (packages are created private) — the existing, owner-only, irreversible step, now after the first publication (normally this release; a labeled PR build if it came first) instead of an `edge` build.
4. Rollback: revert the PR; no data migration. A stuck draft release can be deleted in the GitHub UI.

## Open Questions

- Should `Release` take an optional "dry run" input (plan and post notes to the run summary without drafting)? Not required; deferred.
- *(Resolved by the owner, kept simple.)* **Moving tags are pushed by `images`**, before the release is public. A run that fails after `images` can leave `latest`/`X.Y`/`X` on an unreleased image until the re-run; the owner judged the chance of `publish` failing low enough not to add a post-publish `imagetools create` step. Revisit only if that failure is ever observed.
- *(Resolved by the owner.)* **`plan` holds `contents: write`** (Decision 3a): it pushes nothing, and the alternative is dropping `semantic-release`.

Testable assumptions not verifiable offline (each caught on the first real run):

- A draft release creates no tag, and publishing it creates the tag at `target_commitish` = planned SHA (REST docs: `target_commitish` "determines where the Git tag is created from"; drafts not stated) → `draft` asserts no tag; `publish` asserts tag == SHA.
- `github.workflow_ref`, `github.event_name`, `github.ref` and `github.sha` in the called workflow are the caller's (docs: "the `github` context is always associated with the caller workflow") → the release-mode guard fails closed otherwise.
- The `ghcr-publish` deployment-branch policy is evaluated against the caller's ref (`main`) for the release call → the first run's deployment request shows it.
- The callee's workflow-level `concurrency` (`publish-docker`, `queue: max`) is honoured in a called workflow and never matches the caller's `release` group → if `queue: max` is not honoured, a newer pending PR run can cancel the pending release call; `publish` is then skipped and the release stays a draft (safe; re-run).
