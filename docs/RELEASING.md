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
