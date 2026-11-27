## Design Summary

Fast-forward session; the task issue (raidenyn/agentic-development-skills#15, with its 2026-11-26 reconciliation
comment) and the agent harness RFC are the requirements. Open points were settled against the veles-android onboarding
(raidenyn/veles-android#197, change `2026-11-25-onboard-agent-harness-verify-gate`) instead of asking.

line-mcp gets the two harness tools from the published catalog (v0.7.0: hook runtime 0.1.4, verify gate 0.2.3, which
add edit pass output and `editFiles`): `agent-harness-hook-runtime` copied to `.agents/harness/hook-runtime/` and
`agent-harness-verify-gate` to `.agents/harness/verify-gate/`, with `.agents/harness/lock.json` and
`.agents/harness.json`. The one verify command is `["node", "scripts/verify-changed.mjs"]`.

- **Edit trigger** (`VERIFY_TRIGGER=edit`, `VERIFY_FILE`): `verify-changed.mjs` lints only that file, with the exact
  behaviour of today's `.claude/hooks/lint-on-edit.mjs` (TypeScript files only, `eslint --fix`, errors only, at most
  20 lines, the `--fix` rewrite note, silent pass on an ESLint crash or timeout, skips `dist/`, `node_modules/`,
  `assets/ltsm/`). Errors exit 1 so the gate appends them to the tool result. Any other file exits 0 at once.
- **Task and turn-end triggers**, and a plain `pnpm run verify:changed`: today's `verify-changed.mjs` path, unchanged
  (its own `origin/main` merge-base, its "no changed files" shortcut, lint of changed files, `tsc -b` when package
  sources changed, `vitest --changed`).
- **Old hooks:** the `PostToolUse` lint entry in `.claude/settings.json` and the lint branch of the OpenCode plugin
  are removed, so a lint error reaches the model once. `lint-on-edit.mjs` is folded into a library the command uses.
- **Session context stays:** `SessionStart` holds the `session-context.mjs` entry and after it the runtime's entry
  (the veles pattern: the repo's own entry first, then the runtime's). `.opencode/plugin/line-mcp-harness.ts` keeps only
  its context hook. `opencode.json` is created by the runtime's `install` and lists only the runtime plugin.
- **CI:** both tools' `check` in the `check` job, which already sets up Node. `eslint .` ignores `.agents/harness/**`
  (copied files must never be edited, so they cannot be fixed to the repo's lint rules).
- **Docs:** `AGENTS.md` Agent hooks section (one line naming the verify command and `.agents/harness/`) and the Agent
  hooks bullet of `docs/ARCHITECTURE.md`.

## Alternatives Considered

### Alternative A: `pnpm run verify:changed` as the command
- **Approach**: `command: ["pnpm", "run", "verify:changed"]`.
- **Pros**: names the documented rung 0 of the verification ladder.
- **Cons**: adds pnpm start-up to every edit (the issue already reports ~0.2 s per hook process, and the command runs on
  every edit); pnpm becomes a parent in the gate's process group with nothing gained.
- **Why not chosen**: the script is the same code without the extra process; `verify:changed` still calls it.

### Alternative B: a new `scripts/verify-gate.mjs` wrapper, as veles did (`scripts/verify_gate.py`)
- **Approach**: a separate gate script that branches on `VERIFY_TRIGGER`, lints on `edit` and calls
  `verify-changed.mjs` otherwise.
- **Pros**: leaves `verify-changed.mjs` untouched; mirrors veles's file layout.
- **Cons**: a second entry point for the same rung. Veles needed a wrapper because its gate logic (remembered passes,
  branch pass, lock wait) lived inside `verify.py` and had to be called in process; line-mcp's `verify-changed.mjs`
  already is the fast rung and has no such state.
- **Why not chosen**: the issue asks to "make it lint only the edited file when the trigger is a file edit", which is a
  branch inside the one command, not a second script.

### Alternative C: plain lint of the edited file, no `--fix`
- **Approach**: on `edit`, `eslint <file>` without `--fix`, so the hook never rewrites the file.
- **Pros**: the gate only shows output on failure, so a silent rewrite cannot happen.
- **Cons**: drops autofix, a feature the old hook has. The owner wants every existing feature kept
  (veles#197: "I want all the existing features keep working").
- **Why not chosen**: a loss of an existing feature without the owner's say.

## Agreed Approach

Install from the catalog and follow both Onboard sections, with `node scripts/verify-changed.mjs` as the one command and
an `edit` branch inside it that reuses today's lint-on-edit logic (move the module to `scripts/`, keep its tests). This
keeps every feature of the old edit hook, including the `--fix` note on a clean run (through the gate's edit pass
output, catalog v0.7.0), keeps the
task and turn-end checks exactly as they are, and keeps the session-context hook on both hosts.

## Key Decisions

- **Command is the script, not the package script** (open choice in the issue): Alternative A rejected above.
- **Session-context wiring** (open choice): its own entry before the runtime's on `SessionStart`; the OpenCode plugin
  keeps only its context hook. Same pattern veles used for its rule engine next to the runtime.
- **`verify-changed.mjs` keeps its own narrowing** (reconciliation comment): it does not switch to `VERIFY_BASE` or
  `VERIFY_CHANGED_FILES`; what it checks at task and turn end is out of scope.
- **Edit lint stays TypeScript-only**, as the old hook; the turn-end path still lints changed JS too.
- **ESLint ignores `.agents/harness/**`**: the copied `.mjs` files use Node globals the repo's flat config does not
  declare, and they may never be edited.
- **`timeoutSeconds`**: the default 900, far above the ~19 s measured rung 0 with changes plus a `tsc -b`.
- **`base`**: `origin/main`; **`taskFiles`**: the default `openspec/changes/*/tasks.md`.
- **CI placement**: the existing `check` job (sets up Node and pnpm), not a new job.
- **Live runs** follow veles: throwaway clones with `origin/main` moved to the onboarding commit; OpenCode through a
  private `opencode serve` (`OPENCODE_PASSWORD`), never `opencode run --standalone`, OpenCode first.
- **Hook overhead** is measured and reported, not a blocker (owner, 2026-11-26).
- **husky and commitlint stay** (milestone M3).

## Open Questions

- **The `--fix` note on a clean run** (resolved 2026-11-27). The verify gate 0.2.2 and later hands the output of a
  passing edit run to the model (agentic-development-skills#58), so on a clean rewrite the edit branch exits 0 and
  prints only the note. The edit branch stays silent on a clean file. `editFiles` (agentic-development-skills#60)
  is set to the TypeScript globs, so an edit of any other file starts no verify process.
- The runtime's `install` writes `opencode.json` with only `plugins`, no `$schema`; acceptable as the runtime's own
  output, which is never edited by hand.
