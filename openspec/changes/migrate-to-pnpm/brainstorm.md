## Design Summary

Replace npm with pnpm as the repository's package manager for local work, agent
hooks, CI, the release workflow and the Docker builder. The owner's motivation
is speed in worktrees: T3 Code and `claude --worktree` create a fresh checkout
per thread, and each one currently needs a full `npm ci`. pnpm keeps one
content-addressed store per machine and hardlinks it into every worktree.

Measured in the dev container (overlay filesystem, worktrees and the pnpm store
on the same filesystem, pnpm 12.23.0, npm 11.20, 6 cores):

| Scenario | Time | Worktree `node_modules` |
| --- | --- | --- |
| `npm ci`, warm `~/.npm` cache (two runs) | 14.3 s / 16.6 s | 261 MB |
| `pnpm install`, empty store (one-time) | 11.8 s | 235 MB shared store |
| `pnpm install --frozen-lockfile`, warm store (three fresh copies) | 0.78 / 0.82 / 0.94 s | 22 MB |

Build, lint and test wall time are unchanged (same tools). The native
`better-sqlite3` addon is built once and reused from pnpm's side-effects cache.

A bench copy migrated to pnpm passed build, lint, the unit, architecture,
harness and smoke suites, and the packed line-client artifact test, after these
fixes, which are the core of this change:

1. Internal `@raidenyn/*` dependencies use `^0.1.0`; pnpm resolves them from the
   public registry (404). They become `workspace:^`.
2. Root tests import `@raidenyn/line-mcp` and `@raidenyn/server`, which the root
   manifest does not declare (npm hoisting hid this). The root declares the
   missing workspace packages as dev dependencies.
3. `packages/line-client/scripts/vendor-happy-dom.js` walks `node_modules`
   from symlink paths, so under pnpm it cannot find happy-dom's own
   dependencies. Resolving through `fs.realpathSync` fixes it. Keeping
   happy-dom as a pnpm symlink is not an option: `npm pack` crashes
   ("Exit handler never called!") on a symlinked bundled dependency, so the
   script keeps materializing real copies.
4. pnpm blocks dependency build scripts by default; `better-sqlite3` must be
   allowed explicitly.
5. Tests that pin npm-specific text (`package-lock.json`, `npm ci`, `npx`, the
   `^0.1.0` ranges) change with the tooling.

Nine `oauth-router.test.ts` "non-root basePath" failures (ECONNREFUSED) occur
identically under npm in this container and are unrelated.

## Alternatives Considered

### Alternative A: Stay on npm and tune it
- **Approach**: keep npm; rely on the warm `~/.npm` cache, `--prefer-offline`,
  or copy `node_modules` from the main checkout into new worktrees.
- **Pros**: no migration; no new tool.
- **Cons**: `npm ci` with a warm cache is still ~15 s and 261 MB per worktree;
  copying `node_modules` is fragile (native addon, workspace symlinks, stale
  trees) and lives outside the repository.
- **Why not chosen**: does not remove the per-worktree install cost the owner
  wants gone.

### Alternative B: pnpm with `node-linker=hoisted`
- **Approach**: pnpm with an npm-like flat `node_modules`.
- **Pros**: least breakage; phantom dependencies keep working; `npm pack`
  sees real directories.
- **Cons**: hoisted mode copies or hardlinks a full flat tree per worktree,
  losing much of the speed and disk win; keeps hiding undeclared
  dependencies.
- **Why not chosen**: the strict isolated layout already works after small,
  well-understood fixes and gives the full benefit.

### Alternative C: Yarn (Berry) or Bun
- **Approach**: switch to Yarn PnP or Bun's installer.
- **Pros**: both are fast.
- **Cons**: Yarn PnP breaks tools that expect `node_modules` (tsc project
  references, vitest, eslint resolution) without extra plugins; Bun's install
  is fast, but it is a second runtime the Docker images and CI do not use.
- **Why not chosen**: more risk for no gain over pnpm for this repository.

## Agreed Approach

pnpm with the default isolated `node_modules` layout (owner request; the
benchmark confirmed the gain). npm is still used where it simulates an external
consumer: the packed line-client artifact test keeps `npm pack` and
`npm install` of the tarball.

## Key Decisions

- Pin pnpm exactly through `packageManager` in the root `package.json`. Use
  12.18.0, the newest 12.x release more than two weeks old on 2026-11-24.
- Configuration lives in `pnpm-workspace.yaml` (`packages`, `allowBuilds`).
- Internal dependencies use `workspace:^`. Package versions stay at `0.1.0`,
  and nothing is published, so publish-time rewriting never applies.
- CI installs pnpm with `pnpm/action-setup@v6` (it reads `packageManager`) and
  caches through `actions/setup-node` with `cache: pnpm`.
- The Docker builder installs the pinned pnpm with `npm install -g`, not
  corepack, because corepack is not bundled from Node 25 on, and a test keeps
  that pin equal to `packageManager`.
- Docker production pruning keeps today's shape (one pruned tree for both
  targets). A per-target `pnpm deploy` is out of scope.
- `npm publish` stays denied, and `pnpm publish` is denied alongside it.

## Open Questions

None blocking. Installing pnpm in the dev-container image is outside this
repository; the docs tell contributors how to get the pinned version.
