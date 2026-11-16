# Implementation tasks

> Status note (2026-11-16): groups 1–5 describe the private-GHCR design that
> groups 7–8 superseded; they are marked complete because they were implemented
> and reviewed before the owner's public-image decision. Group 0 (private
> bootstrap) was never executed, and 6.4 (actionlint) was attempted but the
> tool rejects `queue: max`, so both remain open.

## 0. Bootstrap the private packages (maintainer-only, before merge)

- [ ] 0.1 `[maintainer]` Check both package names with `gh api /users/raidenyn/packages/container/<name>`; stop if either exists and is public, because GHCR cannot make a public package private again.
- [ ] 0.2 `[maintainer]` Push an asset-free placeholder (`printf 'FROM scratch\n' | docker build --label org.opencontainers.image.source=https://github.com/raidenyn/line-mcp -t ghcr.io/raidenyn/<image>:bootstrap -`) to each package. The label links the package; nothing proprietary is uploaded.
- [ ] 0.3 `[maintainer]` In each linked package, set Private visibility and untick "Inherit access from source repository". Do not grant `raidenyn/line-mcp` Actions package access.
- [ ] 0.4 `[maintainer]` Confirm an unrelated account is denied a pull; create the `ghcr-publish` environment restricted to `main` and `v*`, and store the classic `write:packages` PAT as `GHCR_PUBLISH_TOKEN` in it.
- [ ] 0.5 `[maintainer]` Run `gh variable set GHCR_PACKAGES_PRIVATE --body true`. The agent must hand off here and must not run this command.
- [ ] 0.6 `[maintainer]` After the first automatic `edge` push, re-check inheritance and the denial (including a fork-origin credential path), then delete only the placeholder versions. Never delete a package; if one is deleted, unset the variable, stop any run that could republish, and redo.
- [ ] 0.7 Record the bootstrap in `docs/RELEASING.md` under `### GHCR Private-Package Bootstrap`.

## 1. Scaffold the publish workflow

- [x] 1.1 Create `.github/workflows/publish-docker.yml` with the four triggers (`push` to `main`, `repository_dispatch: [release-published]`, `release: [published]`, `workflow_dispatch` with an optional `tag` input) and no `pull_request` trigger.
- [x] 1.2 Set workflow-level `permissions` to `contents: read` only (the registry uses a separate environment token), and a `publish-docker` concurrency group with `cancel-in-progress: false` and `queue: max` (the default single-slot queue would evict a pending release run).
- [x] 1.3 State in the file header that only GHCR is published and the packages exist as private, bootstrapped packages.

## 2. Resolve publication inputs

- [x] 2.1 Add a `prepare` job (job permissions `contents: read`) whose `resolve` step reads `EVENT_NAME`, `REF`, `SHA`, `DISPATCH_TAG`, `DISPATCH_PAYLOAD` (via `toJSON`), `RELEASE_TAG`, `RELEASE_PRERELEASE`, `INPUT_TAG`, and `GHCR_PACKAGES_PRIVATE`, and writes its answers to `GITHUB_OUTPUT`. No registry credentials belong in this job.
- [x] 2.2 Handle a prerelease first: when the event is `release` and `RELEASE_PRERELEASE=true`, emit `publish=false` with `latest=false` and an empty `tag`, then exit successfully before any validation.
- [x] 2.3 Refuse to continue unless `GHCR_PACKAGES_PRIVATE` is `true`, with an error pointing at the `docs/RELEASING.md` bootstrap.
- [x] 2.4 Select the tag by event (`repository_dispatch` → payload tag, `release` → release tag, `workflow_dispatch` → input), fail a dispatch that carries no tag, and reject any tag that does not match the bash regex `^v[0-9]+\.[0-9]+\.[0-9]+$`.
- [x] 2.5 Fail any `workflow_dispatch`, tagged or untagged, unless `REF` is `refs/heads/main`.
- [x] 2.6 Resolve the commit from the tag (`git ls-remote` peeled `refs/tags/<tag>^{}` then `refs/tags/<tag>`) or use `GITHUB_SHA` for untagged runs; emit `sha` and 7-character `short_sha`.
- [x] 2.7 Emit `latest=true` only when the tag equals the highest stable remote `v*` tag: capture the listing first so a failed `git ls-remote` fails the run, filter lines with `^v[0-9]+\.[0-9]+\.[0-9]+$` under `|| true`, then `sort -V | tail -n1`. Emit `major` parsed from the tag (empty for untagged runs).
- [x] 2.8 Emit `edge=true` for any run without a tag whose commit equals the remote `refs/heads/main` head — pushes and untagged manual dispatches alike — so a queued or stale run cannot move `edge` backwards.
- [x] 2.9 Emit `ref` as `refs/tags/<tag>` when a tag exists, otherwise the resolved commit, and expose `ref`, `tag`, `publish`, `latest`, `edge`, `sha`, `short_sha`, and `major` as job outputs.

## 3. Publish to GHCR

- [x] 3.1 Add a `publish` job with `runs-on: ubuntu-latest`, `environment: ghcr-publish`, gated on `needs.prepare.outputs.publish == 'true'`, with a matrix mapping `target: server → image: line-mcp-full` and `target: line-mcp → image: line-mcp`, `fail-fast: false`.
- [x] 3.2 Check out `needs.prepare.outputs.ref`, assert `git rev-parse HEAD` equals `needs.prepare.outputs.sha`, configure `docker/setup-buildx-action`, and log in to `ghcr.io` with `github.repository_owner` and `secrets.GHCR_PUBLISH_TOKEN` — never `secrets.GITHUB_TOKEN`.
- [x] 3.3 Add `meta-release` (when a tag exists) with `flavor: latest=false` and tags: `type=semver,pattern={{version}}`; `type=semver,pattern={{major}}.{{minor}}` gated on `latest == 'true'`; `type=semver,pattern={{major}}` gated on `latest == 'true'` and `major != '0'`; `type=raw,value=latest` gated on `latest == 'true'`; and `type=raw,value=sha-<short_sha>`.
- [x] 3.4 Add `meta-edge` (when no tag exists) with `flavor: latest=false` and tags `type=raw,value=edge,enable=<edge == 'true'>` plus `type=raw,value=sha-<short_sha>`.
- [x] 3.5 Add `org.opencontainers.image.revision=${{ needs.prepare.outputs.sha }}` to both metadata steps' `labels` so the revision label names the built commit, and never use `type=sha`.
- [x] 3.6 Build and push with `docker/build-push-action`: `context: .`, `target: <matrix.target>`, `platforms: linux/amd64`, `push: true`, `provenance: false`, `sbom: false`, `cache-from`/`cache-to` of `type=registry,ref=ghcr.io/<owner>/<image>:buildcache` (with `mode=max` on the write), and tags/labels selected with `steps.meta-release.outputs.* || steps.meta-edge.outputs.*`.

## 4. Contract tests

- [x] 4.1 Add `tests/release/docker-publish-workflow.test.ts` parsing the YAML like `tests/release/release-workflow.test.ts`, plus a behavioural harness that runs the `resolve` step's `run` script with a fake `git` on `PATH` and a temporary `GITHUB_OUTPUT`. Merge imports with Task 1's `node:fs` import rather than redeclaring them.
- [x] 4.2 Assert the trigger set, the absence of `pull_request`, workflow permissions, `concurrency` including `queue: max` and `cancel-in-progress: false`, and the `prepare` repository guard (`github.repository == 'raidenyn/line-mcp'`).
- [x] 4.3 Cover the resolve cases: prerelease with a malformed tag exits 0 with `publish=false`; `GHCR_PACKAGES_PRIVATE` unset fails with a bootstrap message; a dispatch without a tag fails; `v1.2` fails; tagged and untagged dispatch off `main` fail; an annotated tag uses the peeled commit (the direct lookup returns a different tag-object SHA); a lightweight tag falls back; a tag missing from the remote fails; a failed tag listing fails the run; a newer release makes `latest=false`; `v1.3.0` beats `v1.3.0-rc.1`; `v0.2.0` emits `major=0`; a stale push emits `edge=false`; a current push emits `edge=true`; an untagged dispatch at the head emits `edge=true` and at a stale head `edge=false`.
- [x] 4.4 Assert `prepare` exposes `ref`/`tag`/`publish`/`latest`/`edge`/`sha`/`short_sha`/`major`, and that the payload is passed through `toJSON` in `env`.
- [x] 4.5 Assert `latest` and the `X.Y`/`X` tags are gated, that `major != '0'` guards the bare major tag, that `edge` is gated on `needs.prepare.outputs.edge`, that both metadata steps set `flavor: latest=false`, and that no `type=sha` appears.
- [x] 4.6 Assert the revision label, the checkout ref, the commit verification step, the matrix mapping, `environment: ghcr-publish`, the `GHCR_PUBLISH_TOKEN` login with no registry use of `secrets.GITHUB_TOKEN`, `platforms: linux/amd64`, `push: true`, `provenance: false`, `sbom: false`, per-image private registry cache refs (and no `type=gha`), and the build-step `labels` selection.
- [x] 4.7 Assert the workflow never logs in to `docker.io` and registers no second registry.
- [x] 4.8 Extend `tests/release/release-documentation.test.ts` with distinctive assertions: README `docker login ghcr.io`, exact `ghcr.io/raidenyn/line-mcp-full:`/`ghcr.io/raidenyn/line-mcp:` refs, `@sha256:`, `` `sha-<short>` ``, "must stay private", "must grant access"; runbook `## Docker Images`, `### GHCR Private-Package Bootstrap`, `GHCR_PACKAGES_PRIVATE`, `GHCR_PUBLISH_TOKEN`, `ghcr-publish`, `Inherit access`, `org.opencontainers.image.source`, `Publish Docker`, "must stay private", `read:packages`, `released`; architecture `publish-docker.yml` and `ghcr.io`.

## 5. Documentation

- [x] 5.1 Update `README.md`'s Docker section: `docker login ghcr.io` with a `read:packages` token, pull commands for `line-mcp-full` and `line-mcp`, two `docker run` examples with separate volumes and ports (`bank-mcp-data` on 3000, `line-mcp-data` on 3100) plus the never-share-a-data-root warning, the tag table (`latest`, `X.Y.Z`, `X.Y`, `X`, `edge`, `sha-<short>`), and digest pinning.
- [x] 5.2 State in `README.md` that the packages must stay private because the images bundle LINE's proprietary LTSM assets, that the maintainer must grant access, and link `THIRD_PARTY_NOTICES.md` and `provenance.json`.
- [x] 5.3 Update `docs/RELEASING.md` with a `## Docker Images` section and a `### GHCR Private-Package Bootstrap` subsection: existing-public-package pre-check, asset-free placeholder push with the source label (linking first, no LTSM uploaded), Private visibility, no inherited access, no repository Actions access, linked-state denial check, the `ghcr-publish` environment restricted to `main`/`v*` with `GHCR_PUBLISH_TOKEN`, `GHCR_PACKAGES_PRIVATE=true` set by the maintainer, keep the placeholder versions until after the first `edge` push and its access re-check (including a fork-origin credential path), never delete a package; then automatic publication from `release-published`, manual `workflow_dispatch` re-publish from `main`, the bare-tag-push, pre-workflow-tag, and prerelease-promotion (`released`, stable tags only) fallbacks, the "re-run the whole workflow" rule, the private-visibility rule, and that publishing an older tag does not move `latest`. Name the workflow `Publish Docker`.
- [x] 5.4 Add the publishing workflow to `docs/ARCHITECTURE.md` (with the literal `ghcr.io` image names) and `README.md`'s CI/workflow list.
- [x] 5.5 Keep `THIRD_PARTY_NOTICES.md`, `provenance.json`, and the README policy line unchanged; public distribution remains out of scope pending issue #75.

## 6. Verification

- [x] 6.1 Run `npm run lint && npm run build && npm run test:unit && npm run test:smoke`.
- [x] 6.2 Run `npx vitest run tests/release/docker-publish-workflow.test.ts tests/release/release-documentation.test.ts tests/release/release-workflow.test.ts`.
- [x] 6.3 Run `npx vitest run tests/docker/docker-smoke.test.ts` to confirm the images the workflow publishes still pass the health and tool-surface checks.
- [ ] 6.4 Lint the workflow YAML (e.g. `actionlint` if available; accept that it may not know `queue: max` yet) and record in the PR what only post-merge verification can prove: the actual GHCR push, the first release-tag publication, and that after the first `edge` push inheritance is still off and both an unrelated account and a fork-origin credential path are denied.

## 7. PR-triggered publishing

- [x] 7.1 Add `pull_request: types: [labeled]` to the workflow triggers; no other PR activity may publish.
- [x] 7.2 Extend `prepare` to output `pr`: on a `publish-docker` label event for a same-repository head, set `publish=true`, `pr=<number>`, `ref=<head sha>`, `sha=<head sha>`, `latest=false`, `edge=false`; on any other PR event or a fork head, set `publish=false` with a diagnostic.
- [x] 7.3 Add a `meta-pr` metadata step (when `pr` is set) with `flavor: latest=false`, tags `type=raw,value=pr-<pr>` and `type=raw,value=sha-<short_sha>`, and the revision label; never `latest`, `edge`, or semver tags.
- [x] 7.4 Select build tags/labels with `meta-release || meta-edge || meta-pr`, and keep the checkout/HEAD verification on the PR head.
- [x] 7.5 Cover the path in `tests/release/docker-publish-workflow.test.ts`: trigger includes `pull_request: [labeled]`; labeled same-repo PR publishes `pr-N` + `sha` and no moving tags; unlabeled PR and labeled fork PR publish nothing; `meta-pr` is asserted line by line.
- [x] 7.6 Document in `docs/RELEASING.md`: adding the label, same-repo-only rule, owner approval for the `ghcr-publish` environment on every deployment (PR and release), `pr-N` tag meaning, and re-adding the label to republish.

## 8. Convert publication to public GHCR

- [x] 8.1 Change registry auth to `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}` and add job-level `packages: write` (workflow stays `contents: read`); remove every `GHCR_PUBLISH_TOKEN` reference.
- [x] 8.2 Remove the `GHCR_PACKAGES_PRIVATE` output/env and gate from `prepare`; delete the placeholder/inheritance/bootstrap text from the workflow header and comments.
- [x] 8.3 Add `org.opencontainers.image.licenses=NOASSERTION` to the `labels` of `meta-release`, `meta-edge`, and `meta-pr`.
- [x] 8.4 Update `tests/release/docker-publish-workflow.test.ts`: permissions include `packages: write` at the publish job, login uses `GITHUB_TOKEN`, no `GHCR_PUBLISH_TOKEN`/`GHCR_PACKAGES_PRIVATE`, bootstrap-refusal case removed, licence label asserted on all three metadata steps, PR/edge/release cases unchanged.
- [x] 8.5 Amend `packages/line-client/THIRD_PARTY_NOTICES.md` and `packages/line-client/assets/ltsm/provenance.json`: public container images approved by dated owner risk acceptance (2026-11-16); public npm still NOT approved; correct the "private/internal repository" wording.
- [x] 8.6 Amend `README.md` (anonymous pulls, no login/access grant, irreversibility warning, provenance bullet), `CLAUDE.md` (public images approved; npm still forbidden), `docs/RELEASING.md` (first-publication flip, anonymous verify, approval-gated release/PR flow, no PAT/bootstrap), and `docs/ARCHITECTURE.md` (`GITHUB_TOKEN`, public GHCR).
- [x] 8.7 Update `tests/release/release-documentation.test.ts`: assert anonymous `docker pull`, no `docker login`, no `GHCR_PUBLISH_TOKEN`/`GHCR_PACKAGES_PRIVATE`/bootstrap heading, irreversibility warning, `NOASSERTION`/policy wording, and the runbook's visibility step.
- [x] 8.8 Run `openspec validate publish-docker-images`, the release tests, lint, build, and the docker smoke test against locally built images; push to PR #96 with an updated body. Do not flip visibility, publish, or merge.

## 9. Remove automatic publishing on merge

- [x] 9.1 Delete the `push: branches: [main]` trigger from `.github/workflows/publish-docker.yml`; keep `repository_dispatch`, `release`, `workflow_dispatch`, and `pull_request: [labeled]`.
- [x] 9.2 Update `tests/release/docker-publish-workflow.test.ts`: the trigger object has no `push`; remove push-specific edge cases and keep the untagged-dispatch edge cases; add an assertion that no `push` trigger exists.
- [x] 9.3 Update docs: README no longer claims publishing on every main push; RELEASING starts publication from a release dispatch or manual dispatch, and the first publication is not the merge; ARCHITECTURE lists triggers without `push`.
- [x] 9.4 Verify with the release tests, lint, build, and `openspec validate`; commit and push to PR #96.

## 10. Move workflows to Node 24 actions

- [x] 10.1 Update `publish-docker.yml`: `actions/checkout@v7`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/metadata-action@v6`, `docker/build-push-action@v7`.
- [x] 10.2 Update `ci.yml` and `release.yml`: `actions/checkout@v7`, `actions/setup-node@v7`.
- [x] 10.3 Update `tests/release/release-workflow.test.ts`, `tests/release/ci-commit-policy.test.ts`, and `tests/release/docker-publish-workflow.test.ts` to assert the new action versions.
- [x] 10.4 Run the release tests, lint, and build; commit `ci: update actions to node24 runtimes`.
