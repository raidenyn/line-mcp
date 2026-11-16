## Design Summary

Publish both Docker runtime targets to GitHub Container Registry as **public**
packages:

| Target     | Tools | Image                            |
| ---------- | ----- | -------------------------------- |
| `server`   | ten   | `ghcr.io/raidenyn/line-mcp-full` |
| `line-mcp` | five  | `ghcr.io/raidenyn/line-mcp`      |

On 2026-11-16 the owner accepted the LINE LTSM redistribution risk permanently.
GitHub cannot make a public package private again, so the visibility flip is a
one-way, owner-only action after the code lands, never a workflow side effect.

### Triggers

| Event                                       | Published tags                                 |
| ------------------------------------------- | ---------------------------------------------- |
| `workflow_dispatch` (optional tag, from main)| semver tags when tagged; `edge` + `sha` when untagged |
| `repository_dispatch: [release-published]`  | `X.Y.Z`, `sha`, plus moving tags if newest     |
| `release: [published]`                      | same as the dispatch                           |
| `pull_request: [labeled]` `publish-docker`  | `pr-<number>` + `sha-<short>` (same repo only) |

Prereleases are skipped and PR images never receive `latest`, `edge`, or release
tags.

### Build and credentials

- `prepare` resolves the ref, commit, newest-release/edge flags, and PR number;
  the matrix builds both targets on `linux/amd64`.
- Registry auth is `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}` with
  `packages: write` and `contents: read`; no PAT, no stored registry secret.
- The publish job still runs in `ghcr-publish`, which requires owner approval on
  every deployment. It no longer protects confidentiality; it prevents
  accidental or malicious publishes.
- Cache is `type=registry` inside the packages (`:buildcache`); `type=gha` is
  not used.
- Every image carries `org.opencontainers.image.licenses=NOASSERTION` plus
  source and revision labels.

### Verification and documentation

- The YAML contract test covers triggers, permissions, token use, tag gating,
  PR refusal rules, cache type, and labels; a behavioural harness runs the
  resolver against a fake git.
- README documents anonymous pulls, tags, digest pinning, and the irreversible
  visibility warning. `docs/RELEASING.md` documents the one-time public flip and
  the approval-gated release/republish flow. Policy files record the owner's
  dated acceptance; public npm stays forbidden.

## Alternatives Considered

### Alternative A: Keep private GHCR (previous design)

- **Approach**: Private packages, PAT in an environment, placeholder bootstrap,
  inheritance disabled.
- **Pros**: No new public distribution; strongest confidentiality.
- **Cons**: Requires a rotating PAT and a multi-step bootstrap; anonymous pull
  is impossible; the owner has now accepted the risk and wants public pulls.
- **Why not chosen**: Superseded by the owner's decision; the private machinery
  exists only to prevent an exposure the owner has accepted.

### Alternative B: Public GHCR with the built-in token (chosen)

- **Approach**: Public packages, `GITHUB_TOKEN` with `packages: write`, approval
  environment retained, policy files amended.
- **Pros**: Anonymous pulls, no PAT rotation, no bootstrap/inheritance steps,
  fewer secret-related failure modes.
- **Cons**: Irreversible visibility; anyone can mirror the images; requires
  policy and metadata changes.
- **Why not chosen**: Not applicable — chosen.

### Alternative C: Public images plus a Docker Hub mirror

- **Approach**: Public GHCR, mirrored to Docker Hub.
- **Pros**: More discoverable.
- **Cons**: A second public copy to manage, extra credentials, and the same
  irreversibility, with no user benefit over GHCR.
- **Why not chosen**: YAGNI; anyone can mirror once GHCR is public.

### Alternative D: Publish to a public registry other than GHCR

- **Approach**: Docker Hub or Quay as primary.
- **Pros**: Familiar pull paths.
- **Cons**: Extra account, token, and quota; no co-location with the repository.
- **Why not chosen**: GHCR is already integrated and needs no extra credential.

## Agreed Approach

Alternative B: public GHCR packages with built-in token authentication, approval
retained, private-package bootstrap and PAT removed, policy and licensing
metadata updated, and the irreversible flip left to the owner.

## Key Decisions

- Public GHCR only; no Docker Hub.
- `GITHUB_TOKEN` + `packages: write`; no `GHCR_PUBLISH_TOKEN`, no
  `GHCR_PACKAGES_PRIVATE` gate.
- Owner approval remains on `ghcr-publish` for every PR and release deployment.
- First push creates private packages; the owner flips them public once,
  irreversibly; the workflow never changes visibility.
- Keep triggers, tag gating, PR label path, fork refusal, and `queue: max`.
- Keep `type=registry` cache; never `type=gha`.
- Add `org.opencontainers.image.licenses=NOASSERTION`.
- Amend THIRD_PARTY_NOTICES, provenance.json, README, CLAUDE.md, RELEASING, and
  ARCHITECTURE in the same change.

## Open Questions

- Whether arm64 demand justifies native arm runners later.
