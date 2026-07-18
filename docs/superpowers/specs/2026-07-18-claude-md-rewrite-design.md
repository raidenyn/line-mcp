# CLAUDE.md Rewrite + docs/ARCHITECTURE.md — Design

**Date:** 2026-07-18
**Status:** Approved

## Problem

`CLAUDE.md` (178 lines) largely duplicates `README.md`: package tables,
per-package file inventories, auth flow, Docker internals, test-suite
descriptions. It gives an agent lots of architecture prose but little
operational guidance — no commit-naming policy, no mandatory pre-PR test
gate, no branching or code-review workflow. Agents making changes and
creating PRs load ~180 lines of context and still have to infer process
from git history.

## Goal

Turn `CLAUDE.md` into a short, precise agent operations manual: how to
build, what must pass before any PR, how to name branches/commits/PRs,
how to handle code review, and where to find every piece of detailed
information — without overloading context. Nothing is deleted; deep
content moves to a dedicated architecture reference.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Architecture deep-dive | Move to new `docs/ARCHITECTURE.md`; CLAUDE.md keeps a 3-line orientation + pointer. Maintenance rule: keep it updated on structural change. |
| Pre-PR test gate | Tiered: core suite always; docker-smoke / pack tests only when touching the related surfaces. |
| Commit naming | Conventional Commits with explicit semver mapping; PR titles use the identical format. |
| Code style section | Minimal: lint must pass; match surrounding code. |
| Branch naming | `type/<topic>` mirroring commit types, from `origin/main`, new branch per brainstorming/feature session. |
| Code review | Findings go as inline comments on the existing PR; chat only when no PR exists. |
| Self-containedness | Compact ops manual (~65 lines): commands and gates inline, everything else a doc-map pointer. README untouched. |

## Deliverable 1 — `docs/ARCHITECTURE.md` (new)

Receives, essentially verbatim, everything currently under CLAUDE.md's
"Architecture" heading:

- Project description + monorepo/package-graph table
- The six per-package walkthroughs
- MCP resources & guide ownership, including its existing maintenance rule
- Auth flow (transport, token cutover, token lifecycle)
- Data model & one-process-per-root rule
- Docker (two targets, builder details, compose services)
- Specs & artifact policy
- Detailed test-suite descriptions

Additions:

- Short preamble: this file is the deep reference; `CLAUDE.md` is the
  operational entry point.
- Maintenance rule at the top: **any PR that changes packages, tools,
  guides, auth, persistence, or Docker must update this file in the same
  PR.**

## Deliverable 2 — rewritten `CLAUDE.md` (~65 lines)

1. **Orientation** (3 lines) — what the project is, six-package
   npm-workspace monorepo, two runnable servers; pointer to
   `docs/ARCHITECTURE.md`.
2. **Commands** (~12 lines, inline) — build / clean / start / lint, the
   three test scripts, single-test-file invocation, one-line
   `LINE_API_BASE_URL` note.
3. **Workflow** (~25 lines):
   - *Branching:* every new brainstorming/feature session starts a fresh
     `type/<topic>` branch (`feat/`, `fix/`, `chore/`, `docs/`, …) from
     `origin/main`; never commit to `main`; no git worktrees; if
     `origin/master` is requested but absent, use `origin/main`.
   - *Commits and PR titles:* Conventional Commits
     `type(scope?): subject`; allowed types `feat`, `fix`, `refactor`,
     `test`, `docs`, `chore`, `ci`, `build`, `perf`; breaking changes
     marked with `!` or a `BREAKING CHANGE:` footer; semver mapping
     (feat → minor, fix → patch, breaking → major). **Every PR title
     follows the identical format** — squash-merge turns it into the
     commit subject on `main`.
   - *Pre-PR gate (mandatory):* `npm run lint`, `npm run build`,
     `npm run test:unit`, `npm run test:smoke` must all pass before
     creating any PR. Additionally: changes touching `Dockerfile` /
     `docker-compose.yml` require the docker-smoke test; changes
     touching line-client packaging/vendoring/assets require the pack
     test. Live e2e is manual, never required.
   - *Code review:* when a PR already exists for the branch, post review
     findings as inline comments anchored to lines on that PR; report in
     chat only when there is no PR.
4. **Code style** (2 lines) — `npm run lint` must pass; match the
   conventions of the file being edited.
5. **Hard rules** (3 bullets, inline because violations are expensive):
   never edit `packages/line-client/assets/ltsm/*`; never `npm publish`
   any package; never run two servers against one data root.
6. **Doc map** (~6 lines) — one line each: `README.md` (user-facing
   overview, tools, Docker usage), `docs/ARCHITECTURE.md` (keep updated
   on structural change), `specs/*.md` (reverse-engineered LINE protocol
   reference), `docs/superpowers/specs|plans/` (design docs — new
   designs go here), `packages/line-client/THIRD_PARTY_NOTICES.md`
   (LTSM distribution policy).

## Out of scope

- `README.md` and all other existing docs are untouched.
- No lint/tooling enforcement (commitlint, husky) is added.
- No content is deleted — everything either moves to
  `docs/ARCHITECTURE.md` or is condensed with a pointer.

## Verification

Docs-only change: no build or test surface. Verified by review — check
that every section of the old CLAUDE.md is present in the new
ARCHITECTURE.md, and the new CLAUDE.md stays near the ~65-line target.
