# Releasing

Git tags and GitHub Releases are the version source of truth. Package manifests
remain at the private-project baseline `0.1.0`; this repository never publishes
npm packages and semantic-release never commits version or changelog files.

## Commit Policy

Commits and PR titles use `type(scope?): subject`. The Husky `commit-msg` hook
provides local feedback, and CI validates every PR commit plus its title. The
Husky `pre-commit` hook also scans staged changes with gitleaks when the binary
is installed, and CI repeats that scan over every PR range.
The three merge-subject prefixes (`Merge branch`, `Merge pull request`,
`Merge remote-tracking branch`) are exempt wherever commitlint runs, including
the PR title check. That is a message-based heuristic: a handwritten message or
title using one of those prefixes also bypasses the type check. Authored
messages with conventional prefixes are still validated. Breaking changes
produce a major release, `feat` a minor release, `fix` and `perf` a patch
release, and all other allowed types no release.

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

Do not move or recreate the baseline tag after publishing it. The `v0.1.0`
baseline has **no container images**: image publication starts with the first
`Release` run after it.

## Normal Release

The `Release` workflow (`.github/workflows/release.yml`) is the only path to a
version tag and a GitHub Release. It runs only through `workflow_dispatch`, only
from `main`, and only for the repository **owner**; `authorize` refuses any other
actor or ref before a job writes anything. Merging or pushing to `main`
publishes nothing.

Wait for CI on `main`, then dispatch it from **Actions → Release → Run
workflow** with `main` selected. The workflow always releases current `main`, not
an older head.

### Stages

| Stage | What it does |
| ----- | ------------ |
| `authorize` | Refuses every actor but the repository owner (compared case-insensitively) and every ref but `refs/heads/main`. The `plan`, `draft`, and `publish` jobs repeat it because "re-run failed jobs" does not re-run a job that already succeeded. |
| `plan` | Runs `npm run release:plan`, a semantic-release dry run that creates no tag. It writes the next `vX.Y.Z`, its notes, and the planned commit. **`No releasable commits` is a successful no-op**: nothing is created. |
| `draft` | Creates a GitHub **draft** release titled with the tag, targeted at the planned commit, with the generated notes. A draft creates no git tag. A stale draft for the same tag is deleted and replaced, so a retry starts clean; a published release with that tag, or an existing remote tag, fails the run. |
| `images` | Calls the reusable `Publish Docker` workflow (`.github/workflows/publish-docker.yml`, `workflow_call`) to build both images at the planned commit and push the version tags. |
| `publish` | Logs in to GHCR with `GITHUB_TOKEN`, reads both image digests, appends one `## Docker images` section (pull command, digest reference, and package page per image) to the notes, then publishes the draft with `gh release edit --draft=false`. Publishing the draft is what creates the git tag, and the job verifies the tag resolves to the planned commit. |

Every image deployment enters the protected `ghcr-publish` environment, so
GitHub asks the owner to approve it. Approve the deployment when prompted: the
approval is required, and without it no image is pushed.

The tag does not exist until `publish` succeeds. Until then the release is only a
draft, and abandoning it leaves no tag behind.

### Recovering a failed run

| Failed stage | What to do |
| --- | --- |
| `authorize`, `plan` | Fix the cause, then dispatch a new run: run as the owner from `main`, create the missing `v0.1.0` baseline tag, or plan again from the current head. |
| `draft` | Retryable failures (authorization, API, transient): re-run the same run while `main` is unchanged; a stale draft for the same tag is deleted and replaced automatically. A published release or an existing remote tag for the planned version cannot be replaced: resolve that release or tag first, or dispatch a new run once `main` carries commits that plan a higher version. |
| `images`, or `publish` before the release is public | Re-run all jobs of the same run while `main` is unchanged; the stale draft is replaced and the images are rebuilt at the planned commit. If `main` has moved, dispatch a new run instead: it plans from the new head and replaces a stale draft for the same tag. |
| `publish` after the release is public (for example a failed tag read-back) | Use **Re-run failed jobs**, not all jobs: it re-runs only `publish`, which edits the published release, re-appends exactly one image section, and checks the tag again. A full re-run would stop at `draft` because the release is already published. |
| Any staleness failure (`origin/main` moved, or `main` changed during planning) | Dispatch a new run. A re-run keeps the original commit and cannot recover. |
| Tag mismatch after `publish` | Manual fix: the tag was created but resolves to a commit other than the planned one. Inspect the tag and release, then correct the tag by hand. |

There is no manual re-publish of an old tag: a broken image is fixed by a new
release, never by rebuilding an existing version.

## Docker Images

Both runtime targets are published to **GitHub Container Registry (GHCR) only**,
as two public packages:

| Workflow target | Image | Tools |
| --------------- | ----- | ----- |
| `server` | `ghcr.io/raidenyn/line-mcp-full` | ten (composed) |
| `line-mcp` | `ghcr.io/raidenyn/line-mcp` | five (standalone) |

Publication is done by the **`Publish Docker`** workflow in
`.github/workflows/publish-docker.yml`. It is a reusable workflow: the `Release`
workflow calls it (`workflow_call`) to build both images at the commit it
planned, and that is the only way a release image is published. It accepts no
manual dispatch and no release or tag event, so a tag never gets images by
itself.

Both images bundle LINE Corporation's proprietary LTSM assets. On 2026-11-16 the
owner permanently accepted the redistribution risk for public container images
(see `packages/line-client/THIRD_PARTY_NOTICES.md` and
`packages/line-client/assets/ltsm/provenance.json`). The packages are **public
once the one-time visibility flip below is complete** — the first publication
creates them private, and an anonymous `docker pull` fails until the owner flips
visibility ([First publication: the one-way visibility flip](#first-publication-the-one-way-visibility-flip)).
After the flip, an anonymous `docker pull` succeeds with no credential and no
access grant. Public npm distribution remains **not approved**. There is no
Docker Hub or other registry push.

### First publication: the one-way visibility flip

Every GHCR package is created **private**, and the workflow cannot choose
otherwise. The first publication therefore creates both packages private, and
**only the repository owner** flips them public — once, by hand. Nothing here may
be delegated to an agent, and no approval, personal token, package role, or
repository variable is involved in the flip.

1. Create both packages: run the `Release` workflow (or, if a release is not
   ready yet, add the `publish-docker` label to a same-repository pull request)
   and approve the `ghcr-publish` deployment. Wait for it to finish, so that
   `ghcr.io/raidenyn/line-mcp-full` and `ghcr.io/raidenyn/line-mcp` both exist.
2. Open the personal package settings pages —
   `https://github.com/users/raidenyn/packages/container/line-mcp-full/settings`
   and
   `https://github.com/users/raidenyn/packages/container/line-mcp/settings`
   (organization package URLs 404 for a personal account).
3. Change each package's visibility from **Private** to **Public** and confirm
   the warning. Do this for both packages: their settings are independent.
4. Verify anonymously from a shell with no registry login, using the image tag
   that publication created (or a `pr-<number>` tag if the packages came from a
   labeled pull request). Image tags drop the git tag's leading `v`:

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/raidenyn/line-mcp-full:X.Y.Z   # must succeed
   docker pull ghcr.io/raidenyn/line-mcp:X.Y.Z        # must succeed
   ```

**The flip is irreversible.** A public package cannot be made private again, so
do not flip visibility until the owner has accepted that permanently — they did
on 2026-11-16. Never delete a package to "start over": deleting does not
restore privacy, and it loses every published tag for that image. The retired
manual dispatch used to publish `edge` tags; those are no longer produced, and
any left in the packages may be deleted by hand without affecting the flip.

No personal access token is stored anywhere. The protected `ghcr-publish`
environment holds only the required owner approval; each job logs in with the
built-in `GITHUB_TOKEN` under the `packages: write` permission declared on that
job. Keep the approval required for every deployment: it is the abuse control
now that the workflow token can push packages. The environment must keep
permitting `main` and pull-request refs — the `Release` workflow deploys from
`main`, and a labeled pull request deploys from its PR ref. The approval, not the
ref filter, is the trust boundary.

### Pull-request images

Adding the **`publish-docker`** label to a **same-repository** pull request
publishes that PR's head commit as **`pr-<number>`** plus `sha-<short>`, for both
targets, and nothing else. The workflow asserts a tag allowlist immediately
before every push: a pull-request build may push only `pr-<number>` and
`sha-<short>` — never `latest`, `X.Y`, `X`, or a version tag — so a pull request
cannot shadow a release.

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

Both images are publicly readable: `docker pull` needs no token and no access
grant, so readers never authenticate.
