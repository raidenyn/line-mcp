## Why

Every T3 Code or `claude --worktree` thread gets a fresh checkout that needs a
full `npm ci`: about 15 s and 261 MB of `node_modules` per worktree, even with
a warm npm cache. pnpm hardlinks one shared store into every worktree. In the
dev container that install takes under 1 s and 22 MB, so agents start working
almost immediately. The strict layout also exposes undeclared dependencies.

## What Changes

**Package manager**
- From: npm workspaces (`workspaces` in `package.json`, `package-lock.json`).
- To: pnpm workspaces (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, pnpm pinned
  through `packageManager`); `package-lock.json` is removed.
- Reason: per-worktree install speed and disk use.
- Impact: contributors and agents need pnpm installed (non-breaking for users
  of the Docker images).

**Internal dependency ranges**
- From: `"@raidenyn/<pkg>": "^0.1.0"`.
- To: `"@raidenyn/<pkg>": "workspace:^"`, and the root declares every
  workspace package its tests import.
- Reason: pnpm must link workspace packages, not resolve them from the registry.

**Dependency build scripts**
- From: npm runs every install script.
- To: only allowlisted packages (`better-sqlite3`) run build scripts.

**Commands, CI, release, Docker, hooks, agent policy, docs**
- `npm ci`/`npm run`/`npx` become `pnpm install --frozen-lockfile`/`pnpm run`/
  `pnpm exec` in `package.json` scripts, `scripts/verify-changed.mjs`, the
  Husky hook, the lint-on-edit hook, `.claude/settings.json`, all CI jobs, the
  release `plan` job, the Dockerfile builder, and the docs.
- The happy-dom vendoring prepack script resolves through real paths so that
  it works under the pnpm layout.
- The packed line-client artifact test keeps using npm to pack and install
  the tarball as an external consumer would.

## Capabilities

### New Capabilities
- `workspace-package-management`: how the repository installs, locks and links
  dependencies — pnpm pinned version, frozen lockfile installs, workspace
  protocol, build-script allowlist, declared dependencies, and use of the same
  manager in CI, release and Docker builds.

### Modified Capabilities
- None. `release-pipeline` and `docker-image-publishing` requirements do not
  change; only their implementation commands do.

## Impact

- Root and all six package manifests; new `pnpm-workspace.yaml` and
  `pnpm-lock.yaml`; `package-lock.json` deleted.
- `.github/workflows/ci.yml` (5 jobs), `.github/workflows/release.yml`.
- `Dockerfile` (builder stage), `.gitignore`.
- `scripts/verify-changed.mjs`, `.husky/commit-msg`,
  `.claude/hooks/lint-on-edit.mjs`, `.claude/settings.json`,
  `packages/line-client/scripts/vendor-happy-dom.js`.
- Tests: `tests/architecture/import-boundaries.test.ts`, `tests/release/*`
  (version baseline, verify entrypoint, release workflow, agent policy, commit
  policy), `tests/e2e.test.ts`, `tests/artifacts/line-client-pack.test.ts`
  comments.
- Docs: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`,
  `docs/RELEASING.md`.
