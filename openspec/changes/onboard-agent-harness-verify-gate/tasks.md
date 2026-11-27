## 1. The command

- [x] 1.1 Move the lint logic of `.claude/hooks/lint-on-edit.mjs` (`lintTarget`, `formatErrors`, `lintFile`, `fixedNote`, `MAX_LINES`) into `scripts/lint-file.mjs`, taking a repo-relative path instead of a hook payload, and move its tests to `tests/harness/lint-file.test.ts` with the same cases (target selection, formatting, the 20-line cap, exit codes, the `--fix` note, a clean file).
  Verify: `pnpm exec vitest run tests/harness/lint-file.test.ts`
- [x] 1.2 Add the `edit` branch to `scripts/verify-changed.mjs`: with `VERIFY_TRIGGER=edit` it lints only `VERIFY_FILE` through `scripts/lint-file.mjs` (exit 1 with the errors and any `--fix` note, 0 with only the note after a clean rewrite, 0 and silent otherwise, 0 at once for a file it does not own); every other trigger, and no trigger, keeps today's path. Add tests that spawn the script with both triggers.
  Verify: `pnpm exec vitest run tests/harness/lint-file.test.ts tests/release/verify-entrypoint.test.ts`

## 2. Install from the published catalog

- [x] 2.1 Run `install --repo .` of `agent-harness-hook-runtime` 0.7.0 and then of `agent-harness-verify-gate` 0.7.0 from the catalog skill folders, and set `verify-gate` in `.agents/harness.json` to `command: ["node", "scripts/verify-changed.mjs"]`, `base: "origin/main"`, `taskFiles: ["openspec/changes/*/tasks.md"]`, `editFiles: ["**/*.ts", "**/*.mts", "**/*.cts"]`.
  Verify: `node .agents/harness/hook-runtime/cli.mjs check && node .agents/harness/verify-gate/cli.mjs check`
- [x] 2.2 Remove the `PostToolUse` lint entry from `.claude/settings.json` (keeping the `SessionStart` session-context entry before the runtime's), delete `.claude/hooks/lint-on-edit.mjs`, and add `.agents/harness/**` to the ESLint ignores.
  Verify: `pnpm run lint && pnpm exec vitest run tests/release`
- [x] 2.3 Remove the lint branch from `.opencode/harness/hooks.ts` (edit-path parsing, `appendText`, `additionalContext`, the `execute.after` hook) so the plugin keeps only the context hook, and drop the plugin tests of the removed branch.
  Verify: `pnpm exec vitest run tests/harness`
- [x] 2.4 Run `node .agents/harness/verify-gate/cli.mjs run` once on the committed tree; it must pass and seed the no-change shortcut.
  Verify: `node .agents/harness/verify-gate/cli.mjs run`
- [x] 2.5 Run `update --repo .` of both tools from catalog v0.8.0 (hook runtime 0.1.6, verify gate 0.2.4), which maps OpenCode's native `write` and `edit` by `input.path` (raidenyn/agentic-development-skills#72).
  Verify: `node .agents/harness/hook-runtime/cli.mjs check`

## 3. CI and docs

- [x] 3.1 Add both tools' `check` to the CI `check` job after `pnpm install`.
  Verify: `node .agents/harness/hook-runtime/cli.mjs check && node .agents/harness/verify-gate/cli.mjs check`
- [x] 3.2 Rewrite the Agent hooks section of `AGENTS.md` (one line naming `node scripts/verify-changed.mjs` and `.agents/harness/`, the edit, tick and turn-end triggers, the session-context hook, and the untrusted-clone warning) and the Agent hooks bullet of `docs/ARCHITECTURE.md`.
  Verify: `pnpm exec vitest run tests/release`
- [x] 3.3 Prove `check` fails on an edited copy: in a throwaway copy of the repository, change one byte of a copied file and run both `check` commands; record the output.
  Verify: `node .agents/harness/verify-gate/cli.mjs check`

## 4. Live runs and the gate

- [x] 4.1 OpenCode first, through a private `opencode serve` in a throwaway clone with `origin/main` moved to the onboarding commit: a TypeScript edit with a lint error (reported once), a tick while a check fails, a blocked turn end, then a passing and a no-change turn end, with `AGENT_HARNESS_TRACE=1`; record the OpenCode version and the outputs.
  Verify: `node .agents/harness/hook-runtime/cli.mjs capabilities`
- [x] 4.2 Claude Code: the same sequence in a throwaway clone; record the Claude Code version and the outputs.
  Verify: `node .agents/harness/hook-runtime/cli.mjs capabilities`
- [ ] 4.3 Record hook overhead from `trace.jsonl` (per hook process and per no-change turn end), and compare every feature of the old lint and context hooks with the new wiring; report any loss to the owner before the PR is ready.
  Verify: `pnpm run verify`
