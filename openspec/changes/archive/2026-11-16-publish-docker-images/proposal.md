## Why

Deployments currently rebuild from source, with no anonymous, pinnable artifact.
On 2026-11-16 the owner accepted the LINE LTSM redistribution risk permanently,
so both GHCR packages can be public and `docker pull` can become the install
path. Public images also let registry authentication use the built-in
`GITHUB_TOKEN` instead of a rotating personal token, simplifying the workflow.
The release workflow already emits `release-published` for this consumer.

## What Changes

**Registry visibility and authentication**
- From: private packages, a `GHCR_PUBLISH_TOKEN` environment secret, a
  `GHCR_PACKAGES_PRIVATE` gate, and a placeholder/inheritance bootstrap.
- To: public packages with anonymous pulls, registry login with `GITHUB_TOKEN`
  and `packages: write`, no PAT, no gate, no bootstrap.
- Reason: the owner's risk acceptance makes confidentiality unnecessary, and the
  built-in token removes secret rotation and repository-access grants.
- Impact: non-breaking, additive; anonymous users gain pull access by design.

**Distribution policy**
- From: Docker images approved for internal use only; public package indexes
  forbidden.
- To: public container images approved by dated owner risk acceptance; public
  npm publication still forbidden; provenance and notice files updated, including
  the stale "private/internal repository" description.
- Reason: the written policy must match the decision, and the irreversibility of
  a public GHCR package must be recorded before anyone flips it.
- Impact: licensing-policy change, accepted permanently by the owner.

**Image metadata**
- From: generated OCI labels only.
- To: `org.opencontainers.image.licenses=NOASSERTION` plus source and revision,
  so the repository license is not presented as covering LINE's binaries.

**Kept as designed**
- Triggers and tags: release semver gated on the newest stable tag, an untagged
  manual dispatch producing `edge` + `sha`, labeled same-repository PRs producing
  `pr-<number>` + `sha`, prereleases skipped, manual dispatch from `main`, and no
  publication from a merge.
- Owner approval on the `ghcr-publish` environment for every deployment.
- `type=registry` cache inside the packages; `linux/amd64`; no Docker Hub.

## Capabilities

### New Capabilities

- `docker-image-publishing`: which images are published, where, when, how they
  are tagged, how visibility is flipped once, how credentials work, and what
  users and maintainers are told.

### Modified Capabilities

None. `openspec/specs/` is empty.

## Impact

- New: `.github/workflows/publish-docker.yml`, `tests/release/docker-publish-workflow.test.ts`.
- Modified: `README.md`, `docs/RELEASING.md`, `docs/ARCHITECTURE.md`,
  `CLAUDE.md`, `packages/line-client/THIRD_PARTY_NOTICES.md`,
  `packages/line-client/assets/ltsm/provenance.json`,
  `tests/release/release-documentation.test.ts`.
- Unchanged: `Dockerfile`, `docker-compose.yml`, `ci.yml`, `release.yml`,
  package manifests, and runtime code.
- External prerequisites: none for authentication; the owner performs the
  one-time, irreversible visibility flip after the first push.
