## Why

Agent hooks in line-mcp lint an edited TypeScript file and nothing else: no check runs when a task is ticked or a
turn ends, so an agent can stop while `verify:changed` fails. The agent harness RFC (raidenyn/agentic-development-skills,
milestone M1, task issue 15) replaces the hand-built lint hook with two copied tools from the published catalog, the
hook runtime and the verify gate, which run one repo command on a file edit, a ticked task and every turn end on Claude
Code and OpenCode, and skip a tree unchanged since the last full pass. line-mcp is the third and last onboarding of the
milestone, after agentic-development-skills and veles-android.

## What Changes

**Verify wiring**
- From: `.claude/settings.json` runs `.claude/hooks/lint-on-edit.mjs` on `PostToolUse` `Edit|Write|MultiEdit`; the
  OpenCode plugin `.opencode/plugin/line-mcp-harness.ts` runs the same script after its edit tools; nothing runs on a
  tick or at turn end.
- To: `.agents/harness/hook-runtime/` and `.agents/harness/verify-gate/` are installed from the catalog (lock in
  `.agents/harness/lock.json`, settings in `.agents/harness.json`). The runtime's `install` adds its entry to each
  Claude Code hook event and creates `opencode.json` with its plugin. The lint hook entry and the plugin's lint branch
  are removed.
- Reason: one command, three triggers, both hosts, from copied tools that `check` proves unedited.
- Impact: non-breaking for contributors; a lint error after an edit reaches the model once, as before.

**The command**
- `verify-gate.command` is `node scripts/verify-changed.mjs`. On `VERIFY_TRIGGER=edit` it lints only `VERIFY_FILE`,
  with today's lint-on-edit behaviour (moved from `.claude/hooks/` into `scripts/`). On a ticked task, at turn end and
  when run by hand it does exactly what `pnpm run verify:changed` does today.

**Kept as is**
- The session-context hook on both hosts (Claude Code `SessionStart` entry before the runtime's; the OpenCode plugin
  keeps only its context hook). husky and commitlint.

**Checks and CI**
- The CI `check` job runs both tools' `check`. `eslint .` ignores the copied `.agents/harness/**`.

## Capabilities

### New Capabilities

- `agent-verify-hooks`: Which command the agent hooks run on an edit, a ticked task and a turn end on Claude Code and
  OpenCode, how the edit trigger lints one file, the session-context hook next to it, and the CI proof that the copied
  tools are unedited.

### Modified Capabilities

None. No spec in `openspec/specs/` covers the agent hooks today.

## Impact

- `.agents/harness/`, `.agents/harness.json`, `.claude/settings.json`, `opencode.json` (written by the tools'
  `install`; the copied files are never edited by hand).
- `scripts/verify-changed.mjs`; `.claude/hooks/lint-on-edit.mjs` moves to `scripts/` as a library.
- `.opencode/harness/hooks.ts` (lint branch removed); `.opencode/plugin/line-mcp-harness.ts` unchanged.
- `tests/harness/lint-on-edit.test.ts`, `tests/harness/opencode-plugin.test.ts`, `tests/release/verify-entrypoint.test.ts`.
- `eslint.config.js`, `.github/workflows/ci.yml`, `AGENTS.md`, `docs/ARCHITECTURE.md`.
- No new dependencies. Unchanged: what `verify-changed.mjs` checks at a tick and at turn end, `session-context.mjs`,
  `verify`, `verify:all`, husky.
