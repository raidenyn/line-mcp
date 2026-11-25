# Handoff — migrate-to-pnpm

## Change

- Change id: `migrate-to-pnpm`
- Change folder: `openspec/changes/migrate-to-pnpm/`

## State

- Current task: `9.1`. The local gate is done. Next: verify, independent review, then a draft PR. The task finishes when every CI job, including `docker`, is green.
- Head commit: `cde5d43` on `build/migrate-to-pnpm`
- Tasks: `12` of `13` complete

## Verified

Every command ran under `. ~/.cache/pnpm-env.sh`, which puts Node 24 first, sets `NODE_OPTIONS=--dns-result-order=ipv4first`, and has pnpm 12.18.0 on `PATH`.

- `pnpm run verify`: PASS (63 files, 974 tests).
- `pnpm exec vitest run --reporter=dot tests/artifacts/line-client-pack.test.ts`: PASS (7/7).
- `node scripts/check-peers.mjs`: `peer dependencies OK`.
- `node openspec/changes/migrate-to-pnpm/tools/lockfile-parity.mjs . ~/.cache/package-lock.baseline.json pnpm-lock.yaml`: matches design D2, plus the three deliberate importer edges.

## Remaining

- `openspec-verify-change`, then an independent review (spec plus `git diff origin/main...HEAD` only).
- Push, then open a draft PR titled `build(deps): migrate the workspace to pnpm`. Its description states the owner-approved Docker-gate exception (design D14, 2026-11-25).
- Wait for CI. `check`, `smoke`, `pack-line-client`, `docker` and `commit-policy` must all be green.
- Post the review findings inline, fix them, mark the PR ready, then finalize and archive.

## Risks

- The Docker images have only been checked by an on-disk simulation. The first real `docker build` runs in CI; its `docker` job is the gate.
- macOS installs are unverified. `fsevents` is denied explicitly; add any other macOS-only build script to `allowBuilds` after review.
- Existing worktrees must run `rm -rf node_modules packages/*/node_modules && pnpm install` once after merge (documented in AGENTS.md).
