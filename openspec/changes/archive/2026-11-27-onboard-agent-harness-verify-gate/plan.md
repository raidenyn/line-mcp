# Onboard the Agent Harness Verify Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `node scripts/verify-changed.mjs` from the copied agent harness tools after a file edit, after a ticked task and at every turn end, on OpenCode and Claude Code, replacing the repo's own lint-on-edit hooks.

**Architecture:** The hook runtime and verify gate (catalog v0.7.0) are copied into `.agents/harness/` by their own `install`. The repo's fast rung `scripts/verify-changed.mjs` becomes the one command: an `edit` branch lints only `VERIFY_FILE` with the old lint-on-edit logic (moved to `scripts/lint-file.mjs`); every other trigger keeps today's path. The session-context hook stays on both hosts.

**Tech Stack:** Node 24 ESM scripts (`.mjs`, no build), ESLint 10 flat config, Vitest 4, pnpm 12, GitHub Actions.

**Spec:** `openspec/changes/onboard-agent-harness-verify-gate/specs/agent-verify-hooks/spec.md`, with `brainstorm.md` and `proposal.md` in the same folder, and the task issue raidenyn/agentic-development-skills#15 (acceptance criteria and its 2026-11-26 reconciliation comment).

## Global Constraints

- Copied files under `.agents/harness/` are never edited by hand; only the tools' `install`/`update` write them, the lock and the host configs.
- Install from the published catalog: `~/.claude/plugins/cache/agentic-development-skills/agent-harness-hook-runtime/0.7.0/assets/hook-runtime/cli.mjs` and `.../agent-harness-verify-gate/0.7.0/assets/verify-gate/cli.mjs` (the OpenCode catalog copy is the same version). Hook runtime first.
- `verify-gate`: `command: ["node", "scripts/verify-changed.mjs"]`, `base: "origin/main"`, `taskFiles: ["openspec/changes/*/tasks.md"]`, `editFiles: ["**/*.ts", "**/*.mts", "**/*.cts"]`, `timeoutSeconds` left at the default 900.
- What `verify-changed.mjs` checks at a tick, at turn end and by hand stays as it is. `session-context.mjs`, husky and commitlint stay.
- No new dependencies. Edit lint stays TypeScript-only (`/\.(?:c|m)?ts$/`), at most 20 lines (`MAX_LINES`).
- Work in the host-given checkout; no new `git worktree`. Every commit and the PR title follow Conventional Commits (`chore(agents): …`).
- Pre-PR gate: `pnpm run verify`.

## Review Focus

- **`VERIFY_TRIGGER=edit` without `VERIFY_FILE`** (or empty): exit 0 without linting and without falling through to the full run. Test in Task 2.
- **`VERIFY_FILE` outside the repo or a path with `..`**: exit 0, no ESLint. Test in Task 1 (`lintTarget`).
- **Edited file deleted before the edit run** (a patch that deletes it): exit 0. Test in Task 2.
- **ESLint missing or crashing on the edit trigger** (status 2 or a signal): exit 0, nothing printed, as the old hook. Test in Task 1 via an injected runner.
- **The copied `.mjs` linted by `verify:changed`** at turn end when `.agents/harness/` changes: ESLint ignores them (warning only), so the turn end passes. Checked in Task 3 Step 4.

---

### Task 1: Move the lint logic to `scripts/lint-file.mjs`

**Files:**
- Create: `scripts/lint-file.mjs`
- Create: `tests/harness/lint-file.test.ts` (from `tests/harness/lint-on-edit.test.ts`)
- Delete: `tests/harness/lint-on-edit.test.ts` (in Task 3, together with the hook)

**Interfaces:**
- Produces (`scripts/lint-file.mjs`, named exports):
  - `REPO_ROOT: string` — `resolve(fileURLToPath(new URL('..', import.meta.url)))`
  - `MAX_LINES = 20`
  - `lintTarget(file: string | undefined, root = REPO_ROOT, cwd = root): string | null` — repo-relative POSIX path of a lintable file, else null; same rules as today's `lintTarget` (canonical paths through symlinks, excluded `dist`, `node_modules`, `.git` segments and `packages/line-client/assets/ltsm/`).
  - `formatErrors(json: string, file: string, maxLines = MAX_LINES): string[]` — unchanged text.
  - `fixedNote(file: string): string` — unchanged text.
  - `lintFile(file: string, root = REPO_ROOT, spawn = spawnSync): { errors: string[], fixed: boolean }` — unchanged logic; `spawn` injectable for the crash test.
  - `lintEditedFile(file: string | undefined, root = REPO_ROOT): { code: 0 | 1, output: string }` — `lintTarget` then `lintFile`; `code 1` and `output` = errors (capped, with `fixedNote` appended when `fixed`, as today's stderr) when errors remain, else `{ code: 0, output: '' }`.

- [ ] **Step 1: Write `tests/harness/lint-file.test.ts`** by porting every case of `lint-on-edit.test.ts` to the new signatures: `lintTarget('packages/server/src/cli.ts', ROOT)`, absolute paths, `cwd` through a symlink, the skip list (`README.md`, `scripts/verify-changed.mjs`, `packages/server/dist/cli.d.ts`, `node_modules/foo/index.ts`, `packages/line-client/assets/ltsm/x.ts`, `../outside.ts`, `/etc/x.ts`, `undefined`); both `formatErrors` cases unchanged. Replace the hook-script cases with `lintEditedFile` cases on `tests/harness/.fixture-*` files:
  - fixable + unfixable → `code 1`, output matches `/fixture\.ts:3:7 .*unused.*\(@typescript-eslint\/no-unused-vars\)/` and `/ESLint --fix rewrote .*fixture\.ts; re-read it/`, ≤ 20 lines, file now contains `const fixable = 1;`
  - fixable only → `code 0`, output is only the rewrite note, file rewritten (the gate hands it to the model as edit pass output)
  - clean file → `{ code: 0, output: '' }`
  - `lintFile` with a `spawn` stub returning `{ status: 2 }` and with `{ status: null, signal: 'SIGTERM' }` → `{ errors: [] }`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/harness/lint-file.test.ts` — Expected: FAIL, cannot resolve `../../scripts/lint-file.mjs`.
- [ ] **Step 3: Implement `scripts/lint-file.mjs`** by moving the functions out of `.claude/hooks/lint-on-edit.mjs` (keep its header comment, adapted) and adding `lintEditedFile`. No `main`.
- [ ] **Step 4: Run** `pnpm exec vitest run tests/harness/lint-file.test.ts && pnpm exec eslint scripts/lint-file.mjs tests/harness/lint-file.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `refactor(agents): move the edit lint into scripts/lint-file.mjs`.

### Task 2: The `edit` branch of `scripts/verify-changed.mjs`

**Files:**
- Modify: `scripts/verify-changed.mjs` (`main`, the `if (process.argv[1] …)` guard)
- Test: `tests/release/verify-entrypoint.test.ts` (new `describe('verify:changed triggers')`)

**Interfaces:**
- Consumes: `lintEditedFile` from Task 1.
- Produces: `export function editRun(env = process.env): { code: number, output: string } | null` — null when `env.VERIFY_TRIGGER !== 'edit'`; else `lintEditedFile(env.VERIFY_FILE || undefined)`. `main` calls it first: on non-null it writes `output` to stderr (if any) and exits with `code`; on null it runs today's path unchanged.

- [ ] **Step 1: Write the failing tests** (spawn `node scripts/verify-changed.mjs` with `env: { ...process.env, VERIFY_TRIGGER: 'edit', VERIFY_FILE: … }`, timeout 60 s):
  - `it('lints only the edited file on the edit trigger')`: a fixture with an unfixable error → status 1, stderr matches `/no-unused-vars/`, stdout does not contain `verify:changed:` (no full run).
  - `it('passes at once for a file it does not lint')`: `VERIFY_FILE=README.md` → status 0, empty stdout and stderr.
  - `it('passes when the edited file is gone or unnamed')`: `VERIFY_FILE=tests/harness/.fixture-missing/x.ts` and `VERIFY_FILE` unset → status 0, no `verify:changed:` line.
  - `it('keeps the full path for other triggers')`: `editRun({ VERIFY_TRIGGER: 'turn-end' })`, `editRun({ VERIFY_TRIGGER: 'task' })` and `editRun({})` are `null`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/release/verify-entrypoint.test.ts` — Expected: FAIL (`editRun` is not exported; the edit spawn runs the full path).
- [ ] **Step 3: Implement `editRun`** and the early return in `main`. Keep the existing exports and the no-`npx` rule.
- [ ] **Step 4: Run** `pnpm exec vitest run tests/release/verify-entrypoint.test.ts tests/harness/lint-file.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): lint only the edited file on the verify gate's edit trigger`.

### Task 3: Install the tools and remove the old lint hooks

**Files:**
- Create (by `install` only): `.agents/harness/hook-runtime/**`, `.agents/harness/verify-gate/**`, `.agents/harness/lock.json`, `.agents/harness.json`, `opencode.json`
- Modify: `.claude/settings.json` (by `install`, then remove the `PostToolUse` `Edit|Write|MultiEdit` lint entry by hand), `.agents/harness.json` (the `verify-gate` values), `eslint.config.js` (`ignores` gets `'.agents/harness/**'`), `.opencode/harness/hooks.ts`, `tests/harness/opencode-plugin.test.ts`
- Delete: `.claude/hooks/lint-on-edit.mjs`, `tests/harness/lint-on-edit.test.ts`

**Interfaces:**
- Consumes: the command of Task 2.
- Produces: `.opencode/harness/hooks.ts` exports `REPO_ROOT`, `HookRun`, `HookRunner`, `runHook(root)`, `createPlugin(root?, run?)` only; `createPlugin().setup` registers the session `context` hook and no `execute.after` hook.

- [ ] **Step 1: Install**, from the repo root:
  ```bash
  node ~/.claude/plugins/cache/agentic-development-skills/agent-harness-hook-runtime/0.7.0/assets/hook-runtime/cli.mjs install --repo .
  node ~/.claude/plugins/cache/agentic-development-skills/agent-harness-verify-gate/0.7.0/assets/verify-gate/cli.mjs install --repo .
  ```
  Expected: both exit 0; `.claude/settings.json` gains a runtime entry on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `PreCompact`, `Stop`, `SubagentStop`, `SessionStart` (after the existing session-context entry); `opencode.json` is `{"plugins": ["./.agents/harness/hook-runtime/opencode"]}`.
- [ ] **Step 2: Set the config** in `.agents/harness.json` to the Global Constraints values; remove the lint `PostToolUse` entry; delete `.claude/hooks/lint-on-edit.mjs` and its test; add the ESLint ignore.
- [ ] **Step 3: Update the OpenCode plugin tests first**: drop the cases for `editedPaths`, `appendText`, `additionalContext`, the `--fix` note and lint feedback; change the first case to assert the source contains `.claude/hooks/session-context.mjs` and not `lint-on-edit`; add `it('registers no tool hook')` (after `setup` on `fakeContext()`, `hooks['tool.execute.after']` is undefined). Keep the context, child-session, never-throws and real-script cases. Run `pnpm exec vitest run tests/harness` — Expected: FAIL on the new assertions.
- [ ] **Step 4: Strip the lint branch** from `.opencode/harness/hooks.ts` (and its header comment), then run `pnpm exec vitest run tests/harness && node .agents/harness/hook-runtime/cli.mjs check && node .agents/harness/verify-gate/cli.mjs check && pnpm run lint` — Expected: PASS; `pnpm run lint` reports nothing under `.agents/harness/`.
- [ ] **Step 5: Commit** `.agents/`, `.claude/`, `opencode.json`, `eslint.config.js`, `.opencode/`, `tests/harness/` as `chore(agents): run verify on edit, tick and turn end via the agent harness`.
- [ ] **Step 6: Seed the pass**: `node .agents/harness/verify-gate/cli.mjs run` on the committed tree — Expected: exit 0; a second run prints nothing changed and exits 0 at once.

### Task 4: CI and docs

**Files:**
- Modify: `.github/workflows/ci.yml` (`check` job, after `pnpm install --frozen-lockfile`), `AGENTS.md` (`## Agent hooks`, the rung-0 row of the verification ladder if it names the hooks), `docs/ARCHITECTURE.md` (the **Agent hooks** bullet)
- Test: `tests/release/agent-policy.test.ts`

- [ ] **Step 1: Write the failing test** `it('checks both agent harness copies in the CI check job')`: the `check` job's steps include `run: node .agents/harness/hook-runtime/cli.mjs check` and `run: node .agents/harness/verify-gate/cli.mjs check`, both after the `pnpm install` step (parse `ci.yml` with the `yaml` devDependency, as the secret-scanning test reads it). Run `pnpm exec vitest run tests/release/agent-policy.test.ts` — Expected: FAIL.
- [ ] **Step 2: Add the two steps** (`Check the agent harness hook runtime copy and settings`, `Check the agent harness verify gate copy and settings`, the veles names). Run the test — Expected: PASS.
- [ ] **Step 3: Rewrite the docs.** `AGENTS.md` Agent hooks: one line "The verify command is `node scripts/verify-changed.mjs`, run by the copied tools in `.agents/harness/` (never edit them; `update` brings new versions)"; the three triggers (edit lints only that TypeScript file with `eslint --fix`; tick and turn end run the rung-0 checks; a failing turn end blocks up to three times; no-change turn ends run nothing); `node .agents/harness/verify-gate/cli.mjs run` by hand; the session-context hook; read `.claude/settings.json`, `opencode.json`, `.agents/harness.json` and `.agents/harness/` before starting an agent in an untrusted clone. Same facts in the ARCHITECTURE bullet, plus `tests/harness/*` and the CI `check` steps.
- [ ] **Step 4: Edited-copy proof**: `cp -r` the repo (without `node_modules`) to a scratch dir, append a byte to `.agents/harness/verify-gate/handler.mjs` there, run both `check` commands there — Expected: the gate's `check` exits 1 naming `handler.mjs`; record the output for the PR. Also, in the real repo, touch nothing under `.agents/harness/` and run `pnpm run verify:changed` with a changed `.agents/harness.json` — Expected: exit 0.
- [ ] **Step 5: Run** `pnpm exec vitest run tests/release && pnpm run lint` — Expected: PASS. Commit `docs(agents): describe the verify gate wiring`.

### Task 5: Live runs, overhead and the feature comparison

No code. Results go into `verify.md` and the PR body.

- [ ] **Step 1: OpenCode first.** Throwaway clone of the branch with `origin/main` moved to the onboarding commit, `pnpm install --frozen-lockfile`, `AGENT_HARNESS_TRACE=1`, a private `opencode serve` (`--server`, `OPENCODE_PASSWORD` set); never `opencode run --standalone`. Drive: (a) edit a `.ts` file to add an unused variable → the error appears once in that edit's tool result; (b) tick a task in a scratch `openspec/changes/live-run/tasks.md` while the lint error stands → the tick notice; (c) end the turn → blocked with the failure; (d) fix → the turn end passes; (e) another turn with no change → `no-change` in `trace.jsonl`. Record `opencode --version`, `node .agents/harness/hook-runtime/cli.mjs capabilities`, both turn-end outputs.
- [ ] **Step 2: Claude Code**: the same sequence in a fresh throwaway clone (`claude -p` with the project settings, or an interactive session); record `claude --version` and the same outputs; no `hook … failed` or `was not loaded` notice on either host.
- [ ] **Step 3: Overhead**: from both `trace.jsonl` files, the median time per hook process and per no-change turn end, before (old hooks, on `origin/main`) and after. Reported, not blocking.
- [ ] **Step 4: Feature comparison** against the old hooks: single-file TS lint, `--fix`, 20-line cap, errors only, exclusions, silent ESLint failure, OpenCode `patch` multi-file edits (now one run per file), session context on both hosts and none for subagents. Report each loss to the owner and get a decision before the PR is marked ready.
- [ ] **Step 5: Gate**: `pnpm run verify` — Expected: PASS. Push, open the PR as a draft with each acceptance criterion and its evidence.
