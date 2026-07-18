# CLAUDE.md Rewrite + docs/ARCHITECTURE.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the bloated CLAUDE.md into a compact agent operations manual plus a new `docs/ARCHITECTURE.md` deep reference, per the approved spec `docs/superpowers/specs/2026-07-18-claude-md-rewrite-design.md`.

**Architecture:** Two-file docs change. `docs/ARCHITECTURE.md` receives lines 46–178 of the current CLAUDE.md verbatim (with `###` headings promoted to `##` under a new title + preamble + maintenance rule). CLAUDE.md is then fully rewritten as a ~70-line ops manual (commands, branching/commit/PR policy, tiered pre-PR gate, code-review rule, hard rules, doc map). README.md is untouched.

**Tech Stack:** Markdown only. No build/test surface of its own; the final task runs the repo's mandatory pre-PR gate.

## Global Constraints

- Work happens on the existing branch `docs/claude-md-rewrite` (already created from `origin/main`; the spec commit `7cb1e77` is on it).
- `README.md` and all other existing docs must NOT be modified.
- No content may be deleted: every section under the old CLAUDE.md "Architecture" heading must appear in `docs/ARCHITECTURE.md`.
- **Task order is mandatory: Task 1 before Task 2.** Task 1 copies line ranges out of the current CLAUDE.md; Task 2 overwrites that file.
- Commit messages follow Conventional Commits (`docs: …`) and end with the two harness trailers (Co-Authored-By + Claude-Session) shown in each commit step.

---

### Task 1: Create `docs/ARCHITECTURE.md`

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Read (source, unchanged in this task): `CLAUDE.md` lines 46–178

**Interfaces:**
- Consumes: current `CLAUDE.md` (178 lines; line 44 is `## Architecture`, content starts line 46, file ends line 178).
- Produces: `docs/ARCHITECTURE.md` whose lines 1–8 are the preamble below and whose lines 9+ are CLAUDE.md lines 46–178 with `^### ` → `## `. Task 2's doc map points at this path.

- [ ] **Step 1: Generate the file**

The preamble is exactly 8 lines (title, blank, 5 quote lines, blank), so copied content starts at line 9. Run:

```bash
cd /home/oc-shadow/.openclaw/workspace/line-mcp
{ cat <<'EOF'
# LINE MCP Server — Architecture Reference

> This is the deep architecture reference for this repository;
> `CLAUDE.md` is the operational entry point for agents.
>
> **Maintenance rule:** any PR that changes packages, tools, guides,
> auth, persistence, or Docker must update this file in the same PR.

EOF
sed -n '46,178p' CLAUDE.md | sed 's/^### /## /'
} > docs/ARCHITECTURE.md
```

- [ ] **Step 2: Verify the copy is lossless and correctly transformed**

```bash
diff <(sed -n '46,178p' CLAUDE.md | sed 's/^### /## /') <(tail -n +9 docs/ARCHITECTURE.md) && echo LOSSLESS
grep -c '^## ' docs/ARCHITECTURE.md
```

Expected: `LOSSLESS` (empty diff) and a heading count of `13` (Package graph, six package sections, MCP resources & guide ownership, Auth flow, Data model & one-process-per-root rule, Docker, Specs & artifact policy, Tests). If `diff` prints anything, stop and fix before committing.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: add ARCHITECTURE.md deep reference (moved from CLAUDE.md)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0145PuDJsk2wG1P75SGsmys1"
```

---

### Task 2: Rewrite `CLAUDE.md` as the agent ops manual

**Files:**
- Modify (full overwrite): `CLAUDE.md`

**Interfaces:**
- Consumes: `docs/ARCHITECTURE.md` from Task 1 (referenced by path in the doc map — Task 1 MUST be committed first).
- Produces: the final `CLAUDE.md`, exactly the content below.

- [ ] **Step 1: Overwrite `CLAUDE.md` with exactly this content**

````markdown
# CLAUDE.md

Operational guide for agents working in this repository. Deep architecture
reference: `docs/ARCHITECTURE.md`.

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
npm run test:unit    # in-process unit / contract / migration + import-boundary tests
npm run test:smoke   # local LINE mock + compiled CLIs (no credentials, no Docker)
npm run test:e2e     # live LINE e2e (requires .line-auth.json; manual, pre-release only)
npx vitest run <file>                                    # single test file
npx vitest run tests/docker/docker-smoke.test.ts         # both Docker targets: healthz + tools/list
npx vitest run tests/artifacts/line-client-pack.test.ts  # packed line-client artifact check
```

`LINE_API_BASE_URL` repoints the LINE client at a different gateway — tests
and development only. Production leaves it unset; any override still receives
real LINE authorization headers, so only point it at a trusted endpoint.

## Workflow

**Branching**

- Start every new brainstorming/feature session on a fresh `type/<topic>`
  branch (`feat/`, `fix/`, `docs/`, `chore/`, …) created from `origin/main`.
- Never commit directly to `main`. Do not create or offer git worktrees.
- If `origin/master` is requested but absent, use `origin/main`.

**Commits & PR titles — Conventional Commits, semver-mapped**

- Format `type(scope?): subject`. Allowed types: `feat`, `fix`, `refactor`,
  `test`, `docs`, `chore`, `ci`, `build`, `perf`.
- Breaking changes: `!` after the type/scope, or a `BREAKING CHANGE:` footer.
- Semver mapping: `feat` → minor, `fix` → patch, breaking → major.
- **Name every PR in the identical format** — squash-merge turns the PR
  title into the commit subject on `main`.

**Pre-PR gate (mandatory)**

- Always, before creating any PR:
  `npm run lint && npm run build && npm run test:unit && npm run test:smoke`
- Touched `Dockerfile` or `docker-compose.yml` → also
  `npx vitest run tests/docker/docker-smoke.test.ts`
- Touched line-client packaging, vendoring, or `assets` → also
  `npx vitest run tests/artifacts/line-client-pack.test.ts`
- The live e2e suite is manual-only; never required for a PR.

**Code review**

- If a PR already exists for the branch, post review findings as inline
  comments anchored to the relevant lines of that PR; report in chat only
  when there is no PR.

## Code style

`npm run lint` must pass. Match the conventions of the file you are editing.

## Hard rules

- Never edit `packages/line-client/assets/ltsm/*` (proprietary LINE artifacts).
- Never `npm publish` any package — no public distribution is approved.
- Never run two servers against the same data root.

## Doc map

- `README.md` — user-facing overview, tool tables, Docker usage, security notes.
- `docs/ARCHITECTURE.md` — packages, guides, auth, persistence, Docker, test
  details. **Update it in the same PR as any structural change.**
- `specs/*.md` — reverse-engineered LINE protocol reference.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — design docs and
  implementation plans; new designs go here.
- `packages/line-client/THIRD_PARTY_NOTICES.md` — LTSM distribution policy.
````

- [ ] **Step 2: Verify size and references**

```bash
cd /home/oc-shadow/.openclaw/workspace/line-mcp
wc -l CLAUDE.md
grep -n 'ARCHITECTURE.md' CLAUDE.md
ls docs/ARCHITECTURE.md
```

Expected: `wc -l` reports ≈ 85 lines (spec targets a compact ops manual; anything under ~90 is fine, 178 was the problem). Both `grep` hits resolve to the file `ls` confirms exists.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md as compact agent ops manual

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0145PuDJsk2wG1P75SGsmys1"
```

---

### Task 3: Run the mandatory pre-PR gate

The change is docs-only, but the policy this PR introduces applies to it too.

**Files:**
- None created or modified (verification only).

**Interfaces:**
- Consumes: the committed state from Tasks 1–2.
- Produces: a branch verified ready for PR (`docs: split CLAUDE.md into ops manual + ARCHITECTURE.md reference` is the suggested PR title).

- [ ] **Step 1: Confirm no unintended files changed**

```bash
git status --porcelain
git diff origin/main --stat
```

Expected: clean status; diff touches only `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-07-18-claude-md-rewrite-design.md`, and `docs/superpowers/plans/2026-07-18-claude-md-rewrite.md`.

- [ ] **Step 2: Run the core gate**

```bash
npm run lint && npm run build && npm run test:unit && npm run test:smoke
```

Expected: all four pass (no source files changed, so failures indicate a pre-existing problem — report it, do not paper over it). The Docker/pack conditional gates are NOT triggered: no `Dockerfile`, compose, or line-client packaging files were touched.
