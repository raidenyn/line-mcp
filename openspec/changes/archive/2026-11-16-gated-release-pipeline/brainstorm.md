## Design Summary

**Intent.** A release is the only way a release-tagged Docker image reaches
GHCR, and a release never goes public without its images. The owner starts it by hand from `main`;
it plans the version and notes, hides them in a *draft* release (no git tag
yet), builds both images, then appends the image links to the notes and
publishes the draft — which is the moment GitHub creates the tag.

**Why.** "No docker publishing without release notes." Today the order is the
reverse: `semantic-release` tags and publishes a public GitHub Release first,
then a decoupled `repository_dispatch` builds images. A failed image build
leaves a public release with no images, nothing writes image links into the
notes, `Publish Docker` can also push release-tagged or `edge` images from a
manual dispatch or a published release with no release notes, and any
collaborator with write access can start `Release`. (Labeled-PR test builds
with `pr-`/`sha-` tags are not the problem and stay.)

**Pipeline (all in `release.yml`, started by `workflow_dispatch` on `main`):**

```
authorize ─► plan ─► draft ─► images ─► publish
 owner?      version   draft     Publish    append image links,
 main?       + notes   release   Docker     publish draft
             (dry-run) NO tag    (called)   ⇒ tag is created
```

1. **authorize** — fails loudly unless `github.triggering_actor` is the
   repository owner, the repository is `raidenyn/line-mcp`, and
   `github.ref == refs/heads/main`.
2. **plan** — checkout full history of `main`, require HEAD to equal
   `origin/main` and the `v0.1.0` baseline tag to exist, then run
   `semantic-release` through its JS API with `dryRun: true`. Output: next
   version, tag name, the commit SHA, and the generated notes (commits since the
   latest release tag). No releasable commits ⇒ successful no-op, nothing else
   runs. The dry run creates no tag and no release.
3. **draft** — create (or replace a stale) **draft** GitHub Release for
   `vX.Y.Z` with `target_commitish = <planned SHA>` and the notes as body.
   GitHub does not create the tag for a draft; the job asserts the tag is
   still absent on the remote.
4. **images** — call `Publish Docker` as a reusable workflow (`workflow_call`;
   its only other trigger is the labeled-PR path, which can never produce
   release tags) with the release tag. It builds both targets
   from the planned SHA (the tag does not exist yet) and pushes `X.Y.Z`,
   `sha-<short>`, and — only when this is the newest stable version — `X.Y`,
   `X`, `latest`. It keeps the `ghcr-publish` owner-approval environment.
5. **publish** — runs only if every image succeeded: appends a
   "Docker images" section (pull commands by tag and digest, package pages) to
   the draft body, publishes the draft (GitHub creates the tag at the planned
   SHA), and asserts the tag resolves to that SHA.

**Failure semantics.** Fail before `images` ⇒ nothing public, a draft at most.
Fail in `images` ⇒ some `X.Y.Z` image tags may exist, the release is still a
draft with no tag; re-running (same commit) or, if `main` moved, a new
dispatch replaces the draft and rebuilds (image tags are mutable). Fail in
`publish` ⇒ same. A release
is public only when its images exist.

**`Publish Docker` after the change:** two triggers only — `workflow_call` (from
`Release`, release tags) and `pull_request: labeled` (`publish-docker` label,
same-repository PRs, owner approval, tags `pr-<number>` + `sha-<short>` only,
enforced by a tag allowlist `^(pr-[0-9]+|sha-[0-9a-f]{7})$` before the push).
**Removed:** `repository_dispatch`, `release: published`, `workflow_dispatch`
(edge builds and manual re-publish), prerelease handling, and the `edge` tag.
Its `publish-docker` concurrency group (`queue: max`) stays; its name differs
from `Release`'s `release` group, so the two cannot deadlock.

## Alternatives Considered

### Alternative A: Release last, dry-run before images
- **Approach**: dry-run for version/notes, build images, then real
  `semantic-release` creates tag + release with notes and links.
- **Pros**: failed image build ⇒ no tag, no release; simple recovery.
- **Cons**: two `semantic-release` invocations that could disagree if `main`
  moves; the final run needs the GitHub plugin and tag-push rights; notes are
  produced twice.
- **Why not chosen**: the owner preferred a draft release, which makes the
  hold-back a first-class GitHub state and generates the notes once.

### Alternative B: `semantic-release` with `draftRelease: true`
- **Approach**: normal `semantic-release` run that pushes the tag and creates a
  draft release, then images, then publish the draft.
- **Pros**: notes generated once by the stock plugin.
- **Cons**: `semantic-release` core pushes the git tag *before* any plugin
  publishes, so the tag exists while the release is still a draft; a failed
  image build leaves a tag that blocks re-planning that version.
- **Why not chosen**: owner requires that no tag exists until the release is
  published.

### Alternative C: Keep today's order, add links afterwards
- **Approach**: release and tag first, call Publish Docker as a job, edit the
  notes to add links.
- **Pros**: smallest change.
- **Cons**: a failed image build leaves a public release with no images, which
  is the state the owner wants to rule out.
- **Why not chosen**: violates the core intent.

## Agreed Approach

**Draft release with a dry-run plan and no tag until publish** (the pipeline
above): a mix of A and B. `semantic-release` runs only as a planner
(`dryRun`, JS API) so it never tags; the workflow owns the draft release, the
image call, and the final publish. `Publish Docker` keeps only `workflow_call` (release) and the labeled-PR trigger
(test images).

## Key Decisions

- **Owner-only** is enforced in the workflow (`triggering_actor` ==
  `repository_owner`) *and* by the `ghcr-publish` environment's required owner
  approval; either alone is insufficient (a collaborator with write access can
  dispatch workflows; a workflow edit is reviewed only by branch protection).
  The environment stays open to `main` **and** same-repository PR refs because
  PR-level image publishing keeps using it; the approval, not the ref filter,
  is the trust boundary.
- **Main-only**: `github.ref` guard in `authorize` (the dispatch UI lets anyone
  pick a branch; today the workflow silently checks out `main` anyway), plus the
  existing HEAD == `origin/main` staleness check. The called Publish Docker
  workflow re-checks the caller's `github.workflow_ref` (`release.yml@refs/heads/main`) and event (see design Decision 6).
- **Planned SHA** is `github.sha` of the Release run; images and the tag target
  both use it, so a push to `main` mid-run cannot change what is released
  (plan fails if `origin/main` moved before it starts; later pushes are
  irrelevant because everything is pinned).
- **No version commits**: versions stay git-tag-only; `package.json` files stay
  at `0.1.0` (`docs/RELEASING.md` policy, and a version commit would need a push
  to protected `main`). *Assumed default; the owner did not object.*
- **`semantic-release` as planner**: drop `@semantic-release/github` from
  `.releaserc.json` and `package.json` (release creation moves to `gh`), keep
  commit-analyzer and release-notes-generator; the `release` npm script becomes a
  plan script (`scripts/release-plan.mjs`).
- **Image links** in the notes: `docker pull` commands by version tag, digest
  reference per image, and the GHCR package page. Digests come from
  `docker buildx imagetools inspect` after the push (builder's call on the
  mechanism).
- **PR images stay, release tags are off-limits to them**: the `publish-docker`
  label still publishes `pr-<number>` and `sha-<short>` (owner-approved), and a
  tag allowlist makes it impossible for a PR build to create or move `latest`,
  `X.Y`, `X`, or `X.Y.Z`. `edge` and manual re-publish disappear. The first
  release-tagged image publication happens on the first real release after this
  lands; the one-time visibility flip follows the first publication of either
  kind.
- **`v0.1.0`** stays imageless (it predates the pipeline).

## Open Questions

- ~~Does `semantic-release` in `dryRun` tolerate a read-only `GITHUB_TOKEN`?~~
  Resolved in review: no — the push probe throws `EGITNOPERMISSION` even in
  dry-run, so `plan` gets `contents: write` (design Decision 3a).
- Exact GitHub behaviour of `target_commitish = <sha>` on draft publish (tag
  created at that commit) — verified by the workflow's post-publish assertion.
- Owner-side settings that cannot live in the repo: keep the `ghcr-publish`
  environment's required reviewer and make sure its deployment-branch policy
  still permits both `main` and pull-request refs (no change expected).
  Documented in `docs/RELEASING.md`; not automatable.
