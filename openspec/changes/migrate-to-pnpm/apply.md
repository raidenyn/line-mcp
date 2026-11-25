# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `migrate-to-pnpm`
**Iteration**: `1`
**Applied at**: `2026-11-25 02:15` (UTC)
**Executor**: `executing-plans` (inline, by the session agent, with manual red/green per task; see Notes)

---

## Workspace

- **Worktree**: host-owned T3 Code worktree (`/home/dev/.t3/worktrees/line-mcp/t3-be268b2b-ca09bdca2d5060f9`), implemented in place per AGENTS.md
- **Branch**: `build/migrate-to-pnpm`

---

## Commits

- **Range**: `d354576..cde5d43` (implementation; planning commits `e8f8f21..d354576` precede it)
- **Count**: `7`

---

## Tasks

- **Completed**: `12 of 13` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: `9.1`. The local part is done (see Results). The task finishes when the draft PR is open and CI's `docker` job is green (design D14).

---

## Next step

Run `openspec-verify-change`, get an independent review of `git diff origin/main...HEAD`, push, and open the draft PR. Its description must state the Docker-gate exception. Mark 9.1 done once every CI job, including `docker`, is green.

---

## Notes

### Environment (design D14)

- Node `v24.22.3` from the official tarball in `~/.cache/node24`, with npm `11.19.1`. The container default is Node 26.
- pnpm `12.18.0`, installed with `npm install -g pnpm@12.18.0 --prefix ~/.local`.
- `NODE_OPTIONS=--dns-result-order=ipv4first`. Without it, this container's `/etc/hosts` makes `listen(0, 'localhost')` bind `::1` while the oauth-router tests connect to `127.0.0.1`, so they fail identically under npm. CI is unaffected.
- No Docker daemon is available. The owner approved on 2026-11-25 that CI's `docker` job is the Docker rung for this change.

### Baseline (task 1.1)

`npm ci && npm run build && vitest run --reporter=dot packages tests/architecture tests/release tests/harness tests/smoke`: 60 files, 962 tests passed.

### Lockfile parity (task 2.2, design D2)

Run 1, after `pnpm import` and before the deliberate additions, was exactly the D2 result:
- importer edges: 0 differences;
- inventory only-npm: `ansi-regex@6.2.2` and `content-type@2.0.0`;
- package edges differing (70):
  - the four accepted dedupes: `@octokit/request@10.0.11` and `type-is@2.1.0` → `content-type` 2.0.0 → 2.1.0; `marked-terminal@7.3.0` and `strip-ansi@7.2.0` → `ansi-regex` 6.2.2 → 6.6.0;
  - the optional-peer link `debug@4.4.3 → supports-color@7.2.0`;
  - 65 bundled edges under `npm@11.18.0`.

Run 2 was on the lockfile that ships, after the deliberate additions and the install from a clean tree. It showed the same inventory and package edges, plus exactly these importer edges:
- `. @raidenyn/line-mcp: npm=- pnpm=link:packages/line-mcp`
- `. @raidenyn/server: npm=- pnpm=link:packages/server`
- `packages/server better-sqlite3: npm=- pnpm=12.11.1`

After the npm trees were deleted and pnpm installed: `node_modules/.package-lock.json`, `node_modules/debug` and `node_modules/@raidenyn/bank-mcp` are all absent.

### Results

- Task 2.1 red run: assertion failures only, with no collection error. They named the pin, the lockfile, the workspace file, the ranges and `server`'s undeclared `better-sqlite3`.
- Task 2.3: a fresh `git archive` export ran `pnpm install --frozen-lockfile` in 0.87 s (warm store). The build passed, and the in-memory SQLite query returned 1. The npm baseline for a new worktree was 14–17 s.
- Task 4.1: both packs passed (7/7 each). `happy-dom` was a symlink again before the second pack, and the store's happy-dom checksum was unchanged.
- Task 6.1: `node scripts/check-peers.mjs` printed `peer dependencies OK`.
- Task 7.1: there is no daemon, so the Docker cases skip locally. A simulation on disk mirrored the builder stage (frozen install, build, `pnpm prune --prod`, strip steps) and both runtime copies:
  - no dangling links in either image;
  - no `typescript@`, `vitest@`, `eslint@`, `semantic-release@` or `@commitlint+` entries in `.pnpm`;
  - nothing in the standalone copy that is or links to `bank-mcp` or `server`;
  - `better-sqlite3` loads in the standalone copy;
  - both CLIs answer `/healthz` with `{"status":"ok"}`.
- Task 8.1: the npm sweep passes with the test file staged, and fails on an injected `npm run build` line in README.md.
- Task 9.1 (local): `pnpm run verify` passed (lint, `tsc -b`, `openspec validate --all --strict`, 63 files / 974 tests). `pnpm exec vitest run --reporter=dot tests/artifacts/line-client-pack.test.ts` passed 7/7. Total wall time 1 m 16 s.

### Executor deviation

The schema recommends subagent-driven-development, with one subagent per task. The session ran the plan inline instead (executing-plans), because the host's instructions are not to spawn agents unless the user asks. TDD was followed manually: each task's guard or test was made red first. AGENTS.md's independent review runs before the PR is marked ready.
