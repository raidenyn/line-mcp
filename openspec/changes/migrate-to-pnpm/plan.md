# Migrate to pnpm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace npm with pnpm 12.18.0 across manifests, scripts, hooks, agent policy, CI, release, Docker and docs, so a fresh worktree installs in about a second from the shared store.

**Architecture:** pnpm workspaces with the default isolated `node_modules` layout. Internal dependencies are linked with `workspace:^`. The lockfile is imported from `package-lock.json`, and a full transitive parity check confirms versions did not move. A new release test, `tests/release/package-manager.test.ts`, guards the invariants. npm remains only where it simulates an external consumer: the packed line-client artifact test.

**Tech Stack:** pnpm 12.18.0, Node 24, TypeScript `tsc -b`, Vitest, GitHub Actions (`pnpm/action-setup@v6`, `actions/setup-node@v7`), Docker (`node:24` builder).

**Spec:** `openspec/changes/migrate-to-pnpm/specs/workspace-package-management/spec.md`, `design.md` (decisions D1–D14), `brainstorm.md` (benchmark, breakage inventory).

## Global Constraints

- pnpm version: exactly `12.18.0`, declared once as `"packageManager": "pnpm@12.18.0"`. The Dockerfile `ARG PNPM_VERSION=12.18.0` must equal it.
- `pnpm-workspace.yaml`: `packages: [packages/*]`, `allowBuilds: { better-sqlite3: true, fsevents: false }`, `verifyDepsBeforeRun: false`.
- Internal dependency range: `workspace:^`. Package versions stay `0.1.0`.
- Shared test tooling exempt from per-package declaration: `vitest` only.
- Automated installs: `pnpm install --frozen-lockfile`; the release plan job adds `--ignore-scripts`.
- Never `npm publish` or `pnpm publish`. Never edit `packages/line-client/assets/ltsm/*`.
- No dependency version changes. Every lockfile parity difference is explained in `apply.md`.
- Every command runs under the Task 1 environment: Node 24 first on `PATH`, `NODE_OPTIONS=--dns-result-order=ipv4first`, and pnpm 12.18.0.
- Commits: Conventional Commits. Use `build(deps)`, `build(harness)`, `build(docker)`, `ci`, `test` or `docs` as fits.

## Review Focus

1. **Stale npm `node_modules` in an existing worktree.** pnpm must replace it cleanly. Task 2.2 installs over the npm tree, and Task 2.3 separately installs a clean export.
2. **`npm pack` after pnpm restored the happy-dom symlink.** Task 4 asserts the symlink exists before the second pack, and checksums the store's happy-dom files.
3. **The standalone Docker image under the strict layout.** Task 7 adds layout cases to the Docker smoke: no dangling links, no dev packages, no `bank-mcp` or `server` references. They run in CI's `docker` job.
4. **Agent commands written the old way** (`npx vitest run tests/e2e.test.ts`). They must still ask. Task 5.1 asserts the npm/npx e2e ask rules remain.
5. **A package that imports something only the root declares.** Task 2.1's per-package import check catches it; today that is `server`'s `better-sqlite3`.

---

### Task 1: Environment preflight

**Files:** `openspec/changes/migrate-to-pnpm/apply.md` (create; the results log).

- [ ] **Step 1:** If `~/.cache/node24/bin/node` is missing, download the latest v24 Linux x64 tarball from `https://nodejs.org/dist/` into `~/.cache/node24` (strip one component). Then `export PATH="$HOME/.cache/node24/bin:$PATH" NODE_OPTIONS=--dns-result-order=ipv4first`.
- [ ] **Step 2:** If `pnpm --version` is not `12.18.0`, run `npm install -g pnpm@12.18.0`, with `--prefix ~/.local` if `/usr` is not writable.
- [ ] **Step 3:** On the unmodified tree, run tasks.md 1.1's Verify command (it includes `npm ci && npm run build` and the suites `packages tests/architecture tests/release tests/harness tests/smoke`). Expected: all green, including `oauth-router.test.ts`. Save `cp package-lock.json "$HOME/.cache/package-lock.baseline.json"`.
- [ ] **Step 4:** Write `apply.md` with the Node, npm and pnpm versions, the `NODE_OPTIONS` reason (design D14), and the baseline result.

### Task 2: Package manager foundation

**Files:**
- Create: `pnpm-workspace.yaml`, `pnpm-lock.yaml` (generated), `tests/release/package-manager.test.ts`
- Modify: `package.json`, `packages/{bank-mcp,line-client-sqlite,line-mcp,server}/package.json`, `.gitignore`, `tests/architecture/import-boundaries.test.ts:111-125`, `tests/release/version-baseline.test.ts`
- Delete: `package-lock.json`

**Interfaces:**
- Produces: `tests/release/package-manager.test.ts`, with `describe('package manager')` and these lazy helpers (no file reads at module top level): `readJson<T>(path: string): T` (parses as `unknown` and casts to a declared manifest/config type; no `any`), `readRootManifest()`, `readWorkspaceConfig(): Record<string, unknown> | undefined` (`undefined` when the file is missing), `pinnedPnpmVersion(): string | undefined`, and `bareImports(file: string): string[]` (via `ts.preProcessFile(text, true, true)`: takes `importedFiles[].fileName`, drops relative and absolute paths, and reduces each to its package name, `@scope/name` or `name`). Tasks 6 and 7 add `it` blocks and reuse these helpers.

- [ ] **Step 1: Write the failing tests** in `package-manager.test.ts`:
  - `pins an exact pnpm version`: `packageManager` matches `/^pnpm@\d+\.\d+\.\d+$/`.
  - `tracks only the pnpm lockfile`: `pnpm-lock.yaml` exists; `git ls-files` matching `/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/` is `[]`.
  - `declares the workspace, build allowlist and no implicit installs`: `readWorkspaceConfig()` `toMatchObject({ packages: ['packages/*'], allowBuilds: { 'better-sqlite3': true, fsevents: false }, verifyDepsBeforeRun: false })`, and the `allowBuilds` keys are exactly those two.
  - `links internal packages with the workspace protocol`: every `@raidenyn/*` key in any manifest's `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` is `'workspace:^'`.
  - `declares every root-level bare import in the root manifest`: for `tests/**/*.{ts,mjs,js}`, `scripts/**/*.{mjs,js}`, `vitest.config.ts` and `eslint.config.js`, every name from `bareImports` is a key of the root `dependencies` or `devDependencies`. Skip `node:`-prefixed names and `builtinModules`.
  - `declares every bare import in the package that makes it`: for each `packages/<dir>/src/**/*.ts`, every name from `bareImports` is in that package's `dependencies`, `devDependencies` or `peerDependencies`. Skip built-ins and `SHARED_TEST_TOOLING = ['vitest']`. The message names the file and the specifier.
  - `bareImports` reads real module specifiers only; comments are ignored by construction, so the commented `@raidenyn/x` examples in `import-boundaries.test.ts` are not counted.

  In `import-boundaries.test.ts`:
  - The root case becomes `is configured as a private pnpm workspace containing packages/*`: `workspaces` is `undefined`, and `pnpm-workspace.yaml` `packages` is `['packages/*']`.
  - The lockfile case becomes `has a single root pnpm-lock.yaml`: no package-local `pnpm-lock.yaml` or `package-lock.json`, a root `pnpm-lock.yaml`, and no root `package-lock.json`.

  In `version-baseline.test.ts`: internal ranges are `'workspace:^'` in `dependencies` and `devDependencies`. Delete the lockfile-version case.
- [ ] **Step 2:** Run `./node_modules/.bin/vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts`. Expected: every new case reports an assertion failure, including `packages/server … better-sqlite3`. There must be no file-level "Failed to load"/collection error; if there is one, move the offending read into its test.
- [ ] **Step 3: Convert and import.**
  - Write `pnpm-workspace.yaml` per Global Constraints.
  - Root: remove `workspaces`, add `packageManager`, and change the existing `@raidenyn/*` dependencies to `workspace:^`.
  - Packages: change internal ranges to `workspace:^`.
  - Run `pnpm import`. Make no other manifest change yet.
- [ ] **Step 4: Parity.** Run `node openspec/changes/migrate-to-pnpm/tools/lockfile-parity.mjs . "$HOME/.cache/package-lock.baseline.json" pnpm-lock.yaml`. Expected: the D2 result.
  - no importer-edge differences;
  - inventory only-npm: `ansi-regex@6.2.2` and `content-type@2.0.0`;
  - package-edge differences: only the four accepted dedupes, `debug@4.4.3 supports-color`, and the `npm@11.18.0 …` bundled edges.

  Copy the output into `apply.md`. Any other line stops the work and is reported to the owner. Do not patch it.
- [ ] **Step 4b: Deliberate additions.**
  - Add `@raidenyn/line-mcp` and `@raidenyn/server` (`workspace:^`) to the root `devDependencies`.
  - Add `"better-sqlite3": "^12.11.1"` to the `packages/server` `devDependencies`, the same range as the other packages.
  - Run `pnpm install`. It runs over the existing npm `node_modules`, so confirm that it replaces the tree.
- [ ] **Step 5:** `git rm package-lock.json`, and add `package-lock.json` under the npm section of `.gitignore`.
- [ ] **Step 6:** Run `pnpm install --frozen-lockfile && pnpm run build && pnpm exec vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts`, then the in-memory SQLite probe from tasks.md 2.2. Expected: PASS, and the probe exits 0.
- [ ] **Step 7: Commit:** `build(deps): switch the workspace to pnpm`.
- [ ] **Step 8: Fresh install.** Run tasks.md 2.3's Verify command, and record the `time` output in `apply.md`. Expected: about 1 s with a warm store; the build succeeds and the in-memory SQLite query exits 0.

### Task 3: Verification entrypoints

**Files:** Modify `package.json` (`scripts.verify`, `scripts['verify:all']`, `scripts['test:smoke']`), `scripts/verify-changed.mjs:94,105,113`, `tests/release/verify-entrypoint.test.ts:21-45`.

- [ ] **Step 1: Test.** The assertions become:
  - `toContain('pnpm run lint')`;
  - `/pnpm run build/g` with length 1;
  - `toContain('pnpm exec openspec validate --all --strict')`;
  - `verify:all` `toContain('pnpm run verify')`;
  - `test:smoke` `toBe('pnpm run build && vitest run tests/smoke')`;
  - `readFileSync('scripts/verify-changed.mjs','utf8')` `not.toMatch(/\bnpx\b/)`.

  The AGENTS.md doc case is left for Task 8.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Change `npm run` to `pnpm run` and `npx` to `pnpm exec` in the scripts. In `verify-changed.mjs`, change `run('npx', ['--no-install', X, …])` to `run('pnpm', ['exec', X, …])`, and make the hint say `pnpm run verify`.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts && pnpm run verify:changed`. Expected: PASS, and exit 0.
- [ ] **Step 5: Commit:** `build(deps): run verification entrypoints through pnpm`.

### Task 4: happy-dom vendoring under pnpm

**Files:** Modify `packages/line-client/scripts/vendor-happy-dom.js:1-60`, and the comments in `tests/artifacts/line-client-pack.test.ts:5-40`.

- [ ] **Step 1:** Run `pnpm exec vitest run tests/artifacts/line-client-pack.test.ts`. Expected: FAIL, `vendor-happy-dom: cannot resolve package "undici-types"`.
- [ ] **Step 2:** Run `find node_modules/.pnpm/happy-dom@*/node_modules/happy-dom -type f -exec sha256sum {} + | sort | sha256sum > "$HOME/.cache/happy-dom.sum"`.
- [ ] **Step 3: Implement.** In `vendor()`, set `const srcDir = fs.realpathSync(resolvePkgDir(name, fromDir));`. Keep the copy condition and `cpSync(..., { dereference: true })`. Rewrite the header comment: under pnpm, happy-dom is a symlink into `node_modules/.pnpm`; its dependencies are siblings there; real copies are required because `npm pack` crashes on a symlinked bundled dependency. Update the hoisting comments in the test.
- [ ] **Step 4:** Run tasks.md 4.1's Verify command. Expected: both packs PASS, and `test -L` succeeds in between.
- [ ] **Step 5:** Recompute the checksum from Step 2 and `diff` it against the saved one. Expected: identical, so the store was not written through.
- [ ] **Step 6: Commit:** `build(deps): resolve vendored happy-dom closure through real paths`.

### Task 5: Hooks and agent policy

**Files:** Modify `.claude/settings.json`, `tests/release/agent-policy.test.ts`, `.husky/commit-msg`, `tests/release/commit-policy.test.ts:7`, `.claude/hooks/lint-on-edit.mjs:98,111-114`, `tests/harness/lint-on-edit.test.ts` (only if it asserts the hint), `tests/e2e.test.ts:60-78,117`, `packages/line-mcp/src/standalone.test.ts:77,111`, `tests/docker/docker-smoke.test.ts:25`, `tests/release/openspec-tasks.test.ts:57-90` (fixtures `npm run test:unit` → `pnpm run test:unit`).

- [ ] **Step 1: Test.** Changes to `agent-policy.test.ts`:
  - ask contains `'Bash(pnpm run test:e2e*)'`, `'Bash(pnpm exec vitest run *e2e*)'`, `'Bash(npm run test:e2e*)'` and `'Bash(npx vitest run *e2e*)'`;
  - allow contains neither `'Bash(pnpm exec vitest run *)'` nor `'Bash(npx vitest run *)'`;
  - allow contains `'Bash(pnpm exec vitest run <root>*)'` for `packages`, `tests/architecture`, `tests/release`, `tests/smoke`, `tests/artifacts` and `tests/docker`, plus `'Bash(pnpm run lint*)'`, `'Bash(pnpm run build*)'`, `'Bash(pnpm run test:unit*)'`, `'Bash(pnpm run test:smoke*)'`, `'Bash(pnpm run verify*)'` and `'Bash(pnpm exec eslint *)'`;
  - deny contains `'Bash(npm publish*)'` and `'Bash(pnpm publish*)'`.

  In `commit-policy.test.ts`: `spawnSync('pnpm', ['exec', 'commitlint'], …)`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/agent-policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `settings.json`: match the test.
  - `.husky/commit-msg`: `pnpm exec commitlint --edit "$1"`.
  - `lint-on-edit.mjs`: fallback `['pnpm', ['exec', 'eslint']]`, hint ``run `pnpm exec eslint ${file}` ``, and the comment wording updated.
  - `e2e.test.ts`: `spawn('pnpm', ['exec', 'ts-node', …])`, comments `pnpm start`, `pnpm run test:unit` (line 66) and `(pnpm → ts-node → node)`.
  - `openspec-tasks.test.ts`: the fixture strings say `pnpm run test:unit`.
  - `standalone.test.ts`: errors say ``run `pnpm run build` ``.
  - `docker-smoke.test.ts`: the comment says `pnpm run test:unit`.
- [ ] **Step 4:** Run tasks.md 5.1–5.3's Verify commands. Expected: PASS, and the hook exits 0.
- [ ] **Step 5: Commit:** `build(harness): use pnpm in hooks and agent permissions`.

### Task 6: CI and release workflows

**Files:** Create `scripts/check-peers.mjs`, `tests/release/check-peers.test.ts`. Modify `.github/workflows/ci.yml` (jobs `commit-policy`, `check`, `pack-line-client`, `docker`, `smoke`, plus the trailing e2e comment), `.github/workflows/release.yml:95-140`, `tests/release/release-workflow.test.ts:140-170,288-300`, `tests/release/package-manager.test.ts`.

**Interfaces:**
- Produces: `scripts/check-peers.mjs` exports `findPeerProblems(report: Record<string, { bad: object; missing: object; conflicts: unknown[] }>): string[]`, which returns one line per problem as `<importer>: <field> <detail>`. When run directly (the `import.meta.url` guard, as in `verify-changed.mjs`), it spawns `pnpm peers check --lockfile-only --json`, prints the problems and exits 1 if there are any, otherwise prints `peer dependencies OK`. It exits 2 if pnpm fails or prints invalid JSON.

- [ ] **Step 1: Test.**
  - In `release-workflow.test.ts`:
    - the plan step list is `['Authorize the owner on main', 'actions/checkout@v7', 'pnpm/action-setup@v6', 'actions/setup-node@v7', 'Install dependencies', 'Verify current main', 'Verify baseline tag exists', 'Plan the release', 'Verify main unchanged', 'Upload the release notes']`;
    - Install runs `'pnpm install --frozen-lockfile --ignore-scripts'`, and Plan runs `'pnpm run release:plan'`;
    - the negative case adds `not.toMatch(/^pnpm run release$/m)`, `not.toContain('pnpm publish')` and `not.toContain('npm publish')`.
  - In `package-manager.test.ts`, add the case `sets up pinned pnpm before node and installs frozen in every job`:
    - parse `ci.yml` and `release.yml` with `yaml`;
    - the jobs that contain `actions/setup-node@v7` are exactly `ci.yml` {`commit-policy`, `check`, `pack-line-client`, `docker`, `smoke`} and `release.yml` {`plan`};
    - in each: an earlier step `uses: pnpm/action-setup@v6` with `with` undefined, and setup-node `with.cache === 'pnpm'`;
    - the steps whose `run` matches `/\bpnpm install\b/` number exactly one, and that `run.trim()` equals `pnpm install --frozen-lockfile` (`… --ignore-scripts` for `plan`);
    - no step `run` matches `/(^|[^p])\bnpm (ci|run|ls)\b|\bnpx\b/`;
    - `check` has a step named `Peer dependency check` with `run: node scripts/check-peers.mjs`.
  - In `check-peers.test.ts`, `findPeerProblems`:
    - an all-empty seven-importer report gives `[]`;
    - `{ '.': { bad: { x: {} }, missing: {}, conflicts: [] } }` gives one entry starting `.: bad`;
    - the same holds for `missing` and for a non-empty `conflicts`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each job: insert `- uses: pnpm/action-setup@v6` after checkout, set `cache: pnpm`, and install as asserted.
  - Commitlint steps: `pnpm exec commitlint <args>` and `| pnpm exec commitlint`.
  - Other commands: `pnpm run X` and `pnpm exec X`.
  - Replace the `Dependency-closure check` step with `- name: Peer dependency check` / `run: node scripts/check-peers.mjs`, and update the `check` comment. The e2e comment says `pnpm run test:e2e`.
  - `release.yml`: the same setup, with `--ignore-scripts`.
- [ ] **Step 4:** Run tasks.md 6.1's Verify command. Expected: PASS, and `peer dependencies OK`.
- [ ] **Step 5: Commit:** `ci: install and run with pnpm`.

### Task 7: Docker builder

**Files:** Modify `Dockerfile:1-50`, `tests/release/package-manager.test.ts`, `tests/docker/docker-smoke.test.ts`.

**Interfaces:**
- Consumes: the existing image tags `line-mcp-server:test` and `line-mcp-standalone:test`, and the existing daemon-availability skip in `docker-smoke.test.ts`. Reuse that skip guard for the new cases.

- [ ] **Step 1: Tests.**
  - In `package-manager.test.ts`, add the case `pins the Docker builder to the same pnpm`:
    - `/^ARG PNPM_VERSION=(\S+)$/m` captures `pnpmVersion`;
    - the Dockerfile contains `npm install -g pnpm@${PNPM_VERSION}`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `pnpm install --frozen-lockfile` and `pnpm prune --prod`;
    - it does not contain `package-lock.json` or `npm ci`.
  - In `docker-smoke.test.ts`, add helper `shellIn(image: string, script: string): string`, which runs `docker run --rm --entrypoint sh <image> -c <script>` and returns stdout. Per image, add:
    - `has no dangling symlinks`: `find /app -xtype l` → `''`;
    - `ships no dev-only packages`: `ls /app/node_modules/.pnpm` lines matching `/^(typescript|vitest|eslint|semantic-release)@|^@commitlint\+/` → `[]`;
    - standalone only, `references neither bank-mcp nor server`: `find /app -path '*packages/bank-mcp*' -o -path '*packages/server*'` → `''`, and `find /app -type l -exec readlink {} +` has no line containing `packages/bank-mcp` or `packages/server`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/package-manager.test.ts`. Expected: FAIL on the Dockerfile case.
- [ ] **Step 3: Implement** the builder per design D8:
  - `ARG PNPM_VERSION=12.18.0` and `ENV CI=true`, then `RUN npm install -g pnpm@${PNPM_VERSION}`;
  - `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./` plus the six package manifests;
  - `RUN pnpm install --frozen-lockfile`, then `RUN pnpm run build`, then `RUN pnpm prune --prod`;
  - rewrite the header and stage comments.

  The runtime stages are unchanged.
- [ ] **Step 4:** Run tasks.md 7.1's Verify command. Expected: PASS; the Docker cases are skipped locally (no daemon).
- [ ] **Step 5: Commit:** `build(docker): build images with pnpm`. The real build, the smoke and the layout cases run in CI's `docker` job (Task 9).

### Task 8: Documentation

**Files:** Create `tests/release/npm-sweep.test.ts`. Modify `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, `tests/release/verify-entrypoint.test.ts:74-80`.

- [ ] **Step 1: Tests.**
  - In the doc case, AGENTS.md matches `/pnpm run verify(?![:\w])/` and contains `pnpm run verify:changed`, `pnpm run verify:all`, `pnpm run test:e2e` and `pnpm install`.
  - Add `npm-sweep.test.ts` as specified in tasks.md 8.1.
    - It exports `findUnexpected(matches: string[], allowed: ReadonlySet<string>): string[]`, which strips the `:<line>:` part of each `file:line:text` match and returns those not in `allowed`.
    - The case `accepts allowlisted lines and rejects new legacy commands` calls it with the allowlisted entries plus `README.md:1:npm run build` and `docs/x.md:2:npx vitest`, and expects exactly the last two back.
    - The case `finds no unexpected npm commands` runs `spawnSync('git', ['grep', '-nE', PATTERN, '--', '.', ...EXCLUDES])`. Status `1` passes; status `0` requires `findUnexpected(...)` to be `[]`; any other status fails.
    - Run it once to collect the matches; only the intentional lines listed in tasks.md 8.1 may go into `ALLOWED`.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/release/verify-entrypoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - AGENTS.md:
    - command block (`pnpm install` first, `pnpm run …`, `pnpm exec vitest run <file>`);
    - a Setup paragraph: pnpm 12.18.0 is pinned by `packageManager`; install it with `npm install -g pnpm@12.18.0`; another pnpm version downloads and runs the pinned one (`pmOnFail`); keep the store on the same filesystem as the worktrees;
    - gates and ladder in pnpm form;
    - hard rule "Never `npm publish` or `pnpm publish` any package";
    - "pnpm-workspace monorepo";
    - doc map `pnpm exec openspec validate`.
  - CLAUDE.md: the permissions summary (pnpm forms; `npm publish` and `pnpm publish` denied).
  - README.md: install and dev blocks, `pnpm exec vitest run …`, CI job bullets (frozen install, no `npm ls`), workspace wording. Keep the npm registry policy and the `npm pack` consumer wording.
  - docs/ARCHITECTURE.md: workspace sentence, Docker builder paragraph (`pnpm install --frozen-lockfile`, `pnpm prune --prod`, the layout checks), `pnpm exec openspec`, ladder and test-runner lines.
  - docs/RELEASING.md: `pnpm run release:plan`.
- [ ] **Step 4:** Run tasks.md 8.1's Verify command. Expected: PASS, with the sweep showing only allowlisted matches.
- [ ] **Step 5: Commit:** `docs: document the pnpm workflow`.

### Task 9: Final gate

- [ ] **Step 1:** Run tasks.md 9.1's Verify command under the Task 1 environment. Expected: PASS. If anything fails, record it in `apply.md`, run each remaining check on its own, and do not call the gate green.
- [ ] **Step 2:** Record the results in `apply.md`, and update `handoff.md` from `openspec/templates/handoff.md`.
- [ ] **Step 3:** Push and open the draft PR (titled `build(deps): migrate the workspace to pnpm`). Its description states the owner-approved Docker-gate exception (design D14, 2026-11-25). Then wait for CI: `check`, `smoke`, `pack-line-client`, `docker` and `commit-policy` must all be green before review findings are posted and the PR is marked ready.
