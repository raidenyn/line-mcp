# Handoff — ledger-status-and-sources

## Change

- Change id: `ledger-status-and-sources`
- Change folder: `openspec/changes/ledger-status-and-sources/`
- Task: https://github.com/raidenyn/line-mcp/issues/132 (key `expense-ledger/m1-ledger/2`)

## State

- Current task: implementation complete and reviewed — all 13 tasks ticked; draft PR #168, review findings fixed, ready for human review next
- Head commit: see `git log` on `feat/132-set-up-the-ledger-and-report-its-status`
- Tasks: 13 of 13 complete
- Review: PR #168 draft; independent review posted eight inline findings (1 blocking, 3 important, 4 minor). All fixed in iteration 2; gate rerun.
- Size: 2,885 insertions / 56 deletions across 40 files (`git diff --stat origin/main...HEAD -- . ':!pnpm-lock.yaml' ':!openspec'`), against the raised accepted size of ~3,100 lines (see `proposal.md` § Size)

## Verified

- `pnpm exec openspec validate ledger-status-and-sources --strict` — valid
- Design: five independent Opus (medium) review rounds, every finding folded in.
- Plan: three independent Opus (medium) review rounds; round 3 APPROVE, its four minor findings folded in.
- Whole change, second series: two more Opus (medium) rounds; round 1 one important finding (stale-count grep hit the frozen `docs/superpowers/` archive) and six minor, round 2 APPROVE with five minor; all folded in.
- `pnpm exec vitest run tests/release/openspec-tasks.test.ts` — 6/6 pass
- Implementation, targeted suites: validation 16/16, ledger store + request hash 30/30, envelope 4/4, ledger tools + register-tools 27/27, `packages/server` 80/80, import boundaries 30/30, startup 9/9, ledger isolation 3/3
- `pnpm run test:smoke` — 88/88 (compiled CLIs; the ledger tools make no LINE call)
- `pnpm run verify:all` — PASS (twice, before and after the review fixes): 1,132 in-process tests, Docker smoke 8/8, packed line-client artifact 7/7. The Docker images were rebuilt, so the twelve-tool Docker assertion ran against this code.
- Local environment note: this container's `localhost` binds to `::1` while Node's fetch dials `127.0.0.1`, so the untouched `packages/line-mcp/src/auth/oauth-router.test.ts` "non-root basePath" suite fails without `NODE_OPTIONS=--dns-result-order=ipv4first`. The gate run used that variable; it changes no repository file. The first retry also hit one timing-sensitive `regex-executor.test.ts` flake; the clean second run passed. Proposed follow-up: make that oauth test bind an explicit loopback address.

## Remaining

- Commit the docs/gate task, push, open the draft PR with `Closes raidenyn/line-mcp#132` and the report the task asks for.
- Independent review (fresh context: spec + `git diff origin/main...HEAD`), fold findings, then mark ready for human review.
- Finalize: `openspec-continue-change` (finalize) with Outcome `pr-updated` and Cleanup `preserved (harness-owned)` in this host worktree, then archive.

## Risks

- Size: actual 2,885 insertions / 56 deletions / 40 files, ~3.4× the task estimate. The 2.2 checkpoint (2,329 lines) was reported; **the owner chose one pull request and raised the accepted size to ~3,100 lines on 2026-11-27** (see `proposal.md` § Size).
- Timezone placement (owner default + optional per-source value) is the implementer's call; flagged to the owner for confirmation at PR review.
- The pre-PR gate is `pnpm run verify:all` (Dockerfile/compose comments change; it rebuilds both images). Without a Docker daemon, record that the Docker rung did not run.
