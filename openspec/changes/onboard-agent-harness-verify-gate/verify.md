# Verification: onboard the agent harness verify gate

Installed from catalog v0.7.0 (hook runtime 0.1.4, verify gate 0.2.3), then updated to v0.8.0 (hook runtime 0.1.6,
verify gate 0.2.4) for the OpenCode edit fix (raidenyn/agentic-development-skills#72). The live runs below are on
v0.8.0 unless marked. Hosts: OpenCode 2.4.1 (private `opencode serve`, default
model `opencode/seaglass-alpha-free`), Claude Code 2.1.332 (`claude -p --model sonnet`). Live runs used throwaway
clones of this branch with `origin/main` moved to the onboarding commit and `AGENT_HARNESS_TRACE=1`.

## Gate and checks

- `pnpm run verify`: 66 files, 1055 tests pass (with `NODE_OPTIONS=--dns-result-order=ipv4first`; without it the
  `localhost`-bound OAuth suite fails in this container, unrelated to this change).
- `node .agents/harness/verify-gate/cli.mjs run`: `verify: passed in 10156 ms.`, then `verify: no change since the last full pass.`
- `check` on a copy with one copied file per tool modified:
  ```
  hook-runtime: claude.mjs differs from the lock (edited copy)
  hook-runtime check exit=1
  verify-gate: handler.mjs differs from the lock (edited copy)
  verify-gate check exit=1
  ```

## Claude Code (done, v0.8.0)

Edit with a lint error, `PostToolUse:Write` context (once; no other hook lints):
```
verify: node scripts/verify-changed.mjs failed after the edit of tests/harness/live-run-broken.ts: exit code 1.

ESLint: 1 error(s) remain in tests/harness/live-run-broken.ts after --fix. Fix them now:
tests/harness/live-run-broken.ts:1:7 'liveRunUnused' is assigned a value but never used. (@typescript-eslint/no-unused-vars)
```
Edit that `--fix` cleans:
```
verify: node scripts/verify-changed.mjs passed after the edit of tests/harness/live-run-fixable.ts:

ESLint --fix rewrote tests/harness/live-run-fixable.ts; re-read it before editing it again.
```
Claude Code also adds its own "PostToolUse hook modified ... after your edit (likely a formatter)" line (seen on v0.7.0).

Tick while a check fails (`PostToolUse:Edit` context):
```
verify: a task was ticked while verification fails. Ticked: "1.1 Edit a TypeScript file" in openspec/changes/live-run/tasks.md. node scripts/verify-changed.mjs failed: exit code 1.
```
Turn end: `Stop hook feedback: verify: node scripts/verify-changed.mjs failed (attempt 1 of 3). Fix the failure before ending the turn: ...`;
the agent deleted the line and the next turn end passed. Claude Code shows that one `decision: block` to the model
twice (a "Stop hook feedback" user turn and a "Stop hook blocking error" system line, seen on v0.7.0); the runtime
writes it once. The session-context hook still printed the branch and the open OpenSpec changes.

Trace: Markdown edit `edit-skipped`; TypeScript edits and the tick `ran`; the `Read` before the tick
`skipped: no-subscriber` (about 130 ms for the whole process, new in v0.8.0); turn ends `ran` (blocked), `ran`
(pass), then `no-change` on the next turn (278 ms for the whole hook process).

## OpenCode (done, v0.8.0)

What the model received, from the tool results (`opencode run --format json`):
```
write | Created file successfully: tests/harness/live-run-broken.ts
verify: node scripts/verify-changed.mjs failed after the edit of tests/harness/live-run-broken.ts: exit code 1.

ESLint: 1 error(s) remain in tests/harness/live-run-broken.ts after --fix. Fix them now:
tests/harness/live-run-broken.ts:1:7 'liveRunUnused' is assigned a value but never used. (@typescript-eslint/no-unused-vars)

write | Created file successfully: tests/harness/live-run-fixable.ts
verify: node scripts/verify-changed.mjs passed after the edit of tests/harness/live-run-fixable.ts:

ESLint --fix rewrote tests/harness/live-run-fixable.ts; re-read it before editing it again.

write | Created file successfully: docs/live-run-note.md

edit | Edited openspec/changes/live-run/tasks.md (1 replacement)
verify: a task was ticked while verification fails. Ticked: "1.1 Edit a TypeScript file" in openspec/changes/live-run/tasks.md. node scripts/verify-changed.mjs failed: exit code 1.
```
- Turn end: `verify: node scripts/verify-changed.mjs failed (attempt 1 of 3). Fix the failure before ending the turn: ...`;
  the agent deleted the line, and the next turn end `ran` and passed. A third turn was `no-change` (155 ms in the
  server).
- Trace: the two TypeScript writes and the tick `ran` (1.9 to 2.5 s), the Markdown write `edit-skipped` (6 ms), the
  `read` with no outcome (0 ms).
- Bounded block (v0.7.0 run): blocked with `attempt 1 of 3`, `2 of 3`, `3 of 3`, then
  `verify: still failing after 3 blocks; continuing. ...`.
- On v0.7.0 the edit trigger did not run: OpenCode 2.4.1's native `write` and `edit` pass the file as `input.path`, and
  the runtime's adapter read only `input.filePath`, so every `write`/`edit` was traced `"verify-gate":"null"`. Fixed in
  the hook runtime 0.1.6 (raidenyn/agentic-development-skills#72, #71), taken here with `update`.

## Overhead (reported, not blocking)

Claude Code: a hook process with no gate work takes a median 210 ms (19 calls), two per tool call. An edit or tick
run takes 1.7 to 2.9 s (ESLint on one file, or the fast rung). The old hook ran only on edits (ESLint, similar cost).
