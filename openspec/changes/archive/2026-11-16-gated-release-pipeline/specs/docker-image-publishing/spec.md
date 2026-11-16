## ADDED Requirements

### Requirement: Publication starts only from Release or a labeled pull request

The `Publish Docker` workflow MUST define exactly two triggers: `workflow_call`
(from the `Release` workflow) and `pull_request` of type `labeled`. It MUST NOT
define a push, `repository_dispatch`, `release`, or `workflow_dispatch` trigger.
A call MUST fail before any image push unless the caller's workflow ref is
`.github/workflows/release.yml` dispatched on `refs/heads/main`.

#### Scenario: Merging and manual runs publish nothing

- **WHEN** a pull request is merged, a release is published by hand, or a user
  tries to run `Publish Docker` directly
- **THEN** no image is built or pushed

#### Scenario: The Release workflow publishes images

- **WHEN** `Release` calls `Publish Docker` with a `vX.Y.Z` tag
- **THEN** both images are built and pushed with the release tag scheme

#### Scenario: A foreign caller is refused

- **WHEN** a workflow other than `release.yml` (even one named `Release`), or
  `release.yml` from another ref, calls it
- **THEN** it fails before any image push

### Requirement: Build the planned commit before its git tag exists

Release builds MUST use the commit planned by `Release` (the caller's commit),
not a tag lookup, because the git tag is created only after the images are
published. The built commit MUST be verified after checkout.

#### Scenario: Images are built from the planned commit

- **WHEN** `Publish Docker` runs for a release whose tag does not yet exist
- **THEN** both images are built from the planned commit
- **AND** the checked-out `HEAD` equals that commit

## MODIFIED Requirements

### Requirement: Reject unusable release requests

A publication call MUST fail before publishing anything when it carries no tag
or when the tag is not `vX.Y.Z`.

#### Scenario: A malformed release dispatch publishes nothing

- **WHEN** `Publish Docker` is called without a usable tag
- **THEN** the workflow fails before any image push
- **AND** no tag is created or moved

### Requirement: Release tag scheme

A release `vX.Y.Z` MUST publish the tag `X.Y.Z` and `sha-<short>` to both
images, and MUST publish `X.Y`, `latest`, and `X` only when that version is the
newest stable release. Newness MUST be judged against the remote's stable tags
together with the version being released, because its own tag does not yet
exist. `X` MUST NOT be published while the major version is `0`. `latest`,
`X.Y`, and `X` MUST NOT move backwards. The newest-tag comparison MUST ignore
prerelease suffixes. A release build MUST fail before any image push if any of
its computed tags starts with `pr-`.

#### Scenario: Release tags are complete for the newest release

- **WHEN** release `v1.4.2` is newer than every existing stable tag and is published
- **THEN** tags `1.4.2`, `1.4`, `1`, `latest`, and `sha-<short>` resolve to the
  same digest for both images

#### Scenario: A zero-major release never publishes a bare major tag

- **WHEN** release `v0.2.0` is the newest release and is published
- **THEN** tags `0.2.0`, `0.2`, `latest`, and `sha-<short>` exist
- **AND** no `0` tag exists

#### Scenario: A release candidate does not block latest

- **WHEN** the newest remote tags are `v1.3.0-rc.1` and `v1.3.0` is released
- **THEN** `latest` moves to `v1.3.0`

#### Scenario: Re-publishing an older release leaves moving tags alone

- **WHEN** the version being released is lower than an existing stable tag
  (for example `v1.3.0` after `v1.4.2`)
- **THEN** both images gain `1.3.0` and `sha-<short>`
- **AND** `latest`, `1.4`, `1.3`, and `1` are unchanged

#### Scenario: A release build never pushes a pull-request tag

- **WHEN** a release build's computed tags include a tag starting with `pr-`
- **THEN** the workflow fails before any image push

### Requirement: Commit tags identify the built commit

The `sha-<short>` tag and the `org.opencontainers.image.revision` label MUST
identify the planned release commit. Rebuilding the same commit may produce a
different digest, so documentation MUST present a digest reference as the
immutable deployment pin.

#### Scenario: Re-publishing an old tag tags its own commit

- **WHEN** release `v1.2.0` is built from planned commit `abc1234…` while
  `main` has since advanced
- **THEN** the published `sha-abc1234` tag and revision label name the planned
  commit, not `main`'s head

### Requirement: Publish pull-request images only on request

The workflow MUST NOT publish for ordinary `pull_request` activity. It MAY
publish a pull request only when the `publish-docker` label is added, the pull
request's head repository is this repository, and the owner approves the
environment deployment. Fork-origin pull requests MUST be refused. A
pull-request build MUST push only the tags `pr-<number>` and `sha-<short>`, and
MUST verify before pushing that every tag matches
`^(pr-[0-9]+|sha-[0-9a-f]{7})$`. It MUST NOT create or move `latest`, `X.Y`,
`X`, `X.Y.Z`, or any other tag.

#### Scenario: A labeled same-repository PR publishes test images

- **WHEN** the `publish-docker` label is added to a same-repository pull request
- **THEN** the workflow builds that PR's head commit
- **AND** publishes `pr-<number>` and `sha-<short>` after owner approval
- **AND** no `latest`, `X.Y`, `X`, or version tag is created or moved

#### Scenario: Unlabeled PR activity publishes nothing

- **WHEN** a pull request is opened, updated, or receives any other label
- **THEN** the publication workflow does not publish

#### Scenario: A labeled fork PR is refused

- **WHEN** the `publish-docker` label is added to a pull request whose head
  repository is a fork
- **THEN** the workflow does not publish and reports that forks are unsupported

#### Scenario: A tag outside the allowlist fails the build

- **WHEN** a pull-request build's computed tags include any tag that does not
  match `^(pr-[0-9]+|sha-[0-9a-f]{7})$`
- **THEN** the workflow fails before any image push

### Requirement: Owner approval gates every deployment

The publishing environment MUST require an owner approval before a deployment
proceeds, for release and pull-request deployments alike, and MUST permit
deployments from `main` and from same-repository pull-request refs. The
approval, not the ref filter, is the trust boundary and remains required even
though the images are public.

#### Scenario: Every publish waits for owner approval

- **WHEN** the image publication job reaches the `ghcr-publish` environment
- **THEN** it waits for the required owner approval before running

### Requirement: A pending release run is not cancelled

The publication workflow MUST allow more than one pending run in its
concurrency group, so a release publication called by `Release` and waiting
behind another publication run is still published when a further run arrives.
Its concurrency group MUST differ from the `Release` workflow's group, so the
called workflow never waits on its own caller.

#### Scenario: A later run does not evict a queued release

- **WHEN** a pull-request run is in progress and a release run is queued, then
  another pull-request run queues
- **THEN** the release run remains pending rather than being cancelled

### Requirement: Documented anonymous pull contract

`README.md` MUST document anonymous pull commands for both images, the tag
scheme (semver, `X.Y`, `X`, `latest`, `sha-<short>`), digest pinning, and the
warning that making a package public cannot be reversed. It MUST describe
`pr-<number>` images as test builds that never carry release tags, and MUST NOT
document `edge`.

#### Scenario: A reader can pull without authenticating

- **WHEN** a reader follows the README's Docker section
- **THEN** they find `docker pull` commands for both images with no login step
- **AND** the meaning of `latest`, semver, and `sha-<short>` tags, a
  digest-pinning example, and the irreversible-visibility warning
- **AND** `pr-<number>` described as a test-only tag, and no mention of `edge`

### Requirement: Documented first-publication and release runbook

`docs/RELEASING.md` MUST document that the first image publication is the
first `Release` run (or labeled pull-request build, if that comes first) after
the pipeline lands (the first push creates private packages; only the owner
changes visibility to public, irreversibly),
anonymous verification, the owner approval required for every deployment, that
release images are published only through `Release`, and that the
`publish-docker` label publishes only `pr-<number>` and `sha-<short>` tags.
`docs/ARCHITECTURE.md` MUST
describe the release pipeline, the reusable publication workflow, and its
`GITHUB_TOKEN` authentication.

#### Scenario: A maintainer can publish deliberately

- **WHEN** a maintainer follows the runbook
- **THEN** they can run a release, publish a labeled PR image, approve either
  deployment, make both packages public once, and know that public visibility
  cannot be undone

## REMOVED Requirements

### Requirement: Publish manual previews only on request

**Reason**: `edge` and `sha-<short>` preview builds from a manual dispatch would
publish moving tags without release notes; the only non-release publication
left is the labeled pull-request build with `pr-`/`sha-` tags.

**Migration**: Publish a new release, or label a pull request. Existing `edge`
tags on GHCR are left for the owner to delete by hand; "Merging does not
publish" is preserved by "Publication starts only from Release or a labeled
pull request".

### Requirement: Publish release images from release events

**Reason**: Releases are no longer announced by a `repository_dispatch`, a
published-release event, or a manual tagged dispatch; `Release` calls
`Publish Docker` directly before the release is public.

**Migration**: Run `Release`; a broken image is fixed by a new release rather
than a re-publish of an old tag.

### Requirement: Skip prereleases

**Reason**: `Release` produces only stable releases from `main`, and
`Publish Docker` no longer reacts to GitHub Release events.

**Migration**: None; a prerelease flow, if ever needed, is a new change.

