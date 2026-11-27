## Purpose

The agent hooks that run the repo's one verify command on a file edit, a ticked task and turn end, on Claude Code and OpenCode, through the copied agent harness tools, and the session-context hook that stays next to them.

## ADDED Requirements

### Requirement: Copied harness tools
The repository SHALL hold the agent harness hook runtime in `.agents/harness/hook-runtime/` and the verify gate in
`.agents/harness/verify-gate/`, installed from the published skills catalog, with one entry per tool in
`.agents/harness/lock.json` and one key per tool in `.agents/harness.json`. The copied files MUST NOT be edited in the
repository; a newer version comes in only through the tool's `update`.

#### Scenario: Lock matches the copy
- **WHEN** `node .agents/harness/hook-runtime/cli.mjs check` and `node .agents/harness/verify-gate/cli.mjs check` run on the onboarded repository
- **THEN** both exit 0

### Requirement: CI proves the copy unedited
The CI `check` job SHALL run both tools' `check` command, and `eslint .` MUST NOT lint `.agents/harness/`.

#### Scenario: Edited copy
- **WHEN** `check` runs on a copy of the repository in which one copied file under `.agents/harness/` was modified
- **THEN** it exits non-zero and names that file

#### Scenario: Copied files are not linted
- **WHEN** `pnpm run lint` runs
- **THEN** no file under `.agents/harness/` is linted

### Requirement: One verify command
`.agents/harness.json` SHALL set `verify-gate.command` to `["node", "scripts/verify-changed.mjs"]` and
`verify-gate.base` to `origin/main`, with task files matching `openspec/changes/*/tasks.md` and `verify-gate.editFiles`
set to the TypeScript files the edit lint covers (`**/*.ts`, `**/*.mts`, `**/*.cts`). Claude Code
(`.claude/settings.json`) and OpenCode (`opencode.json`) MUST both be wired to the hook runtime as its `install` writes
it.

#### Scenario: Same command on both hosts
- **WHEN** a session on Claude Code and a session on OpenCode each edit a file, tick a task and end a turn
- **THEN** each of the three triggers runs `node scripts/verify-changed.mjs` from the copied tools

### Requirement: Failures reach the model
When the verify command fails, the failure SHALL reach the model: appended to the tool result after an edit or a
tick, and as a turn-end block.

#### Scenario: Failing edit
- **WHEN** an agent on either host edits a TypeScript file so that it has an ESLint error
- **THEN** the error is appended to that edit's tool result

#### Scenario: Tick while a check fails
- **WHEN** an agent ticks a task in `openspec/changes/<name>/tasks.md` while `verify-changed.mjs` fails
- **THEN** the failure is appended to that tool result

#### Scenario: Blocked turn end
- **WHEN** a turn ends while `verify-changed.mjs` fails
- **THEN** the turn is blocked with the failure, and the agent continues

### Requirement: No rerun on an unchanged tree
A turn end MUST NOT run the verify command when the working tree and the gate config are unchanged since the last full
pass.

#### Scenario: No-change turn end
- **WHEN** a turn ends after a passing full run and nothing in the tree or the config changed
- **THEN** the command is not run

### Requirement: Edit trigger lints only the edited file
When `VERIFY_TRIGGER` is `edit`, `scripts/verify-changed.mjs` SHALL run `eslint --fix` on `VERIFY_FILE` alone and run
no build and no tests. It MUST lint only an in-repository `.ts`, `.cts` or `.mts` file outside `dist/`,
`node_modules/` and `packages/line-client/assets/ltsm/`, and exit 0 at once for any other file or an unset
`VERIFY_FILE`.

#### Scenario: Edit outside editFiles
- **WHEN** an agent on either host edits a Markdown file
- **THEN** the verify gate starts no verify process (traced as `edit-skipped`)

#### Scenario: Other file edited
- **WHEN** `VERIFY_TRIGGER=edit` and `VERIFY_FILE` is a Markdown file, a file under `dist/` or an LTSM asset
- **THEN** the command exits 0 without starting ESLint

#### Scenario: No full run on an edit
- **WHEN** `VERIFY_TRIGGER=edit` and `VERIFY_FILE` names a TypeScript file
- **THEN** the command neither builds nor runs tests

### Requirement: Edit lint output
On the edit trigger the command SHALL exit non-zero with at most 20 lines of the remaining ESLint errors (warnings are
not reported), followed by a note when `--fix` rewrote the file. When `--fix` rewrote the file and no error remains it
SHALL exit 0 and print only that note, which the gate hands to the model as edit pass output. It MUST exit 0 with no
output when the file was clean, and when ESLint itself fails or times out.

#### Scenario: Lint errors after an edit
- **WHEN** `VERIFY_FILE` names a TypeScript file with an error `--fix` cannot fix
- **THEN** the command exits non-zero and prints the error as `<file>:<line>:<column> <message> (<rule>)` under a header naming the file

#### Scenario: --fix cleans the file
- **WHEN** `VERIFY_FILE` names a TypeScript file whose only problems `--fix` fixes
- **THEN** the command exits 0 and prints `ESLint --fix rewrote <file>; re-read it before editing it again.`, which reaches the model

#### Scenario: ESLint cannot judge
- **WHEN** ESLint crashes or times out on the edited file
- **THEN** the command exits 0

### Requirement: One lint report per edit
No hook other than the verify gate SHALL lint an edited file, so the lint error of one edit reaches the model once.

#### Scenario: One report per edit
- **WHEN** an edit leaves an ESLint error, on either host
- **THEN** the model receives that error once

### Requirement: Task and turn-end checks are the fast rung
When `VERIFY_TRIGGER` is `task` or `turn-end`, or is unset (`pnpm run verify:changed`), `scripts/verify-changed.mjs`
SHALL behave as the repository's fast rung: compare against the merge-base with `origin/main` (else `main`, else
`HEAD` with a warning), exit 0 when nothing changed, lint the changed and untracked JS/TS files, rebuild with `tsc -b`
when package sources changed, then run the Vitest suites affected by the diff.

#### Scenario: Turn end with a lint error in a changed file
- **WHEN** a turn ends with an ESLint error in a changed file
- **THEN** the command exits non-zero with ESLint's output

#### Scenario: Nothing changed against the base
- **WHEN** the command runs with no changed or untracked files
- **THEN** it prints `verify:changed: no changed files` and exits 0

### Requirement: Session context stays next to the runtime
At session start both hosts SHALL still add the output of `.claude/hooks/session-context.mjs` to the agent's context.
On Claude Code, `SessionStart` MUST hold the session-context entry and after it the hook runtime's entry. On OpenCode,
`.opencode/plugin/line-mcp-harness.ts` MUST keep only the context hook, computed once per top-level session.

#### Scenario: Claude Code session start
- **WHEN** a Claude Code session starts in the repository
- **THEN** the session-context block is in the agent's context and the hook runtime's `SessionStart` entry runs too

#### Scenario: OpenCode edit
- **WHEN** an OpenCode agent edits a file
- **THEN** the repository's plugin appends nothing to the tool result; only the hook runtime does
