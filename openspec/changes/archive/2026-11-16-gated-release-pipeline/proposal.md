## Why

Today `Release` tags and publishes a public GitHub Release first, then a decoupled dispatch builds images, so a failed build leaves a release with no images and nothing links them in the notes. `Publish Docker` can also push release-tagged or `edge` images from a manual dispatch, a published release or a repository dispatch with no release notes (labeled-PR test builds are fine and stay), and any collaborator with write access can start a release. The owner wants one gated path: owner-only, `main`-only, images before the release goes public.

## What Changes

**Release workflow becomes the single, gated publication path**
- From: any collaborator can dispatch `Release` from any branch (it silently checks out `main`); it tags and publishes the release, then fires `repository_dispatch` for images.
- To: only the repository owner can run it, only from `refs/heads/main`. It plans the version and notes with a `semantic-release` dry run, creates a **draft** release (no git tag), builds both images, appends image links to the notes, then publishes the draft — GitHub creates the tag at that moment.
- Reason: a release is public only when its images exist; a failure before publish leaves no tag and no public release.
- Impact: collaborators can no longer start a release; image consumers gain image links in every release's notes.

**Publish Docker keeps two triggers: `workflow_call` and the labeled PR**
- From: triggers on `repository_dispatch`, `release: published`, `pull_request: labeled`, and `workflow_dispatch`.
- To: `workflow_call` (only from `Release`, with a release tag input and a guard that the caller is `release.yml` on `main`, checked by workflow ref) and `pull_request: labeled`. PR builds still go through `ghcr-publish` with owner approval but may push only `pr-<number>` and `sha-<short>`, enforced by a tag allowlist; they can never create or move `latest`, `X.Y`, `X`, or version tags.
- Reason: no release-tagged image without release notes; PR test images stay available without any path to release tags.
- Impact: removes (for `edge` users) — `edge` images, manual re-publish of a tag, `repository_dispatch`, `release: published` and `workflow_dispatch` triggers, prerelease handling. PR test images and the `publish-docker` concurrency group stay.

**Release planning**
- `semantic-release` is used only as a planner (JS API, `dryRun`); `@semantic-release/github` is dropped from config and devDependencies and a plan script replaces `npm run release`. The planning job keeps `contents: write` because `semantic-release` verifies push access even in dry-run; it pushes nothing.
- Versions remain git-tag-only; no version commits.

**Docs and tests**
- `docs/RELEASING.md`, `README.md` and `docs/ARCHITECTURE.md` describe the new flow; `tests/release/*` are rewritten for it.

## Capabilities

### New Capabilities
- `release-pipeline`: owner-only, main-only manual release that plans a version and notes, holds a draft release without a tag, publishes images through Publish Docker, appends image links, and publishes the draft.

### Modified Capabilities
- `docker-image-publishing`: release-tagged publication is reachable only from the Release workflow; manual previews (`edge`), release-event/dispatch triggers and prerelease handling are removed; pull-request images stay but are restricted by an enforced `pr-<number>`/`sha-<short>` tag allowlist; the release tag scheme builds from the planned commit before the git tag exists.

## Impact

- `.github/workflows/release.yml` (rewritten), `.github/workflows/publish-docker.yml` (`workflow_call` + labeled-PR triggers only), new `scripts/release-plan.mjs`, `.releaserc.json`, `package.json` / `package-lock.json` (drop `@semantic-release/github`, change `release` script).
- `tests/release/release-workflow.test.ts`, `tests/release/docker-publish-workflow.test.ts`, `tests/release/release-documentation.test.ts`; new `tests/release/release-plan.test.ts` and `tests/release/support/run-step.ts`.
- `docs/RELEASING.md`, `README.md` (Docker section: drop the `edge` row, rewrite the trigger paragraph), `docs/ARCHITECTURE.md` (Delivery & publication).
- Owner-side GitHub settings (not in the repo): none required; the `ghcr-publish` environment keeps its required reviewer and must keep permitting `main` and pull-request refs.
- `openspec/specs/docker-image-publishing` (delta), new `openspec/specs/release-pipeline`.
