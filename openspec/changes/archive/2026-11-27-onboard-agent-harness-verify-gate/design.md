## Context

line-mcp's agent hooks before this change: a Claude Code `PostToolUse` hook and an OpenCode `tool.execute.after`
branch ran `.claude/hooks/lint-on-edit.mjs` on every TypeScript edit, and a session-context hook ran on both hosts.
Nothing ran verification on a ticked task or at turn end. Task raidenyn/agentic-development-skills#15 (agent harness
RFC, milestone M1) replaces the lint hooks with the published `agent-harness-hook-runtime` and
`agent-harness-verify-gate`, and keeps the session-context hook. Copied tool files are never edited in this repo; a
defect in them is fixed upstream and brought in with `update`.

## Goals / Non-Goals

**Goals:**
- One verify command, `node scripts/verify-changed.mjs`, on the edit, task and turn-end triggers, on both hosts.
- Keep every feature of the old edit hook, including the "ESLint --fix rewrote" note on a clean rewrite.
- An edit of a file the edit lint does not cover starts no process (`editFiles`).
- Both tools' `check` in CI.

**Non-Goals:**
- Changing what `verify-changed.mjs` checks at a ticked task or at turn end.
- husky and commitlint (milestone M3); rule delivery and gates (milestone M2).
- Any change to the copied tools.

## Decisions

### D1 — The script is the command
`["node", "scripts/verify-changed.mjs"]`, not `pnpm run verify:changed`: the same code without pnpm start-up on every
edit. Rejected: the package script (extra process on each edit).

### D2 — An edit branch inside the one command
With `VERIFY_TRIGGER=edit`, `verify-changed.mjs` lints only `VERIFY_FILE` through `scripts/lint-file.mjs`, the old
lint-on-edit logic moved into a library (`--fix`, errors only, 20-line cap, the same exclusions, silent on an ESLint
crash). Errors exit 1; a clean `--fix` rewrite exits 0 and prints only the note, which the gate hands to the model as
edit pass output. Every other trigger takes the existing path. Rejected: a separate gate wrapper script (a second entry
point for the same rung), and lint without `--fix` (drops an existing feature).

### D3 — `editFiles` is the TypeScript globs
`**/*.ts`, `**/*.mts`, `**/*.cts`, matching the old hook, so Markdown and other edits are traced `edit-skipped`.

### D4 — Session context stays as its own hook
Its `SessionStart` entry runs before the runtime's on Claude Code; the OpenCode plugin keeps only its context hook.

### D5 — CI and lint
Both `check` commands in the existing `check` job after `pnpm install`; `eslint .` ignores `.agents/harness/**`,
because copied files cannot be changed to fit the repo's lint rules.

## Risks / Trade-offs

- [Runtime defect blocks a host] → found on OpenCode 2.4.1 (`input.path` not mapped); fixed upstream in
  raidenyn/agentic-development-skills#72 and taken with `update` to catalog v0.8.0, never patched locally.
- [Hook overhead on every tool call] → measured and reported (about 210 ms per Claude Code hook process on v0.7.0;
  v0.8.0 skips tool kinds no handler needs). Not a blocker by the owner's decision of 2026-11-26.
- [Claude Code shows one Stop block twice] → host behaviour; reported only.

## Migration Plan

Merge the PR. Contributors restart OpenCode to load the runtime plugin. Rollback: revert the PR, which restores the
old hooks; or remove the tools with their `remove` commands.

## Open Questions

None. The `--fix` note on a clean run was settled by the gate's edit pass output (verify gate 0.2.2 and later).
