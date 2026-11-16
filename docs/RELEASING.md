# Releasing

Git tags and GitHub Releases are the version source of truth. Package manifests
remain at the private-project baseline `0.1.0`; this repository never publishes
npm packages and semantic-release never commits version or changelog files.

## Commit Policy

Commits and PR titles use `type(scope?): subject`. The Husky `commit-msg` hook
provides local feedback, and CI validates every PR commit plus its title.
Breaking changes produce a major release, `feat` a minor release, `fix` and
`perf` a patch release, and all other allowed types no release.

## One-time v0.1.0 Bootstrap

Run only after the release-automation PR is merged and `main` is checked out at
the intended baseline commit:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --verify-tag --title "v0.1.0" --notes "Initial release."
```

Do not move or recreate the baseline tag after publishing it.

## Normal Release

Wait for CI on `main`, then run the `Release` workflow with
`workflow_dispatch`. The workflow always checks current `main`. No releasable commits is a successful no-op. A release creates `vX.Y.Z`, publishes
generated GitHub Release notes, and emits `release-published` for the Docker
workflow.

Rerun a failed workflow after correcting the reported permission, API, or stale
checkout error. Semantic-release will not recreate an existing version.

## Docker Images

Both runtime targets are published to **GitHub Container Registry (GHCR) only**,
as two private packages:

| Workflow target | Image | Tools |
| --------------- | ----- | ----- |
| `server` | `ghcr.io/raidenyn/line-mcp-full` | ten (composed) |
| `line-mcp` | `ghcr.io/raidenyn/line-mcp` | five (standalone) |

Publication is done by the **`Publish Docker`** workflow in
`.github/workflows/publish-docker.yml`. The packages **must stay private**: every
image bundles LINE Corporation's proprietary LTSM assets, and the provenance
policy approves Docker images for internal use only. There is no Docker Hub or
other public push, no anonymous pull, and no change of package visibility from
CI.

### GHCR Private-Package Bootstrap

This is a **one-time, maintainer-only** sequence. Do it once, before the publish
workflow's first run. Nothing here may be delegated to an agent: the workflow
gate is a repository variable that only a human sets.

1. **Pre-check both package names.** While signed in, open the authenticated
   personal package pages
   `https://github.com/users/raidenyn/packages/container/line-mcp-full` and
   `https://github.com/users/raidenyn/packages/container/line-mcp` (or the
   personal account's packages list,
   `https://github.com/raidenyn?tab=packages`) and confirm neither
   `line-mcp-full` nor `line-mcp` already exists as a **public** package. GHCR
   cannot make a public package private again, and **this runbook never deletes
   a package**. If one already exists and is public, **stop**: leave publication
   disabled (do not set `GHCR_PACKAGES_PRIVATE`, and stop any run that could
   republish), and state that the owner must decide separately how to proceed —
   the bootstrap is not continued on top of a public package.

2. **Push an asset-free placeholder to each package.** The
   `org.opencontainers.image.source` label is what links a package to this
   repository, and inheritance can only be disabled **after** linking. A
   `FROM scratch` image contains no application files, so nothing proprietary is
   exposed while inheritance is still on. No runtime image may be pushed until
   inheritance is off and the denial check below has passed.

   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   printf 'FROM scratch\n' > Dockerfile.placeholder
   for image in line-mcp-full line-mcp; do
     docker build \
       --label org.opencontainers.image.source=https://github.com/raidenyn/line-mcp \
       -t "ghcr.io/raidenyn/$image:placeholder" \
       -f Dockerfile.placeholder .
     docker push "ghcr.io/raidenyn/$image:placeholder"
   done
   ```

3. **Keep linked, disable inherited access.** In each linked package's settings:
   set visibility to **Private**, and untick **"Inherit access from source
   repository"**. Keep the package linked to this repository — disabling
   inheritance is the step that matters, and unlinking is never part of this
   runbook. Do **not** grant `raidenyn/line-mcp` Actions package access —
   this repository is public, so repository-wide Actions access would let fork
   runs read the packages. No package role is granted to the repository token.

4. **Create the protected `ghcr-publish` environment.** Require an owner
   approval, and set the deployment-branch policy to allow `main`, `v*` tags,
   **and pull-request refs** — PR publication is gated by the approval, not by
   the ref filter. Store the classic personal access token as
   `GHCR_PUBLISH_TOKEN` (scope `write:packages`, which implies `read:packages`).
   The workflow logs in with that environment secret and never with
   `GITHUB_TOKEN`; its permissions stay `contents: read`.

5. **Verify denial for both packages in the linked state.** The two packages'
   access controls are independent, so checking one says nothing about the
   other. While signed in to GHCR as an **unrelated** GitHub account with no
   access grant, attempt a pull of each; both must be denied:

   ```bash
   docker pull ghcr.io/raidenyn/line-mcp-full:placeholder   # must fail
   docker pull ghcr.io/raidenyn/line-mcp:placeholder        # must fail
   ```

6. **Record the bootstrap variable.** A maintainer (not an agent) sets it, and
   the workflow refuses to publish while it is not `true`:

   ```bash
   gh variable set GHCR_PACKAGES_PRIVATE --body true
   ```

7. **Keep the placeholders until the first automatic `edge` push lands.** After
   that push, re-open both package pages and confirm "Inherit access from source
   repository" is still off **on each**, then repeat the denial check for **both**
   packages — including a fork-origin credential path (a workflow run from a fork
   or branch must not be able to read `GHCR_PUBLISH_TOKEN` or either package):

   ```bash
   docker pull ghcr.io/raidenyn/line-mcp-full:placeholder   # must still fail
   docker pull ghcr.io/raidenyn/line-mcp:placeholder        # must still fail
   ```

   Only then delete the `placeholder` **versions**. Never delete either package.
   If a package is deleted, unset the variable, stop any run that could
   republish, and redo the whole bootstrap.

### Publication and re-publication

Automatic publication happens when the `Release` workflow's `release-published`
repository dispatch arrives, and when a GitHub Release is published by a
maintainer. Both build the source at the release tag (not `main`'s head) and
publish `X.Y.Z` plus `sha-<short>`; `latest`, `X.Y`, and `X` move only when that
tag is the newest stable release, and `X` is never published on `0.x`.

A **prerelease is skipped**: the run succeeds without pushing and without moving
any tag.

To re-publish a tag deliberately, dispatch `Publish Docker` **from `main`**:

```bash
gh workflow run publish-docker.yml --ref main -f tag=v1.2.3
```

- A **bare tag push** (`git push origin v1.2.3`) publishes no image by design —
  use the dispatch above.
- **Tags that predate this workflow** have no images; dispatch the tag to create
  them.
- **Promoting a prerelease** to a full release fires `released`, not
  `published`, so the release trigger does not run, and the workflow only
  accepts a `vX.Y.Z` tag. If the promoted tag is already `vX.Y.Z`, dispatch it
  manually.
- Re-publishing an **older** tag adds only that `X.Y.Z` and its `sha-<short>`;
  `latest`, `X.Y`, and `X` do not move backwards.
- If a run fails, **re-run the whole workflow**, not only its failed jobs, so
  the preparation job recomputes refs and tags.

Readers of the private images need a token with `read:packages` **and** an
access grant from the maintainer; a valid token alone is not enough.

### Pull-request images

Adding the **`publish-docker`** label to a **same-repository** pull request
publishes that PR's head commit as **`pr-<number>`** plus `sha-<short>`, for
both targets, and nothing else. A PR build never creates or moves `latest`,
`edge`, or a release tag, so a pull request cannot shadow a release.

- **Only the label event acts.** Later pushes to the labeled PR do not
  republish; remove and re-add the label to publish the new head. Any other
  label, or any PR activity without `publish-docker`, publishes nothing and
  succeeds.
- **Fork pull requests are refused** with a warning before the protected
  environment is entered, so the registry token is never offered to a fork.
- **Every PR and release run needs the owner's approval.** Both deploy into
  the protected `ghcr-publish` environment, so the environment's
  deployment-branch policy must permit pull-request refs; the approval, not
  the ref filter, is the trust boundary (a same-repository PR can edit this
  workflow).
- **The bootstrap gate still applies.** While `GHCR_PACKAGES_PRIVATE` is not
  `true`, a labeled PR refuses to publish and the run fails; unlabeled PR
  activity does not fail.
