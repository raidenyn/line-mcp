# release-pipeline Specification

## Purpose

Define the owner-only, `main`-only release path: plan the next version and its notes, hold the release as a tagless draft, build and link both images, then publish the draft, which creates the git tag at the planned commit.

## Requirements

### Requirement: Only the repository owner can run a release

The `Release` workflow MUST fail before planning anything unless the run was
triggered by the repository owner in the `raidenyn/line-mcp` repository. The
check MUST use the triggering actor, so a re-run is judged by whoever re-ran it,
and MUST fail the run rather than skip it, so a refused attempt is visible.
Every job that holds write access to repository contents MUST repeat the check,
because re-running only failed jobs does not re-run the authorization stage.

#### Scenario: The owner starts a release

- **WHEN** the repository owner dispatches `Release` from `main`
- **THEN** the authorization stage succeeds and planning starts

#### Scenario: A collaborator is refused

- **WHEN** any other account with write access dispatches `Release`
- **THEN** the run fails in the authorization stage with a message naming the
  owner requirement
- **AND** no version is planned, no draft is created, and no image is built

#### Scenario: A re-run by a non-owner is refused

- **WHEN** a non-owner re-runs a `Release` run the owner started
- **THEN** the authorization stage fails

#### Scenario: A partial re-run by a non-owner is refused

- **WHEN** a non-owner uses "Re-run failed jobs" on a `Release` run the owner
  started, so the succeeded authorization stage is not re-run
- **THEN** the draft and publish stages fail their own owner check before
  changing any release

### Requirement: Releases run only from main

The `Release` workflow MUST fail before planning unless it was dispatched from
`refs/heads/main`, and MUST verify that the checked-out commit is the current
head of `origin/main` and that the `v0.1.0` baseline tag exists. The workflow
MUST NOT silently substitute `main` for another dispatched ref.

#### Scenario: Dispatch from a branch is refused

- **WHEN** `Release` is dispatched from any ref other than `refs/heads/main`
- **THEN** the run fails in the authorization stage
- **AND** nothing is planned, drafted, or built

#### Scenario: A stale checkout is refused

- **WHEN** `origin/main` has advanced past the commit the run started from
- **THEN** planning fails and instructs the owner to dispatch a new run (a
  re-run keeps the original commit)

#### Scenario: A missing baseline tag is refused

- **WHEN** the `v0.1.0` tag does not exist
- **THEN** planning fails with a pointer to the bootstrap runbook

### Requirement: Release is a single manual workflow

`Release` MUST be started only by `workflow_dispatch`, MUST NOT define any other
trigger, and MUST serialize runs without cancelling an in-progress release.

#### Scenario: Nothing else starts a release

- **WHEN** a push, merge, schedule, label, or release event occurs
- **THEN** `Release` does not start

### Requirement: Plan the version and notes from commits since the latest release

Planning MUST use `semantic-release` in dry-run mode on `main` to compute the
next version and its release notes from the commits since the latest release
tag. Planning MUST NOT create a git tag, a GitHub Release, or push anything.
When there are no releasable commits the run MUST succeed without drafting,
building, or publishing anything. A "no release" result MUST NOT be reported as
success when `main` moved during planning.

#### Scenario: Releasable commits produce a plan

- **WHEN** `main` has a `feat` commit since the latest release tag
- **THEN** planning outputs the next minor version, its `vX.Y.Z` tag name, the
  commit SHA, and generated notes listing the changes since the latest release
- **AND** no tag exists on the remote afterwards

#### Scenario: Nothing releasable is a no-op

- **WHEN** every commit since the latest release is `docs`, `chore`, `ci`,
  `test`, `refactor`, or `build`
- **THEN** the run succeeds
- **AND** no draft release, image, or tag is created

#### Scenario: Main moving during planning is not a silent no-op

- **WHEN** planning reports no release and `main`'s remote head is no longer the
  checked-out commit
- **THEN** the run fails and instructs the owner to dispatch a new run

### Requirement: Hold the release as a draft without a tag

After planning, the workflow MUST create a **draft** GitHub Release named for
the planned tag, with the generated notes as its body and the planned commit as
its target, and MUST verify the git tag does not yet exist. A stale draft for the
same tag MUST be replaced. The workflow MUST refuse to proceed if a published
release or an existing tag for that version is found.

#### Scenario: A draft exists and no tag does

- **WHEN** the draft stage completes
- **THEN** a draft release for `vX.Y.Z` exists with the notes as its body
- **AND** `git ls-remote --tags` shows no `vX.Y.Z`

#### Scenario: A stale draft is replaced

- **WHEN** a previous run left a draft for the same tag
- **THEN** the new run deletes it and creates a fresh one

#### Scenario: An existing tag blocks the release

- **WHEN** the planned tag already exists on the remote
- **THEN** the draft stage fails before creating a release

### Requirement: Images are published before the release goes public

The release MUST be published only after `Publish Docker` has succeeded for the
planned tag and commit. A failed image build MUST leave the release a draft with
no tag.

#### Scenario: A successful build allows publication

- **WHEN** both images are pushed for the planned tag
- **THEN** the publish stage runs

#### Scenario: A failed build leaves nothing public

- **WHEN** either image build or push fails
- **THEN** the publish stage does not run
- **AND** the release remains a draft and no git tag exists

### Requirement: Release notes link the published images

Before publishing, the workflow MUST append a "Docker images" section to the
notes listing, for each of the two images, its version-tag pull command, its
digest reference, and its package page. Appending MUST be idempotent: a re-run
MUST NOT duplicate the section.

#### Scenario: The published notes carry image links

- **WHEN** the release is published
- **THEN** its body contains the generated notes followed by one "Docker images"
  section naming `ghcr.io/raidenyn/line-mcp-full` and `ghcr.io/raidenyn/line-mcp`
  at the released version, with digest references

#### Scenario: Re-appending does not duplicate

- **WHEN** the publish stage runs against a body that already has the section
- **THEN** the resulting body has exactly one such section

### Requirement: Publishing the draft creates the tag at the planned commit

The publish stage MUST publish the draft, which causes GitHub to create
`vX.Y.Z`, and MUST then verify the tag resolves to the planned commit. The
repository MUST NOT push a tag any other way.

#### Scenario: The tag appears only on publish

- **WHEN** the publish stage completes
- **THEN** `vX.Y.Z` exists on the remote and points to the planned commit
- **AND** the release is no longer a draft

#### Scenario: A mismatched tag fails the run

- **WHEN** the created tag does not resolve to the planned commit
- **THEN** the run fails with an error naming both commits

### Requirement: Re-running a failed release recovers cleanly

After any failure the owner MUST be able to recover by re-running the run
(which keeps its original commit) while `main` has not moved, or otherwise by
dispatching a new `Release` run, which plans from the new `main` head. Either
way the workflow MUST replace any stale draft for the planned tag and rebuild
the images. No manual cleanup beyond fixing the reported cause MUST be required.

#### Scenario: A failed image build is retried

- **WHEN** a run failed in the image stage and the owner re-runs it while
  `main` is unchanged
- **THEN** the images are rebuilt for the same planned commit
- **AND** the release is published when they succeed

#### Scenario: Recovery after main moved

- **WHEN** a run failed and `main` has advanced since it was dispatched
- **THEN** a re-run fails in planning with an instruction to dispatch a new run
- **AND** the new run replaces any stale draft for its planned tag

### Requirement: Versions are recorded only as git tags and releases

The release process MUST NOT commit version bumps or changelog files and MUST
NOT publish to npm. Package manifests MUST stay at the baseline version.

#### Scenario: No commits are pushed

- **WHEN** a release completes
- **THEN** `main`'s head is unchanged and only the tag was added

### Requirement: Documented release runbook

`docs/RELEASING.md` MUST document the release stages, how to run `Release`,
that it is owner-only and `main`-only, the recovery steps for each failed
stage, and the owner-side settings that cannot live in the repository: the
`ghcr-publish` environment requires the owner's approval for every deployment
(release images and pull-request images alike).

#### Scenario: A maintainer can run and recover a release

- **WHEN** the owner follows the runbook
- **THEN** they can start a release, approve the image deployment, and recover
  from a failure in any stage
