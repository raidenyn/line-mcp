# Gated Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Release` the only, owner-only, `main`-only path that publishes release-tagged Docker images (labeled-PR builds keep only `pr-<number>`/`sha-<short>`): it plans the version and notes, holds a tagless draft release, builds both images, appends image links, then publishes the draft.

**Architecture:** `release.yml` runs `authorize → plan → draft → images → publish`. `plan` uses `semantic-release` only as a dry-run planner (`scripts/release-plan.mjs`); `draft`/`publish` drive the GitHub Release with `gh` (GitHub creates the tag when the draft is published); `images` calls `publish-docker.yml`, which now accepts only `workflow_call` (release tags, building the caller's commit) and the labeled-PR trigger (`pr-<number>`/`sha-<short>` only, enforced by a tag allowlist). Workflow behavior is tested by parsing the YAML and executing extracted bash `run:` steps against fake `git`/`gh` binaries, the technique already used in `tests/release/docker-publish-workflow.test.ts`.

**Tech Stack:** GitHub Actions (reusable workflows, environments), `gh` CLI, bash, `semantic-release` 25 JS API, Node 24 / ESM `.mjs` script, vitest, `yaml`.

**Spec:** `openspec/changes/gated-release-pipeline/` — `design.md`, `tasks.md`, `specs/release-pipeline/spec.md`, `specs/docker-image-publishing/spec.md`.

## Global Constraints

- Repository slug `raidenyn/line-mcp`; owner is `github.repository_owner`; GHCR only; images `ghcr.io/raidenyn/line-mcp-full` (target `server`) and `ghcr.io/raidenyn/line-mcp` (target `line-mcp`).
- Authenticate to GHCR with `secrets.GITHUB_TOKEN` and `packages` permissions only — no PAT, no stored registry secret.
- Tag format `vX.Y.Z` (`^v[0-9]+\.[0-9]+\.[0-9]+$`); `X` image tag never on major `0`; `latest`/`X.Y`/`X` only for the newest stable version; labels keep `org.opencontainers.image.licenses=NOASSERTION`.
- No version commits, no changelog files, no `npm publish`; `package.json` versions stay `0.1.0`.
- `Publish Docker` triggers are exactly `workflow_call` and `pull_request: [labeled]`; it keeps its `publish-docker` concurrency block (`queue: max`), whose name differs from `Release`'s `release` group.
- PR builds push only tags matching `^(pr-[0-9]+|sha-[0-9a-f]{7})$` and never create or move `latest`, `X.Y`, `X`, or `X.Y.Z`; the `ghcr-publish` environment keeps owner approval and must keep permitting `main` and PR refs.
- Never edit `packages/line-client/assets/ltsm/*`. Commits: Conventional Commits (`ci:`/`docs:`/`test:`/`build:`); PR title in the same format.
- No commit or PR title uses `!` or a `BREAKING CHANGE:` footer: the next release must not bump the major version. This change is `ci:`/`build:`/`docs:`/`test:` only, so merging it releases nothing.
- Pre-PR gate: `npm run lint && npm run build && npm run test:unit && npm run test:smoke`. Branch from `origin/main`, never commit to `main`.

## Review Focus

1. A published release or remote tag for the planned version already exists → `draft` refuses before creating anything (test in Task 3).
2. More than one stale draft for the same tag → all are deleted, not just the first (Task 3).
3. Release notes with backticks, `$(…)`, or quotes → passed to `gh` by file, never interpolated into a shell string (Task 3).
4. Re-run against a body that already contains `## Docker images` → exactly one section afterwards (Task 3).
5. `main` advances after dispatch → images and the draft stay pinned to the planned SHA; `plan` fails if `HEAD != origin/main` at start (Tasks 1, 2, 3).
6. Owner login compared case-insensitively (`Raidenyn` vs `raidenyn`) while any other login is refused (Task 3).
7. A PR build can never produce `latest`, `X.Y`, `X`, or `X.Y.Z`: `Assert tag allowlist` rejects any PR tag outside `^(pr-[0-9]+|sha-[0-9a-f]{7})$` before the push, and a release build with a `pr-` tag fails (allowlist table test in Task 2).
8. The release-mode caller guard compares `github.workflow_ref` to `$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/main`: it refuses other files (even one named `Release`), events, and refs (resolve-script cases in Task 2; file-path test in Task 3).
9. Partial re-run by a non-owner ("Re-run failed jobs" skips `authorize`) → `draft` and `publish` repeat the owner guard (Task 3).
10. `plan` holds `contents: write` (semantic-release's `git push --dry-run` probe throws `EGITNOPERMISSION` even in dry-run, verified in 25.0.8 `index.js`) → credentials not persisted, `npm ci --ignore-scripts`, token only in the planner step's env (Task 3).

---

### Task 1: Release planning script

**Files:**
- Create: `scripts/release-plan.mjs`
- Create: `tests/release/release-plan.test.ts`
- Modify: `.releaserc.json` (remove the `@semantic-release/github` entry), `package.json` (drop `@semantic-release/github` devDependency; `"release": "semantic-release"` → `"release:plan": "node scripts/release-plan.mjs"`), `package-lock.json` (via `npm install`; the package remains as a transitive dependency of `semantic-release` — expected)
- Modify: `eslint.config.js` only if `scripts/*.mjs` fails lint

**Interfaces:**
- Produces: `export async function plan(deps: { run: (opts: object) => Promise<false | { nextRelease: { version: string; gitTag: string; gitHead: string; notes: string } }>; writeOutput: (key: string, value: string) => void; writeNotes: (notes: string) => void }): Promise<void>` — writes outputs `released` (`'true'|'false'`) and, when released, `version` (no `v`), `tag` (`vX.Y.Z`), `sha` (`gitHead`), and calls `writeNotes(notes)`.
- Produces: running the file directly wires `deps` to `semantic-release` (`{ dryRun: true, branches: ['main'] }`, no `ci` override), `$GITHUB_OUTPUT`, and `$RELEASE_NOTES_FILE` (default `release-notes.md`).

- [ ] **Step 1: Write failing tests** in `tests/release/release-plan.test.ts`: `plan` with `run` resolving `false` writes only `released=false` and never calls `writeNotes`; with a result for `1.2.0` writes `released=true`, `version=1.2.0`, `tag=v1.2.0`, `sha=<gitHead>` and the notes; a `run` rejection propagates.
- [ ] **Step 2: Run** `npx vitest run tests/release/release-plan.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `scripts/release-plan.mjs` per the interface; guard the CLI wiring with `import.meta.url === pathToFileURL(process.argv[1]).href` so tests can import it.
- [ ] **Step 4: Drop the GitHub plugin**: edit `.releaserc.json` and `package.json`, then `npm install` to refresh the lockfile.
- [ ] **Step 5: Run** `npx vitest run tests/release/release-plan.test.ts tests/release/release-policy.test.ts` — expect PASS (policy test reads only commit-analyzer options) — and `npx eslint scripts tests/release` — expect no errors.
- [ ] **Step 6: Commit** `build: plan releases with a semantic-release dry run`

### Task 2: `Publish Docker` keeps only `workflow_call` and labeled-PR triggers

**Files:**
- Modify: `.github/workflows/publish-docker.yml`
- Modify: `tests/release/docker-publish-workflow.test.ts` (rewrite for the new shape)

**Interfaces:**
- Consumes: caller context (a called workflow sees the caller's `github` context) — `github.workflow_ref == "$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/main"`, `github.event_name == 'workflow_dispatch'`, `github.ref == 'refs/heads/main'`, `github.sha` is the planned commit.
- Produces: `on.workflow_call.inputs.tag` (`type: string`, `required: false`) and `on.pull_request.types == ['labeled']`. Job outputs of `prepare`: `publish`, `tag` (empty in PR mode), `pr` (empty in release mode), `sha`, `short_sha`, `major`, `latest`, `ref`. No `edge` output. A new `Assert tag allowlist` step runs between the metadata steps and `build`.

- [ ] **Step 1: Rewrite the tests first.** Assert: `workflow.on` equals `{ workflow_call: { inputs: { tag: { description: expect.any(String), required: false, type: 'string' } } }, pull_request: { types: ['labeled'] } }`; `workflow.concurrency` is `{ 'cancel-in-progress': false, group: 'publish-docker', queue: 'max' }`; the source contains none of `repository_dispatch`, `workflow_dispatch:`, `release:`, `edge`, `prerelease`, `GHCR_PUBLISH_TOKEN`, `type=gha`; one `docker/login-action@v4` with `GITHUB_TOKEN`; the `publish` job keeps `environment: ghcr-publish` and `permissions: { contents: read, packages: write }`; `Verify checked-out commit` still asserts `git rev-parse HEAD`; `meta-release` tag lines unchanged (version, `X.Y`, `X` when `major != '0'`, `latest`, `sha-<short>`); both metadata steps keep the `revision=<sha>` and `licenses=NOASSERTION` labels; build uses `steps.meta-release.outputs.* || steps.meta-pr.outputs.*`; `meta-pr` tag lines are exactly `pr-<number>` and `sha-<short>`. Resolve-script table cases (execute the `resolve` step with fake `git ls-remote`): PR mode — labeled same-repo PR publishes with `pr`, `sha`, empty `tag`/`major`, `latest=false`; unlabeled PR and fork PR → `publish=false`; release mode — `workflow_ref` of another file (e.g. `.github/workflows/other.yml@refs/heads/main`), `release.yml` at another ref, wrong caller event, wrong ref → exit 1 with a message; malformed/empty tag → exit 1; a `repository_dispatch`/`release`/plain `workflow_dispatch` event → exit 1; allowlist step table — PR tags `pr-96`, `sha-abc1234` pass, while `latest`, `1.2.3`, `1.2`, `1`, `edge`, `pr-x`, `sha-ABC1234` each exit 1 before any push; release tags starting with `pr-` exit 1; new tag newest vs existing remote stable tags → `latest=true`; lower than an existing stable tag → `latest=false`; `v0.2.0` → `major=0`; release candidates in the remote listing ignored; outputs map is complete (all keys asserted).
- [ ] **Step 2: Run** `npx vitest run tests/release/docker-publish-workflow.test.ts` — expect FAIL.
- [ ] **Step 3: Rewrite the workflow.** `on: workflow_call` (optional `tag`) plus `pull_request: [labeled]`; keep top-level `permissions: contents: read`, the `github.repository == 'raidenyn/line-mcp'` guard, the concurrency block, and the existing PR-mode logic. The `resolve` step receives `TAG`, `WORKFLOW_REF` (`github.workflow_ref`), `EVENT_NAME`, `REF`, `SHA`, and the PR variables via env, fails per the guards, computes `latest` in release mode by `sort -V | tail -n1` over remote stable tags plus `$TAG`, and writes `publish, tag, pr, sha, short_sha, major, latest, ref`. Delete the prerelease/release/dispatch/edge branches and `meta-edge`; keep `meta-release` (`if: tag != ''`) and `meta-pr` (`if: pr != ''`); add `Assert tag allowlist`, which reads the `tags` output of whichever metadata step ran and applies the PR allowlist (to the tag part after the last `:`) or the release "no `pr-`" rule before `build`.
- [ ] **Step 4: Run** `npx vitest run tests/release/docker-publish-workflow.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `ci: gate release image publishing behind the Release workflow`

### Task 3: Rewrite `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/release/release-workflow.test.ts`
- Create: `tests/release/support/run-step.ts` (shared helper extracted from the docker test: `runStep(run: string, opts: { env: Record<string,string>; fakes: Record<string,string> }): { status: number; stdout: string; stderr: string; output: Record<string,string> }` — writes fake executables named by `fakes` keys to a temp dir placed first on `PATH`, runs `bash -euo pipefail`, parses `GITHUB_OUTPUT`)

**Interfaces:**
- Consumes: Task 1 (`npm run release:plan`, outputs `released`, `version`, `tag`, `sha`, notes file `release-notes.md`); Task 2 (`images` passes `with: { tag: ${{ needs.plan.outputs.tag }} }`).
- Produces job graph: `authorize` → `plan` (needs authorize) → `draft` (needs plan; `if: needs.plan.outputs.released == 'true'`) → `images` (needs `[plan, draft]`; `uses: ./.github/workflows/publish-docker.yml`; `permissions: { contents: read, packages: write }`) → `publish` (needs `[plan, draft, images]`; `permissions: { contents: write, packages: read }`). `plan` has `permissions: { contents: write }`; `draft` has `{ contents: write }`. Workflow `permissions: contents: read`; `on: workflow_dispatch` only; `concurrency: { group: release, cancel-in-progress: false }`.

- [ ] **Step 1: Write the structure tests** in `release-workflow.test.ts`: `on` equals `{ workflow_dispatch: null }`; concurrency unchanged; the job graph and per-job `permissions`/`needs`/`if` above; `images.uses` equals `./.github/workflows/publish-docker.yml`; `plan` steps include checkout `fetch-depth: 0` with `persist-credentials: false` and no `ref`, `npm ci --ignore-scripts`, `Verify current main`, `Verify baseline tag exists` (`refs/tags/v0.1.0`), `run: npm run release:plan`, `Verify main unchanged`; `draft` and `publish` start with the same `authorize` step script as the `authorize` job; `draft` creates with `--draft` and `--target`, and the notes are passed with `--notes-file`; no step contains `repository_dispatch`, `npm run release$`, `git push`, `git commit`, or `npm publish`; the workflow file path Task 2's guard compares equals `.github/workflows/release.yml` (the file exists at that path).
- [ ] **Step 2: Write behavior tests** (`runStep` with fake `gh`/`git`) for: `authorize` (also as the first step of `draft`/`publish`) — owner passes, `Raidenyn` vs `raidenyn` passes, non-owner / non-`main` ref / wrong repository each exit 1 with distinct messages; `draft` — no existing release → creates draft and asserts no tag; two stale drafts for the tag are both deleted; an existing published release or remote tag exits 1 before any `gh release create`; notes containing `` `x` $(rm -rf /) "q" `` are never expanded (fake `gh` records the `--notes-file` content byte-for-byte); `Verify main unchanged` — `released=false` with fake `git ls-remote` returning another SHA exits 1 telling the owner to dispatch a new run, same SHA passes; `publish` — appends one `## Docker images` section with both images' pull command, digest reference (`ghcr.io/raidenyn/<image>@sha256:…`) and package page `https://github.com/raidenyn/line-mcp/pkgs/container/<image>`; running it on a body that already has the section leaves exactly one; tag resolving to a different SHA after publish exits 1 naming both SHAs.
- [ ] **Step 3: Run** `npx vitest run tests/release/release-workflow.test.ts` — expect FAIL.
- [ ] **Step 4: Implement the workflow.** `authorize`: a step with env `REPO`, `ACTOR` (`github.triggering_actor`), `OWNER`, `REF` that fails with `::error::` messages `only the repository owner can run Release`, `Release must be dispatched from refs/heads/main`, or `Release runs only in raidenyn/line-mcp`; compare logins with `${ACTOR,,}`; reuse it verbatim as the first step of `draft` and `publish`. `plan` (`contents: write`): checkout full history, default ref, `persist-credentials: false`; `npm ci --ignore-scripts`; keep the existing `Verify current main` (message: dispatch a new run; a re-run keeps the original commit) and `Verify baseline tag exists` steps; `npm run release:plan` with `RELEASE_NOTES_FILE` and `GITHUB_TOKEN` in that step's env only; `Verify main unchanged` (on `released=false`, compare HEAD with `git ls-remote "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" refs/heads/main`); `actions/upload-artifact` for the notes; map step outputs to job outputs. `draft` (no checkout; env `GH_REPO: ${{ github.repository }}`, `GH_TOKEN`): `gh api --paginate repos/$GH_REPO/releases` to find and delete every draft whose `tag_name` equals the tag, refuse when a published release or `git ls-remote --tags "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" refs/tags/$TAG` is non-empty, `gh release create "$TAG" --draft --target "$SHA" --title "$TAG" --notes-file notes.md`, then re-check `git ls-remote` is empty. `publish` (no checkout; `GH_REPO`, `GH_TOKEN`): download notes artifact; GHCR login (`docker/login-action@v4`, `GITHUB_TOKEN`); for each image `docker buildx imagetools inspect ghcr.io/raidenyn/<image>:<version> --format '{{.Manifest.Digest}}'`; build body = notes with any existing `## Docker images` section removed + new section; `gh release edit "$TAG" --draft=false --target "$SHA" --notes-file body.md`; assert `git ls-remote "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" refs/tags/$TAG^{}` (falling back to `refs/tags/$TAG`) equals the planned SHA.
- [ ] **Step 5: Run** `npx vitest run tests/release` — expect PASS for all release tests.
- [ ] **Step 6: Commit** `ci: gate releases behind owner, main, draft release and images`

### Task 4: Documentation

**Files:**
- Modify: `docs/RELEASING.md`, `README.md`, `docs/ARCHITECTURE.md`, `tests/release/release-documentation.test.ts`

**Interfaces:**
- Consumes: workflow names/stages from Tasks 2–3.
- Produces: the doc strings the updated tests assert.

- [ ] **Step 1: Update `release-documentation.test.ts` first.** Runbook must contain `workflow_dispatch`, `No releasable commits`, `draft`, `owner`, `ghcr-publish`, `Docker images`, `GITHUB_TOKEN`, `cannot be made private again`, `/users/raidenyn/packages/container/`, `never delete`, `v0.1.0`, `publish-docker` (the label), `pr-<number>`, and keep the still-valid existing assertions (`gh release create`, `Publish Docker`, `## Docker Images`, `### First publication: the one-way visibility flip`, the forbidden token/org strings); it must **not** contain `release-published`, `:edge`, or `gh workflow run publish-docker.yml` (a note that old `edge` tags may be deleted by hand is allowed). README must keep the pull commands, `@sha256:`, `sha-<short>`, the `X.Y`/`X` rows, `cannot be made private again`, `pr-<number>`, and must not contain `` `edge` ``. Architecture must contain `publish-docker.yml`, `workflow_call`, `ghcr.io`, `GITHUB_TOKEN`, `draft`.
- [ ] **Step 2: Run** `npx vitest run tests/release/release-documentation.test.ts` — expect FAIL.
- [ ] **Step 3: Rewrite docs.** `RELEASING.md`: keep Commit Policy and the `v0.1.0` bootstrap; replace "Normal Release" with the five stages, who/where, approval, and a per-stage recovery table (authorize/plan fail → fix and dispatch again; images or publish fail → re-run (same commit) while `main` is unchanged, otherwise dispatch a new run, stale draft replaced; a staleness failure always means dispatch a new run; tag mismatch → manual fix); replace the first-publication step 1 with "run `Release` (or label a PR); approve the `ghcr-publish` deployment" and make step 4 pull a published tag instead of `:edge`; delete "Publication and re-publication"; keep "Pull-request images" and add the tag allowlist (`pr-<number>`/`sha-<short>` only, never `latest`, `X.Y`, `X`, or a version tag); document `ghcr-publish` (required reviewer; permits `main` and PR refs) and a note that old `edge` tags may be deleted by hand and that `v0.1.0` has no images. `README.md`: remove the `edge` tag row, the "until a stable release exists … build `edge`" paragraph with its `:edge` pull commands, and rewrite the trigger paragraph; say release images are published only by `Release` and linked in each release's notes, and the `publish-docker` label publishes test tags only. `ARCHITECTURE.md` "Delivery & publication": describe the pipeline, draft-without-tag mechanism, `workflow_call`, caller guard, and removed triggers.
- [ ] **Step 4: Run** `npx vitest run tests/release/release-documentation.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `docs: document the gated release pipeline`

### Task 5: Verification and PR gate

**Files:** none new (fix findings in the owning task's files).

- [ ] **Step 1: Run** `openspec validate gated-release-pipeline --strict` — expect "valid".
- [ ] **Step 2: Run** `npm run lint && npm run build && npm run test:unit && npm run test:smoke` — expect all green.
- [ ] **Step 3: Run** `actionlint .github/workflows/*.yml` if installed — expect no errors; skip and say so if unavailable.
- [ ] **Step 4: Run** the planner locally in a scratch clone of `main`: `node scripts/release-plan.mjs` — expect `released=false`, a plan, or `EGITNOPERMISSION` without a push-capable token (expected outside the workflow), and `git ls-remote --tags` unchanged (no tag created).
- [ ] **Step 4a: Check release impact.** Run `npm run commitlint -- --from origin/main` and confirm no commit message contains `!:` or `BREAKING CHANGE`; run `npx vitest run tests/release/release-policy.test.ts` — expect PASS.
- [ ] **Step 5: Open the PR** titled `ci: gate release image publishing behind the Release workflow` (same subject as Task 2's commit; deliberately **not** marked breaking, so merging produces no release and never a major bump; squash-merge makes this the `main` commit) with the pre-PR gate output. Do not dispatch `Release` from the PR.
- [ ] **Step 6: Hand off to the owner** the post-merge actions from `tasks.md` 6.5 (confirm `ghcr-publish` still permits `main` and PR refs; first `Release` run verifying the `design.md` testable assumptions: push-access probe passes, draft has no tag, caller guard accepts `workflow_ref`, deployment requested for `main`, tag at planned SHA, release marked Latest; visibility flip) and the open owner decision on when moving tags move. The agent must not run them.
