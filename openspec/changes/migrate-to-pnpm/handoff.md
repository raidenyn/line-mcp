# Handoff — migrate-to-pnpm

## Change

- Change id: `migrate-to-pnpm`
- Change folder: `openspec/changes/migrate-to-pnpm/`

## State

- Current task: none. All 13 tasks are complete. PR #162 waits on CI for the review-fix push, then goes ready for human review.
- Head commit: see `git log -1` on `build/migrate-to-pnpm` (review fixes in `0cc2c69`)
- Tasks: `13` of `13` complete

## Verified

Every command ran under `. ~/.cache/pnpm-env.sh`, which puts Node 24 first, sets `NODE_OPTIONS=--dns-result-order=ipv4first`, and has pnpm 12.18.0 on `PATH`.

- `pnpm run verify`: PASS (64 files, 976 tests).
- `pnpm exec vitest run --reporter=dot tests/artifacts/line-client-pack.test.ts`: PASS (7/7).
- `node scripts/check-peers.mjs`: `peer dependencies OK`.
- `node openspec/changes/migrate-to-pnpm/tools/lockfile-parity.mjs . ~/.cache/package-lock.baseline.json pnpm-lock.yaml`: matches design D2, plus the three deliberate importer edges.

## Remaining

- Wait for CI on the review-fix push, then mark #162 ready for human review.
- After merge: finalize (`finalize.md`) and archive the change. The archive syncs the new `workspace-package-management` spec.

## Risks

- macOS installs are unverified. `fsevents` is denied explicitly; add any other macOS-only build script to `allowBuilds` after review.
- Existing worktrees must run `rm -rf node_modules packages/*/node_modules && pnpm install` once after merge (documented in AGENTS.md).
