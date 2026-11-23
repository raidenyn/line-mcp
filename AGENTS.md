# AGENTS.md

Operational guide for agents working in this repository — the host-neutral
source of truth that `CLAUDE.md` imports. Architecture: `docs/ARCHITECTURE.md`.

This is a **LINE MCP server** — an npm-workspace monorepo of six TypeScript
packages (`packages/*`, `tsc -b`, CommonJS output) building two runnable
servers: the composed server (`@raidenyn/server`, ten tools) and the
standalone messenger server (`@raidenyn/line-mcp`, five tools).

## Commands

```bash
npm run build        # tsc -b — composite build of all six packages
npm run clean        # tsc -b --clean
npm start            # composed server: node packages/server/dist/cli.js (HTTP MCP on localhost:3000)
node packages/line-mcp/dist/cli.js                       # standalone messenger server
npm run lint         # eslint .
npm run verify       # pre-PR gate: lint, one tsc -b, strict OpenSpec validation, then unit/architecture/release/smoke
npm run verify:changed  # inner loop: changed/untracked .ts lint + affected tests
npm run verify:all   # verify + Docker smoke + packed line-client artifact check
npm run test:unit    # in-process unit / contract / migration + import-boundary tests
npm run test:smoke   # local LINE mock + compiled CLIs (no credentials, no Docker)
npm run test:e2e     # live LINE e2e (requires .line-auth.json; manual, pre-release only)
npx vitest run <file>                                    # single test file
npx vitest run tests/docker/docker-smoke.test.ts         # both Docker targets: healthz + tools/list
npx vitest run tests/artifacts/line-client-pack.test.ts  # packed line-client artifact check
npm run commitlint  # validate a commit message/range with commitlint
```

`LINE_API_BASE_URL` repoints the LINE client at a different gateway — tests
and development only. Production leaves it unset; any override still receives
real LINE authorization headers, so only point it at a trusted endpoint.

## Workflow

**Branching**

- Start every new brainstorming/feature session on a fresh `type/<topic>`
  branch (`feat/`, `fix/`, `docs/`, `chore/`, …) created from `origin/main`.
- Never commit directly to `main`.
- Worktrees are created by the host: T3 Code can create one per thread, and
  `claude --worktree` starts Claude Code in one. Work in the checkout the
  host gave you; do not create ad-hoc `git worktree` checkouts. This
  includes OpenSpec apply: when it calls `superpowers:using-git-worktrees`
  inside a host worktree, implement in place (no `.worktrees/<change>`); at
  finalize skip only merge and cleanup, then commit `finalize.md` (Outcome
  `pr-updated`, Cleanup `preserved (harness-owned)`), push, and post its PR comment.
- If `origin/master` is requested but absent, use `origin/main`.

**Change type → required process**

| Change type | Required process |
| --- | --- |
| typo, docs, dependency bump | no spec |
| bug fix | `openspec-propose` (quick path), or a regression test referenced in the PR |
| feature, protocol or auth change | full OpenSpec flow: `openspec-new-change` → `openspec-continue-change` (through plan) → `openspec-apply-change` → `openspec-verify-change` → `openspec-continue-change` (finalize) → `openspec-archive-change` |

Other types (refactor, test, ci, build, perf): match the risk row; release/publish changes count as features; unsure → heavier row.

**Commits & PR titles — Conventional Commits, semver-mapped**

- Format `type(scope?): subject`. Allowed types: `feat`, `fix`, `refactor`,
  `test`, `docs`, `chore`, `ci`, `build`, `perf`.
- Breaking changes: `!` after the type/scope, or a `BREAKING CHANGE:` footer.
- Semver mapping: `feat` → minor, `fix` / `perf` → patch, breaking → major.
- A Husky `commit-msg` hook checks local commits; CI checks every PR commit and
  the PR title, so `--no-verify` cannot bypass repository enforcement.
- **Name every PR in the identical format** — squash-merge turns the PR
  title into the commit subject on `main`.

**Pre-PR gate (mandatory)**

- Always, before creating or updating any PR: `npm run verify` — lint, one
  `tsc -b`, strict OpenSpec validation, then the unit/architecture/release
  suites and the mock-backed smoke suite. It never triggers a second build.
- Touched `Dockerfile` or `docker-compose.yml`, or line-client packaging,
  vendoring, or `assets` → run `npm run verify:all` instead: it adds the Docker
  smoke and the packed-artifact checks.
- The live e2e suite is manual-only; never required for a PR.

**Verification ladder** — run the cheapest rung that covers the change.

| Rung | Command | When | Measured wall time |
| --- | --- | --- | --- |
| 0 | `npm run verify:changed` | Every edit: lint changed/untracked JS/TS files, then only the tests affected by the diff vs `origin/main` | ~19 s with changes; ~0.3 s with no changes |
| 1 | `npm run verify` | Before opening or updating a PR | ~40–65 s (warm cache) |
| 2 | `npm run verify:all` | `Dockerfile`/`docker-compose.yml` or line-client packaging/vendoring/`assets` changed | Always rebuilds both images (fails without a daemon), then runs the smoke and pack checks; pack rung ~35 s |
| 3 | `npm run test:e2e` | Manual, pre-release only (needs `.line-auth.json`) | not measured |

`verify:changed` only covers tests inside the changed package: workspace
packages import each other from compiled `dist`, so a change to exported package
code needs `verify` to reach dependent packages' tests. Measured on a 4-core
Linux container with a warm `node_modules`. CI keeps the existing verbose jobs
(`check`, `smoke`, `docker`, `pack-line-client`).

**Code review**

- Independent review before human review for every feature, protocol or
  auth change, and any other change over ~100 changed lines (lockfiles
  excluded) or touching more than one package. The reviewer starts with
  fresh context — a new session or a subagent — and gets only the spec
  (issue or `openspec/changes/<name>/`) and `git diff origin/main...HEAD`,
  never the implementer's narrative. Use whatever the host offers, e.g.
  Claude Code's `/code-review`, or `superpowers:requesting-code-review` where
  Superpowers is installed.
- Open the PR as a draft, post the findings inline (below), fix them, then
  mark it ready for human review.
- If a PR already exists for the branch, post review findings as inline
  comments anchored to the relevant lines of that PR; report in chat only
  when there is no PR.

## Code style

`npm run lint` must pass. Match the conventions of the file you are editing.

## Hard rules

- Never edit `packages/line-client/assets/ltsm/*` (proprietary LINE artifacts).
- Never `npm publish` any package — public npm distribution is not approved.
  Public **container images** are approved: the owner accepted the LINE LTSM
  redistribution risk permanently on 2026-11-16 (see
  `packages/line-client/THIRD_PARTY_NOTICES.md`), and the `Publish Docker`
  workflow publishes them to public GHCR with `GITHUB_TOKEN`.
- Never run two servers against the same data root.

## Doc map

- `AGENTS.md` — this file; the host-neutral agent guide that `CLAUDE.md` imports.
- `README.md` — user-facing overview, tool tables, Docker usage, security notes.
- `docs/ARCHITECTURE.md` — packages, guides, auth, persistence, Docker, test
  details. **Update it in the same PR as any structural change.**
- `specs/*.md` — reverse-engineered LINE protocol reference.
- `openspec/specs/` — behavioral source of truth, validated in CI with `npx openspec validate --all --strict`.
- `openspec/changes/` — active designs and implementation plans; new designs go here; keep each change's `handoff.md` current before ending a session (template: `openspec/templates/handoff.md`).
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — frozen archive; do not add new designs here.
- `.agents/skills/` + `.claude/skills/` — `openspec-*` skills; the latter links the former for Claude Code.
- `packages/line-client/THIRD_PARTY_NOTICES.md` — LTSM distribution policy.
- `docs/RELEASING.md` — commit enforcement, version policy, release workflow,
  and the one-time `v0.1.0` bootstrap runbook.
