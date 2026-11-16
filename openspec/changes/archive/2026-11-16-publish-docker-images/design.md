## Context

The repository ships one multi-stage `Dockerfile` with two runtime targets —
`server` (composed ten-tool server) and `line-mcp` (standalone five-tool
server) — and `ci.yml` already builds and smokes both. Release automation emits
a `repository_dispatch` named `release-published` with the release tag, which
is the dependable release trigger because `GITHUB_TOKEN`-created tags do not
reliably fire `push: tags`.

Every image contains LINE Corporation's proprietary `ltsm.wasm` and
`ltsmSandbox.js`. The repository is public and already ships those binaries; the
provenance files previously approved Docker images only for internal use and
forbade public package indexes. On 2026-11-16 the owner recorded a permanent
risk acceptance for public container images. That decision is the basis for this
design: public images are now the intended distribution form, public npm
remains forbidden, and the policy files must say exactly that.

GitHub also documents that making a container package public is **irreversible**:
a public package cannot be made private again. The design must therefore treat
the visibility flip as a deliberate, one-way owner action performed after the
code lands, not as a side effect of the workflow.

Other constraints: `better-sqlite3`'s native addon is built in the builder stage
(so `linux/amd64` only for now); the repository is on the `0.x` line (no bare
`X` tag); workflow behavior is pinned by YAML-parsing tests; `docs/ARCHITECTURE.md`
has a maintenance rule for Docker-related changes.

## Goals / Non-Goals

**Goals:**

- Publish both targets to GHCR as public packages with anonymous `docker pull`.
- Use the built-in `GITHUB_TOKEN` (`packages: write`) instead of a stored PAT.
- Keep the owner-approval environment for both PR and release deployments.
- Keep commit-correct `sha-` tags, forward-only moving tags, and labeled PR
  publishing.
- Record the risk acceptance in the policy files and document the irreversible
  visibility flip.

**Non-Goals:**

- Public npm publication (still forbidden).
- Docker Hub or any second registry.
- `Dockerfile`, compose, or package changes; arm64; attestations/SBOM; signing.
- Changing package visibility automatically; the workflow never flips it.

## Decisions

### Public GHCR packages, no second registry

Images remain `ghcr.io/<owner>/line-mcp-full` and
`ghcr.io/<owner>/line-mcp`, but public with anonymous pull. Docker Hub is not
used. A mirror can still be created by anyone once images are public; that is an
accepted consequence of the owner's decision, not a feature of this change.

### Built-in token instead of a stored PAT

The publish job authenticates with `${{ github.actor }}` /
`${{ secrets.GITHUB_TOKEN }}` and `packages: write`, alongside `contents: read`.
Fork-read concerns disappear because the packages are public, and no rotating
personal token is needed. The workflow must not reference `GHCR_PUBLISH_TOKEN`
or any registry secret.

The `ghcr-publish` environment stays on the publish job with a required owner
review. It no longer protects confidentiality; it prevents an accidental or
malicious PR/release publish without a human decision. PR-modifiable workflows
in same-repository PRs make that approval the trust boundary.

### First publication is a deliberate two-step

The first successful release (or manual preview) publication creates both
packages, which GitHub creates private by default; merging to `main` publishes
nothing. The owner then opens each package's settings and changes visibility to
public, confirming the irreversible action. Only after that do anonymous pulls
and release publishing make sense. The workflow never changes visibility and
never fails merely because a package is still private; the runbook records the
order.

### Tags, triggers, and PR path

- Merging to `main` publishes nothing; there is no `push` trigger.
- `release-published`, published Release, manual tag → `X.Y.Z` and `sha-<short>`;
  `X.Y`/`X`/`latest` only for the newest stable tag; no `X` on `0.x`.
- An untagged manual dispatch from `main` → `edge` (while main head) +
  `sha-<short>`; this is the only producer of `edge`.
- Labeled same-repository PR → `pr-<number>` + `sha-<short>`; fork PRs refused;
  unlabeled PR activity publishes nothing; re-add the label to republish.
- Prereleases skipped; manual dispatch from `main` only; `queue: max`.

### Registry cache stays inside the packages

`type=registry` cache tags (`:buildcache`) remain because they need
authentication and keep layers alongside the images. With public packages those
cache layers are public too; that is consistent with the owner's decision.
`type=gha` remains forbidden: it would distribute layers through a channel the
project does not control, and fork workflows can restore it.

### Image metadata marks third-party licensing

All metadata steps add `org.opencontainers.image.licenses=NOASSERTION` beside
source and revision. The repository license must not appear to cover LINE's
binaries.

### Policy files carry the dated owner acceptance

`THIRD_PARTY_NOTICES.md`, `provenance.json`, README, and CLAUDE.md are amended in
the same change: public container images approved by the owner on 2026-11-16;
public npm still explicitly not approved. The contradiction where
`provenance.json` called the public repository "private/internal" is corrected.

## Risks / Trade-offs

- **Visibility is irreversible** → the flip is a documented owner-only step
  after merge; the workflow never performs it; the README and runbook state it.
- **Mirroring and redistribution at scale** → accepted by the owner. The images
  carry `NOASSERTION` licensing and links to the notices.
- **A takedown or negative review later** → cannot be undone for GHCR packages;
  the repository can stop publishing and delete the packages, but public copies
  persist. This is the accepted cost of the decision.
- **Public cache layers** → `:buildcache` tags become public with the packages;
  no additional exposure beyond the images themselves.
- **A public repository's token pushing packages** → no longer a confidentiality
  issue; the approval environment still gats abuse.
- **First push leaves packages private until the flip** → documented order;
  anonymous pulls fail until the owner completes it.
- **Moving-tag eligibility is a start-time snapshot** → serialization prevents
  backwards movement; a long approval wait can publish the tags selected when
  the run started.
- **0.x major tag** → never emitted.

## Migration Plan

1. Merge the amended workflow, tests, docs, and policy files (visibility still
   private; the merge publishes nothing).
2. The first release dispatch or manual preview publishes into newly created
   private packages.
3. The owner changes both packages to public, confirming the irreversible
   action.
4. Verify anonymous pulls and anonymous `healthz`/tools behavior, then publish
   the next release.
5. To test PR publishing, label a same-repository PR `publish-docker` and
   approve the deployment.

## Open Questions

- Whether arm64 demand justifies native arm runners later.
