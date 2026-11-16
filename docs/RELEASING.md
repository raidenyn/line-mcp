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
as two public packages:

| Workflow target | Image | Tools |
| --------------- | ----- | ----- |
| `server` | `ghcr.io/raidenyn/line-mcp-full` | ten (composed) |
| `line-mcp` | `ghcr.io/raidenyn/line-mcp` | five (standalone) |

Publication is done by the **`Publish Docker`** workflow in
`.github/workflows/publish-docker.yml`. Both images bundle LINE Corporation's
proprietary LTSM assets. On 2026-11-16 the owner permanently accepted the
redistribution risk for public container images (see
`packages/line-client/THIRD_PARTY_NOTICES.md` and
`packages/line-client/assets/ltsm/provenance.json`). The packages are **public
once the one-time visibility flip below is complete** — the first push creates
them private, and an anonymous `docker pull` fails until the owner flips
visibility ([First publication: the one-way visibility flip](#first-publication-the-one-way-visibility-flip)).
After the flip, an anonymous `docker pull` succeeds with no credential and no
access grant. Public npm distribution remains **not approved**. There is no
Docker Hub or other registry push.

### First publication: the one-way visibility flip

Every GHCR package is created **private**, and the workflow cannot choose
otherwise. The first push to `main` therefore creates both packages private, and
**only the repository owner** flips them public — once, by hand. Nothing here may
be delegated to an agent, and no approval, personal token, package role, or
repository variable is involved.

1. Let the first `edge` run finish so both packages exist:
   `ghcr.io/raidenyn/line-mcp-full:edge` and `ghcr.io/raidenyn/line-mcp:edge`.
2. Open the personal package settings pages —
   `https://github.com/users/raidenyn/packages/container/line-mcp-full/settings`
   and
   `https://github.com/users/raidenyn/packages/container/line-mcp/settings`
   (organization package URLs 404 for a personal account).
3. Change each package's visibility from **Private** to **Public** and confirm
   the warning. Do this for both packages: their settings are independent.
4. Verify anonymously from a shell with no registry login:

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/raidenyn/line-mcp-full:edge   # must succeed
   docker pull ghcr.io/raidenyn/line-mcp:edge        # must succeed
   ```

**The flip is irreversible.** A public package cannot be made private again, so
do not flip visibility until the owner has accepted that permanently — they did
on 2026-11-16. Never delete a package to "start over": deleting does not
restore privacy, and it loses every published tag for that image.

No personal access token is stored anywhere. The protected `ghcr-publish`
environment holds only the required owner approval; the job logs in with the
built-in `GITHUB_TOKEN` under the `packages: write` permission declared on that
job. Keep the approval required for every deployment: it is the abuse control
now that the workflow token can push packages.

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

Both images are publicly readable: `docker pull` needs no token and no access
grant, so readers never authenticate.

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
  environment is entered, so a fork never reaches a deployment.
- **Every PR and release run needs the owner's approval.** Both deploy into
  the protected `ghcr-publish` environment, so the environment's
  deployment-branch policy must permit pull-request refs; the approval, not
  the ref filter, is the trust boundary (a same-repository PR can edit this
  workflow). The approval stays required even though the images are public:
  it is the abuse control for the `packages: write` workflow token.
- **The workflow token is the only credential.** There is no personal access
  token, no stored registry secret, and no package access grant; the
  `ghcr-publish` environment holds the approval only.
