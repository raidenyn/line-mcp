# docker-image-publishing Specification

## Purpose

Defines how the project publishes its two runnable Docker images to public
GitHub Container Registry: which images exist, which events publish them, how
they are tagged, how visibility is flipped once, how registry credentials and
owner approval work, and what users and maintainers are told.

## Requirements

### Requirement: Publish both runtime targets as public GHCR images

The publication workflow MUST publish the repository's two existing Docker
runtime targets, unmodified, as separate `linux/amd64` images in GitHub
Container Registry: the composed target `server` as
`ghcr.io/<owner>/line-mcp-full` and the standalone target `line-mcp` as
`ghcr.io/<owner>/line-mcp`. Both packages MUST be public, and an anonymous
`docker pull` MUST succeed. Published images MUST retain the `Dockerfile`'s
non-root runtime user, `/data` volume, and `HEALTHCHECK`.

#### Scenario: A release publishes both images

- **WHEN** the workflow publishes a release
- **THEN** `ghcr.io/<owner>/line-mcp-full` and `ghcr.io/<owner>/line-mcp` exist
  for that release, each built from its own target
- **AND** an unauthenticated `docker pull` succeeds
- **AND** each image starts and passes its `HEALTHCHECK`

#### Scenario: The composed and standalone images stay distinct

- **WHEN** either image is pulled
- **THEN** the composed image exposes the ten-tool surface
- **AND** the standalone image exposes only the five messenger tools

### Requirement: Record the owner's public-distribution risk acceptance

The repository MUST record that public container images are an approved
distribution form for the bundled LINE LTSM assets, as a dated owner risk
acceptance. Public npm publication MUST remain unapproved. The notice and
provenance files MUST NOT claim public images are forbidden.

#### Scenario: Policy files agree with publishing public images

- **WHEN** a reader checks `THIRD_PARTY_NOTICES.md`, `provenance.json`, or the
  README provenance policy
- **THEN** public container images are recorded as approved by the owner
- **AND** public npm publication remains listed as not approved

### Requirement: Publish manual previews only on request

Merging to `main` MUST NOT publish images. Only an explicit workflow dispatch
MAY publish a preview: an untagged dispatch from `refs/heads/main` MUST publish
`sha-<short>` and, when its commit is still `main`'s head, move `edge`.
`latest` MUST NOT be applied to a manual preview. Any manual dispatch, tagged
or untagged, MUST run from `refs/heads/main`.

#### Scenario: Merging does not publish

- **WHEN** a pull request is merged and a commit lands on `main`
- **THEN** the publication workflow does not start
- **AND** no image tag is created or moved

#### Scenario: Untagged manual dispatch rebuilds edge

- **WHEN** the workflow is dispatched without a tag from `main` at its current
  head
- **THEN** both images are published as `edge` and `sha-<short>`

#### Scenario: Manual dispatch from a branch is refused

- **WHEN** the workflow is dispatched, with or without a tag, from a
  non-`main` branch
- **THEN** the run fails before any image push

### Requirement: Publish release images from release events

The workflow MUST publish release images when it receives the
`release-published` repository dispatch, when a GitHub Release is published,
and when it is manually dispatched with a tag. Release builds MUST use the
source at that tag rather than the current `main` HEAD, and a manual dispatch
MUST run from `main`.

#### Scenario: The automated release dispatch publishes the released commit

- **WHEN** `release-published` arrives with `client_payload.tag` set to a
  release tag
- **THEN** the workflow builds the source at that tag
- **AND** publishes the release tag scheme for that tag

#### Scenario: A maintainer re-publishes a release manually

- **WHEN** the workflow is dispatched with a tag input from `main`
- **THEN** it publishes that tag's images as if the release dispatch had run

### Requirement: Reject unusable release requests

A release request MUST fail before publishing anything when the dispatch
carries no tag or when the tag is not `vX.Y.Z`.

#### Scenario: A malformed release dispatch publishes nothing

- **WHEN** `release-published` arrives without a usable tag
- **THEN** the workflow fails before any image push
- **AND** no tag is created or moved

### Requirement: Skip prereleases

A GitHub Release flagged as a prerelease MUST be skipped: the run succeeds
without pushing and without moving any tag.

#### Scenario: A prerelease is never published

- **WHEN** a GitHub Release is published with the prerelease flag set
- **THEN** the workflow succeeds without pushing images or moving `latest`

### Requirement: Release tag scheme

A release `vX.Y.Z` MUST publish the tag `X.Y.Z` and `sha-<short>` to both
images, and MUST publish `X.Y`, `latest`, and `X` only when that tag is the
newest stable release. `X` MUST NOT be published while the major version is
`0`. `latest`, `X.Y`, and `X` MUST NOT move backwards when an older release is
re-published. The newest-tag comparison MUST ignore prerelease suffixes.

#### Scenario: Release tags are complete for the newest release

- **WHEN** release `v1.4.2` is the newest release and is published
- **THEN** tags `1.4.2`, `1.4`, `1`, `latest`, and `sha-<short>` resolve to the
  same digest for both images

#### Scenario: Re-publishing an older release leaves moving tags alone

- **WHEN** release `v1.3.0` is published after `v1.4.2`
- **THEN** both images gain `1.3.0` and `sha-<short>`
- **AND** `latest`, `1.4`, `1.3`, and `1` are unchanged

#### Scenario: A zero-major release never publishes a bare major tag

- **WHEN** release `v0.2.0` is the newest release and is published
- **THEN** tags `0.2.0`, `0.2`, `latest`, and `sha-<short>` exist
- **AND** no `0` tag exists

#### Scenario: A release candidate does not block latest

- **WHEN** the newest remote tags are `v1.3.0-rc.1` and `v1.3.0`, and `v1.3.0`
  is published
- **THEN** `latest` moves to `v1.3.0`

### Requirement: Commit tags identify the built commit

The `sha-<short>` tag and the `org.opencontainers.image.revision` label MUST
identify the commit the image was built from, not the default-branch head.
Rebuilding the same commit may produce a different digest, so documentation
MUST present a digest reference as the immutable deployment pin.

#### Scenario: Re-publishing an old tag tags its own commit

- **WHEN** release `v1.2.0` is re-published while `main` has advanced
- **THEN** the published `sha-<short>` tag and revision label name the `v1.2.0`
  commit
- **AND** the `edge` image's `sha-<short>` tag is unchanged

### Requirement: Publish pull-request images only on request

The workflow MUST NOT publish for ordinary `pull_request` activity. It MAY
publish a pull request only when the `publish-docker` label is added, the pull
request's head repository is this repository, and the owner approves the
environment deployment. Fork-origin pull requests MUST be refused. A
pull-request build MUST be tagged `pr-<number>` and `sha-<short>` and MUST NOT
produce `latest`, `edge`, or release tags.

#### Scenario: A labeled same-repository PR publishes test images

- **WHEN** the `publish-docker` label is added to a same-repository pull request
- **THEN** the workflow builds that PR's head commit
- **AND** publishes `pr-<number>` and `sha-<short>` after owner approval
- **AND** no `latest`, `edge`, or release tag is created or moved

#### Scenario: Unlabeled PR activity publishes nothing

- **WHEN** a pull request is opened, updated, or receives any other label
- **THEN** the publication workflow does not publish

#### Scenario: A labeled fork PR is refused

- **WHEN** the `publish-docker` label is added to a pull request whose head
  repository is a fork
- **THEN** the workflow does not publish and reports that forks are unsupported

### Requirement: Owner approval gates every deployment

The publishing environment MUST require an owner approval before a deployment
proceeds. PR-triggered deployments MAY use the same environment, and the
approval remains required even though the images are public.

#### Scenario: Every publish waits for owner approval

- **WHEN** any publication job reaches the `ghcr-publish` environment
- **THEN** it waits for the required owner approval before running

### Requirement: Registry authentication uses the workflow token

The workflow MUST authenticate to GHCR with the built-in `GITHUB_TOKEN` under
the `packages: write` permission, alongside `contents: read`. It MUST NOT
depend on a personal access token, a stored registry secret, or
repository-wide package access grants.

#### Scenario: No personal token is required

- **WHEN** the publish job runs
- **THEN** it logs in with `GITHUB_TOKEN` and a `packages: write` permission
- **AND** the workflow references no personal access token or registry secret

### Requirement: Image metadata separates third-party licensing

Published images MUST carry `org.opencontainers.image.licenses=NOASSERTION`
alongside source and revision labels, so the repository's license is not
presented as covering the bundled LINE binaries.

#### Scenario: License metadata is explicit

- **WHEN** either image's labels are inspected
- **THEN** `org.opencontainers.image.licenses` is `NOASSERTION`
- **AND** source and revision labels are present

### Requirement: A pending release run is not cancelled

The publication workflow MUST allow more than one pending run in its
concurrency group, so a release publication waiting behind another publication
run is still published when a further run arrives.

#### Scenario: A later run does not evict a queued release

- **WHEN** a preview run is in progress and a release run is queued, then
  another publication run queues
- **THEN** the release run remains pending rather than being cancelled

### Requirement: Documented anonymous pull contract

`README.md` MUST document anonymous pull commands for both images, the tag
scheme, digest pinning, and the warning that making a package public cannot be
reversed.

#### Scenario: A reader can pull without authenticating

- **WHEN** a reader follows the README's Docker section
- **THEN** they find `docker pull` commands for both images with no login step
- **AND** the meaning of `latest`, `edge`, semver, and `sha-<short>` tags, a
  digest-pinning example, and the irreversible-visibility warning

### Requirement: Documented first-publication and release runbook

`docs/RELEASING.md` MUST document the first-publication sequence (the first
push creates private packages; only the owner changes visibility to public,
irreversibly), anonymous verification, automatic publication, manual
re-publication from `main`, the manual-dispatch fallbacks, and the owner
approval required for every deployment. `docs/ARCHITECTURE.md` MUST describe
the publication workflow and its `GITHUB_TOKEN` authentication.

#### Scenario: A maintainer can publish deliberately

- **WHEN** a maintainer follows the runbook
- **THEN** they can make both packages public once, publish a release
  automatically, republish a chosen tag from `main`, and know that public
  visibility cannot be undone
