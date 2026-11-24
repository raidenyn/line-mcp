# Migrate to pnpm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace npm with pnpm 12.18.0 across manifests, scripts, hooks, agent policy, CI, release, Docker and docs, so a fresh worktree installs in about a second from the shared store.

**Architecture:** pnpm workspaces with the default isolated `node_modules` layout. Internal dependencies are linked with `workspace:^`. The lockfile is imported from `package-lock.json`, so versions do not move. A new release test, `tests/release/package-manager.test.ts`, guards the invariants. npm remains only where it simulates an external consumer: the packed line-client artifact test.

**Tech Stack:** pnpm 12.18.0, Node 24, TypeScript `tsc -b`, Vitest, GitHub Actions (`pnpm/action-setup@v6`, `actions/setup-node@v7`), Docker (`node:24` builder).

**Spec:** `openspec/changes/migrate-to-pnpm/specs/workspace-package-management/spec.md`, `design.md` (decisions D1–D13), `brainstorm.md` (benchmark, breakage inventory).

## Global Constraints

- pnpm version: exactly `12.18.0`, declared once as `"packageManager": "pnpm@12.18.0"`. The Dockerfile `ARG PNPM_VERSION=12.18.0` must equal it.
- Internal dependency range: `workspace:^`. Package versions stay `0.1.0`.
- Build-script allowlist: `better-sqlite3` only.
- Automated installs: `pnpm install --frozen-lockfile`; the release plan job adds `--ignore-scripts`.
- Never `npm publish` or `pnpm publish`. Never edit `packages/line-client/assets/ltsm/*`.
- Do not change dependency versions. `pnpm import` from the existing `package-lock.json` only.
- Commits use Conventional Commits; for this change use the `build` type with scope `deps`, `ci`, `harness` or `docker`, or `docs`.

## Review Focus

1. **Stale npm `node_modules` in an existing worktree.** `pnpm install` must replace it without leaving a mixed tree. Task 2 runs the install over the existing npm tree, not a clean clone.
2. **`npm pack` after a `pnpm install` that restored the happy-dom symlink.** `prepack` must re-vendor every time. Task 4 runs the pack test twice in a row, with `pnpm install` between the runs.
3. **The standalone Docker image under the strict layout.** It ships only four packages, so a dangling symlink to an excluded package would surface only at runtime. Task 7 runs the Docker smoke against both targets, and an `ls -L` check catches broken links in the standalone image.
4. **Agent commands written the old way** (`npx vitest run tests/e2e.test.ts`). They must still ask, not auto-run. Task 5 asserts the npm/npx e2e ask rules remain.
5. **A dependency later added with an install script.** The install must fail loudly, not skip silently. Task 2 asserts that `allowBuilds` exists and contains only the allowlisted packages, so a reviewer sees each addition.

---

### Task 1: Tooling prerequisite

**Files:** none (environment).

- [ ] **Step 1:** If `pnpm --version` is not `12.18.0`, run `npm install -g pnpm@12.18.0`. If the global prefix is not writable, use `--prefix ~/.local` and make sure `~/.local/bin` is on `PATH`.
- [ ] **Step 2:** Run `pnpm --version`. Expected: `12.18.0`.

### Task 2: Package manager foundation

**Files:**
- Create: `pnpm-workspace.yaml`, `pnpm-lock.yaml` (generated), `tests/release/package-manager.test.ts`
- Modify: `package.json`, `packages/{bank-mcp,line-client-sqlite,line-mcp,server}/package.json`, `.gitignore`, `tests/architecture/import-boundaries.test.ts:111-125`, `tests/release/version-baseline.test.ts`
- Delete: `package-lock.json`

**Interfaces:**
- Produces: `tests/release/package-manager.test.ts` with `describe('package manager')`. Tasks 6 and 7 add `it` blocks to it. It exports nothing.
- Produces: helper `const pnpmVersion = rootManifest.packageManager.replace(/^pnpm@/, '')`, defined at the top of that file and reused by later tasks.

- [ ] **Step 0: Baseline.** Before any change, run `npm ls -ws --depth 0 > "$TMPDIR/npm-ls.txt"` (TMPDIR = the session scratchpad).
- [ ] **Step 1: Write the failing tests** in `tests/release/package-manager.test.ts`:
  - `pins an exact pnpm version`: `expect(rootManifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)`.
  - `tracks only the pnpm lockfile`: `existsSync('pnpm-lock.yaml')` is true; `git ls-files` filtered for `/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/` returns `[]`.
  - `declares the workspace and its build allowlist`: parsed `pnpm-workspace.yaml` (with `yaml`'s `parse`) has `packages` equal to `['packages/*']` and `allowBuilds` equal to `{ 'better-sqlite3': true }`.
  - `links internal packages with the workspace protocol`: for the root and each `packages/*/package.json`, every `dependencies`/`devDependencies` key starting `@raidenyn/` has the value `'workspace:^'`.
  - `declares every workspace package imported by root tests and scripts`: collect `from '(@raidenyn/[a-z-]+)` and `require('(@raidenyn/[a-z-]+)` matches under `tests/` and `scripts/`, excluding `tests/**/fixtures`, and each must be a key of the root `dependencies` or `devDependencies`.

  Edit `import-boundaries.test.ts`:
  - Rename the case to `is configured as a private pnpm workspace containing packages/*`. Assert that `rootManifest.workspaces` is `undefined` and that `pnpm-workspace.yaml` `packages` is `['packages/*']`.
  - Rename the lockfile case to `has a single root pnpm-lock.yaml`. Assert that no package has a `pnpm-lock.yaml` or `package-lock.json`, that the root has `pnpm-lock.yaml`, and that the root has no `package-lock.json`.

  Edit `version-baseline.test.ts`:
  - Internal ranges are `'workspace:^'`, checked over `dependencies` and `devDependencies`.
  - Delete the `records root and workspace versions in the lockfile` case; the manifest version case already covers it.
- [ ] **Step 2:** Run `npx vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts`. Expected: FAIL on packageManager, lockfile, workspace and ranges.
- [ ] **Step 3: Migrate.**
  - Write `pnpm-workspace.yaml` per design D5.
  - In the root `package.json`, remove `workspaces`, add `"packageManager": "pnpm@12.18.0"`, and add `@raidenyn/bank-mcp`, `@raidenyn/line-mcp` and `@raidenyn/server` as `workspace:^` to `devDependencies`. Keep the existing root `dependencies` entries, with ranges changed to `workspace:^`.
  - Change every internal range in the four package manifests to `workspace:^`.
  - Run `pnpm import`, then `pnpm install`. If 12.18.0 rejects the `allowBuilds` key, use the key its error or docs name, update the test to match, and record it in `apply.md`.
  - Run `git rm package-lock.json`, and add `package-lock.json` under the npm section of `.gitignore`.
- [ ] **Step 4:** Run `pnpm ls -r --depth 0 > "$TMPDIR/pnpm-ls.txt"`. Compare the external package versions with `npm-ls.txt` and record the result in `apply.md`. Expected: identical versions.
- [ ] **Step 5:** Run `pnpm install --frozen-lockfile && pnpm run build && pnpm exec vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts`. Expected: PASS.
- [ ] **Step 6:** Run `node -e "require('better-sqlite3')"` from `packages/line-client-sqlite`. Expected: exit 0.
- [ ] **Step 7: Commit:** `build(deps): switch the workspace to pnpm`.

### Task 3: Verification entrypoints

**Files:** Modify `package.json` (`scripts.verify`, `scripts['verify:all']`, `scripts['test:smoke']`), `scripts/verify-changed.mjs:94,105,113`, `tests/release/verify-entrypoint.test.ts:21-45`.

- [ ] **Step 1: Test.** Change the assertions to:
  - `toContain('pnpm run lint')`;
  - `match(/pnpm run build/g)` with length 1;
  - `toContain('pnpm exec openspec validate --all --strict')`;
  - `verify:all` `toContain('pnpm run verify')`;
  - `test:smoke` equal to `'pnpm run build && vitest run tests/smoke'`;
  - `readFileSync('scripts/verify-changed.mjs')` does not contain `'npx'`.

  Leave the AGENTS.md doc case (lines 74-80) for Task 8.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the scripts, replace `npm run` with `pnpm run` and `npx` with `pnpm exec`. In `verify-changed.mjs`, change `run('npx', ['--no-install', X, …])` to `run('pnpm', ['exec', X, …])`, and change the hint to `pnpm run verify`.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts && pnpm run verify:changed`. Expected: PASS, and `verify:changed` exits 0.
- [ ] **Step 5: Commit:** `build(deps): run verification entrypoints through pnpm`.

### Task 4: happy-dom vendoring under pnpm

**Files:** Modify `packages/line-client/scripts/vendor-happy-dom.js:1-60`; comments in `tests/artifacts/line-client-pack.test.ts:5-40`.

- [ ] **Step 1:** Run `pnpm exec vitest run tests/artifacts/line-client-pack.test.ts`. Expected: FAIL with `vendor-happy-dom: cannot resolve package "undici-types"`. This existing test is the red test.
- [ ] **Step 2: Implement.** In `vendor()`, set `const srcDir = fs.realpathSync(resolvePkgDir(name, fromDir));` and leave the copy condition and `cpSync(..., { dereference: true })` unchanged. Rewrite the header comment: under pnpm, happy-dom is a symlink into `node_modules/.pnpm`; its dependencies are siblings there; the script materializes real copies because `npm pack` crashes on a symlinked bundled dependency. Update the hoisting comments in the test.
- [ ] **Step 3:** Run `pnpm exec vitest run tests/artifacts/line-client-pack.test.ts`, then `pnpm install --frozen-lockfile`, then the same test again. Expected: PASS both times (Review Focus 2).
- [ ] **Step 4:** Run `stat -c %h node_modules/.pnpm/happy-dom@*/node_modules/happy-dom/package.json` before and after the pack. Expected: the link count is unchanged, so the store was not written through.
- [ ] **Step 5: Commit:** `build(deps): resolve vendored happy-dom closure through real paths`.

### Task 5: Hooks and agent policy

**Files:** Modify `.claude/settings.json`, `tests/release/agent-policy.test.ts`, `.husky/commit-msg`, `tests/release/commit-policy.test.ts:7`, `.claude/hooks/lint-on-edit.mjs:98,111-114`, `tests/harness/lint-on-edit.test.ts` (only if it asserts the hint), `tests/e2e.test.ts:76-78,117`.

- [ ] **Step 1: Test.** Update `agent-policy.test.ts`:
  - ask contains `'Bash(pnpm run test:e2e*)'`, `'Bash(pnpm exec vitest run *e2e*)'`, `'Bash(npm run test:e2e*)'` and `'Bash(npx vitest run *e2e*)'`;
  - allow does not contain `'Bash(pnpm exec vitest run *)'` or `'Bash(npx vitest run *)'`;
  - allow contains `'Bash(pnpm exec vitest run packages*)'` and the same for `tests/architecture`, `tests/release`, `tests/smoke`, `tests/artifacts` and `tests/docker`, plus `'Bash(pnpm run lint*)'`, `'Bash(pnpm run build*)'`, `'Bash(pnpm run test:unit*)'`, `'Bash(pnpm run test:smoke*)'`, `'Bash(pnpm run verify*)'` and `'Bash(pnpm exec eslint *)'`;
  - deny contains both `'Bash(npm publish*)'` and `'Bash(pnpm publish*)'`;
  - rename the deny case to `… npm and pnpm publish …`.

  In `commit-policy.test.ts`, use `spawnSync('pnpm', ['exec', 'commitlint'], …)`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/agent-policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `settings.json`: swap the allow patterns to the pnpm forms, add the pnpm e2e ask rules, and add `Bash(pnpm publish*)` to deny.
  - `.husky/commit-msg`: `pnpm exec commitlint --edit "$1"`.
  - `lint-on-edit.mjs`: the fallback becomes `['pnpm', ['exec', 'eslint']]`, the hint becomes ``run `pnpm exec eslint ${file}` ``, and the comment says "pnpm exec" in place of "npx".
  - `e2e.test.ts`: `spawn('pnpm', ['exec', 'ts-node', …])`, with the comment `(pnpm → ts-node → node)`.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/release/agent-policy.test.ts tests/release/commit-policy.test.ts tests/harness`, then `printf 'feat: ok\n' > "$TMPDIR/msg" && sh .husky/commit-msg "$TMPDIR/msg"`. Expected: PASS, and the hook exits 0.
- [ ] **Step 5: Commit:** `build(harness): use pnpm in hooks and agent permissions`.

### Task 6: CI and release workflows

**Files:** Modify `.github/workflows/ci.yml` (jobs `commit-policy`, `check`, `pack-line-client`, `docker`, `smoke`), `.github/workflows/release.yml:95-140`, `tests/release/release-workflow.test.ts:140-170`, `tests/release/package-manager.test.ts`.

- [ ] **Step 1: Test.**
  - In `release-workflow.test.ts`, the plan step list is `['Authorize the owner on main', 'actions/checkout@v7', 'pnpm/action-setup@v6', 'actions/setup-node@v7', 'Install dependencies', …unchanged]`. The "Install dependencies" run is `'pnpm install --frozen-lockfile --ignore-scripts'`, and the plan run is `'pnpm run release:plan'`.
  - In `package-manager.test.ts`, add the case `sets up pinned pnpm before node in every workflow job`. For `ci.yml` and `release.yml`, parse with `yaml`. For each job whose steps include `actions/setup-node@v7`: some earlier step `uses` `pnpm/action-setup@v6` with no `with.version`; the setup-node `with.cache` is `'pnpm'`; and no step `run` matches `/\bnpm (ci|run|ls)\b|\bnpx\b/`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In every job: insert `- uses: pnpm/action-setup@v6` after checkout, set `cache: pnpm`, and install with `pnpm install --frozen-lockfile`.
  - Replace `npm run commitlint -- <args>` with `pnpm exec commitlint <args>`, and `| npm run commitlint` with `| pnpm exec commitlint`.
  - Replace `npm run X` with `pnpm run X` and `npx X` with `pnpm exec X`.
  - Delete the `Dependency-closure check` step, and remove "and a dependency-closure check" from the `check` job comment.
  - In `release.yml`, use the same setup and `--ignore-scripts`. Change the line-11 comment only if it describes npm installs; the "not npm" publish wording stays.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/release`. Expected: PASS.
- [ ] **Step 5: Commit:** `ci: install and run with pnpm`.

### Task 7: Docker builder

**Files:** Modify `Dockerfile:15-50`, `tests/release/package-manager.test.ts`.

- [ ] **Step 1: Test.** Add the case `pins the Docker builder to the same pnpm`. It reads `Dockerfile` and asserts:
  - `/^ARG PNPM_VERSION=(\S+)$/m` captures `pnpmVersion`;
  - the file contains `npm install -g pnpm@${PNPM_VERSION}`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `pnpm install --frozen-lockfile`;
  - it does not contain `package-lock.json` or `npm ci`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/package-manager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the builder per design D8:
  - `ARG PNPM_VERSION=12.18.0` and `ENV CI=true`, then the npm global install;
  - `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./` plus the six package manifests;
  - `pnpm install --frozen-lockfile`, then `pnpm run build`, then `pnpm prune --prod`;
  - if the pruned tree still holds `typescript`, switch to the fallback `rm -rf node_modules packages/*/node_modules && pnpm install --prod --frozen-lockfile --offline`;
  - update the comments, which still say `npm ci` and `npm prune`.

  Runtime stages: leave their structure unchanged.
- [ ] **Step 4:** Run `docker build --target server -t line-mcp-server:test . && docker build --target line-mcp -t line-mcp-standalone:test .`, then `docker run --rm --entrypoint sh line-mcp-standalone:test -c 'find /app -xtype l | head'`, then `docker run --rm --entrypoint sh line-mcp-server:test -c 'ls /app/node_modules/.pnpm | grep -c typescript'`. Expected: both builds succeed; no dangling links that the runtime resolves (record any links to devDependencies); typescript count `0`.
- [ ] **Step 5:** Run `pnpm exec vitest run tests/release/package-manager.test.ts tests/docker/docker-smoke.test.ts`. Expected: PASS, with both images answering healthz and `tools/list`.
- [ ] **Step 6: Commit:** `build(docker): build images with pnpm`.

### Task 8: Documentation

**Files:** Modify `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, `tests/release/verify-entrypoint.test.ts:74-80`.

- [ ] **Step 1: Test.** The doc case expects `/pnpm run verify(?![:\w])/`, plus `pnpm run verify:changed`, `pnpm run verify:all`, `pnpm run test:e2e` and `pnpm install` in AGENTS.md.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - AGENTS.md:
    - command block (`pnpm install` first, `pnpm run …`, `pnpm exec vitest run <file>`);
    - pre-PR gate and ladder commands;
    - a "Setup" note: pnpm 12.18.0 from `packageManager`, installed with `npm install -g pnpm@12.18.0`; the pnpm store must share a filesystem with the worktrees for hardlinks;
    - hard rule "Never `npm publish` or `pnpm publish` any package";
    - "npm-workspace monorepo" → "pnpm-workspace monorepo";
    - doc map `pnpm exec openspec validate`.
  - CLAUDE.md: the permissions summary lists `npm publish`/`pnpm publish` and the pnpm command forms.
  - README.md: install/dev command blocks; `pnpm exec vitest run …`; CI job bullets (`pnpm install --frozen-lockfile`, remove the `npm ls` mention); workspace wording. Keep the npm registry policy and the `npm pack` consumer wording.
  - docs/ARCHITECTURE.md: workspace sentence; Docker builder paragraph (`pnpm install --frozen-lockfile`, `pnpm prune --prod`); `pnpm exec openspec`; the ladder and test-runner lines.
  - docs/RELEASING.md: `pnpm run release:plan`.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/release && pnpm exec openspec validate --all --strict && git grep -nE '\bnpx\b|npm (ci|run|ls|start|install)\b' -- ':!openspec/changes/archive/**' ':!openspec/archived/**' ':!docs/superpowers/**' ':!openspec/changes/migrate-to-pnpm/**' ':!specs/**'`. Expected: tests PASS, validate OK. The grep may return only the intentional npm consumer usage in `tests/artifacts/line-client-pack.test.ts`, the vendoring script comments and the `npm install -g pnpm` setup lines.
- [ ] **Step 5: Commit:** `docs: document the pnpm workflow`.

### Task 9: Final gate

- [ ] **Step 1:** Run `pnpm run verify:all`. Expected: PASS, except the known `packages/line-mcp/src/auth/oauth-router.test.ts` "non-root basePath" ECONNREFUSED failures if they recur. If they do, re-run that file on an npm checkout of `origin/main` and record that it fails identically.
- [ ] **Step 2:** Time a fresh copy for `apply.md`: `git archive HEAD | tar -x -C "$TMPDIR/fresh" && cd "$TMPDIR/fresh" && time pnpm install --frozen-lockfile`. TMPDIR must be on the same filesystem as the store, so use `~/.cache`, not tmpfs. Expected: about 1 s with a warm store.
- [ ] **Step 3:** Update `handoff.md` from `openspec/templates/handoff.md` and record the results in `apply.md`.
