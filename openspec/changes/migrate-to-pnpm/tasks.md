## 1. Environment preflight (design D14)

- [x] 1.1 Prepare the shell that every later Verify command runs in:
  - `export PATH="$HOME/.cache/node24/bin:$PATH"`, with Node 24 from the official tarball;
  - `export NODE_OPTIONS=--dns-result-order=ipv4first`;
  - pnpm 12.18.0 on `PATH` (`npm install -g pnpm@12.18.0`, with a user prefix if the global one is not writable);
  - an npm baseline: `npm ci && npm run build` on the unmodified tree, then the suites below all green.

  Record the baseline and the environment in `apply.md`.
  Verify: `node -v | grep -q '^v24\.' && pnpm --version | grep -qx '12.18.0' && npm ci && npm run build && ./node_modules/.bin/vitest run --reporter=dot packages tests/architecture tests/release tests/harness tests/smoke`

## 2. Package manager foundation (specs: pinned manager, workspace protocol, build allowlist; design D1–D5)

- [x] 2.1 Write the failing guards in `tests/release/package-manager.test.ts`. They cover:
  - an exact `packageManager` pin;
  - the pnpm lockfile, with no npm, shrinkwrap or yarn lockfile tracked;
  - `pnpm-workspace.yaml` (`packages`, `allowBuilds` exactly `better-sqlite3: true, fsevents: false`, `verifyDepsBeforeRun: false`, `hoistWorkspacePackages: false`);
  - `workspace:^` internal ranges in all four dependency sections;
  - declared bare imports per package and at the root, parsed with `ts.preProcessFile`, with only `vitest` as shared test tooling.

  Every file read happens inside its own test, and a missing file fails that test's assertion. Nothing is read at module top level, so the red run reports assertion failures, not a collection error.

  Also update `tests/architecture/import-boundaries.test.ts` (pnpm workspace root, single `pnpm-lock.yaml`) and `tests/release/version-baseline.test.ts` (`workspace:^`, manifest-only versions).
  Verify: `./node_modules/.bin/vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts` (expected red with assertion failures naming the pin, lockfile, workspace file, ranges and `packages/server`'s undeclared `better-sqlite3`; there must be no "Failed to load"/collection error)
- [x] 2.2 Migrate the manifests:
  - add `pnpm-workspace.yaml`;
  - add the `packageManager` pin and drop `workspaces`;
  - change internal ranges to `workspace:^`;
  - run `pnpm import`;
  - run `tools/lockfile-parity.mjs` (design D2) at this point, before the additions below. Record its output in `apply.md`. It must match the D2 result: only the four accepted dedupes, the optional-peer link and the bundled `npm` edges. Anything else stops the work and goes to the owner;
  - add root dev dependencies `@raidenyn/line-mcp` and `@raidenyn/server`;
  - add `better-sqlite3` as a `packages/server` dev dependency;
  - delete the npm trees (`rm -rf node_modules packages/*/node_modules`). A pnpm install over an npm tree leaves undeclared packages (such as `debug` and the `@raidenyn/bank-mcp` link) resolvable, and old workspace-local npm binaries take precedence in `pnpm exec`;
  - run `pnpm install`, then assert the stale entries are gone: `node_modules/.package-lock.json`, `node_modules/debug` and `node_modules/@raidenyn/bank-mcp` must not exist;
  - run the parity tool again on the lockfile that will ship. It must show the same inventory and package edges, plus exactly the three deliberate importer edges (`@raidenyn/line-mcp` and `@raidenyn/server` at the root, and `better-sqlite3@12.11.1` in `packages/server`). Record the output in `apply.md`;
  - only then `git rm package-lock.json` and ignore it.
  Verify: `pnpm install --frozen-lockfile && test ! -e node_modules/.package-lock.json && test ! -e node_modules/debug && test ! -e node_modules/@raidenyn/bank-mcp && pnpm run build && pnpm exec vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts && (cd packages/line-client-sqlite && node -e "const D=require('better-sqlite3');if(new D(':memory:').prepare('select 1 x').get().x!==1)process.exit(1)")`
- [ ] 2.3 Check a fresh install from a clean export, separately from the in-place migration: `git archive HEAD` into a directory under `~/.cache` (the same filesystem as the store). Record the timing in `apply.md`.
  Verify: `rm -rf "$HOME/.cache/pnpm-fresh" && mkdir -p "$HOME/.cache/pnpm-fresh" && git archive HEAD | tar -x -C "$HOME/.cache/pnpm-fresh" && (cd "$HOME/.cache/pnpm-fresh" && time pnpm install --frozen-lockfile && pnpm run build && cd packages/line-client-sqlite && node -e "const D=require('better-sqlite3');if(new D(':memory:').prepare('select 1 x').get().x!==1)process.exit(1)")`

## 3. Verification entrypoints (design D6)

- [ ] 3.1 Update the script assertions in `tests/release/verify-entrypoint.test.ts` to the pnpm forms. Then change the `verify`, `verify:all` and `test:smoke` scripts in `package.json`, and the `npx --no-install` calls and hint text in `scripts/verify-changed.mjs`.
  Verify: `pnpm exec vitest run tests/release/verify-entrypoint.test.ts && pnpm run verify:changed`

## 4. happy-dom vendoring under pnpm (spec: packed artifact stays npm-consumable; design D9, D10)

- [ ] 4.1 Confirm that the pack test fails under the pnpm layout. Then resolve through `fs.realpathSync` in `packages/line-client/scripts/vendor-happy-dom.js`, keep the dereferenced real copies, and update the layout comments in the script and the test. Re-run the pack after restoring pnpm's symlink (`rm -rf packages/line-client/node_modules && pnpm install --frozen-lockfile`, then assert that `happy-dom` is a symlink). Compare a checksum of the store's happy-dom files before and after both packs.
  Verify: `pnpm exec vitest run tests/artifacts/line-client-pack.test.ts && rm -rf packages/line-client/node_modules && pnpm install --frozen-lockfile && test -L packages/line-client/node_modules/happy-dom && pnpm exec vitest run tests/artifacts/line-client-pack.test.ts`

## 5. Hooks and agent policy (spec: agent permissions and hooks use pnpm; design D11–D13)

- [ ] 5.1 Update `tests/release/agent-policy.test.ts`:
  - pnpm allow patterns;
  - e2e ask rules in both pnpm and npm/npx forms;
  - no broad vitest allow in either form;
  - deny rules for both `npm publish*` and `pnpm publish*`.

  Then update `.claude/settings.json`.
  Verify: `pnpm exec vitest run tests/release/agent-policy.test.ts`
- [ ] 5.2 Switch `.husky/commit-msg` and `tests/release/commit-policy.test.ts` to `pnpm exec commitlint`.
  Verify: `pnpm exec vitest run tests/release/commit-policy.test.ts && printf 'feat: ok\n' > "$HOME/.cache/pnpm-msg" && sh .husky/commit-msg "$HOME/.cache/pnpm-msg"`
- [ ] 5.3 Change the lint-on-edit hook's fallback and hint to `pnpm exec eslint` (with assertions in `tests/harness/lint-on-edit.test.ts` if it covers them). Change `tests/e2e.test.ts` to start the server with `pnpm exec ts-node`, and update its comments. Update the stale npm text in the `packages/line-mcp/src/standalone.test.ts` error messages, the `tests/docker/docker-smoke.test.ts` comments, the `npm run test:unit` comment in `tests/e2e.test.ts`, and the `npm run test:unit` fixtures in `tests/release/openspec-tasks.test.ts`.
  Verify: `pnpm exec vitest run tests/harness tests/release/openspec-tasks.test.ts packages/line-mcp/src/standalone.test.ts`

## 6. CI and release workflows (spec: frozen installs; design D7)

- [ ] 6.1 Extend the release tests first:
  - `tests/release/release-workflow.test.ts`: the plan job's step list with `pnpm/action-setup@v6`, its exact install and plan commands, and the negative assertions extended to `pnpm publish` and `pnpm run release`.
  - `tests/release/package-manager.test.ts`, for both workflows:
    - the set of jobs that set up Node is exactly `commit-policy`, `check`, `pack-line-client`, `docker`, `smoke` (CI) and `plan` (release);
    - in each, `pnpm/action-setup@v6` comes first and has no `with` block, and the cache is `cache: pnpm`;
    - exactly one step `run` mentions `pnpm install`, and it equals `pnpm install --frozen-lockfile` (`--ignore-scripts` added for `plan`);
    - no `npm ci`, `npm run`, `npm ls` or `npx` remains in any `run`;
    - the `check` job runs `node scripts/check-peers.mjs`.
  - New `tests/release/check-peers.test.ts` for the exported `findPeerProblems(report)`: an all-empty report gives `[]`; reports with a non-empty `bad`, `missing` or `conflicts` each give entries naming the importer.

  Then add `scripts/check-peers.mjs` (design D7) and update both workflows:
  - the commitlint steps use `pnpm exec commitlint`;
  - `npm ls --all` is replaced by the `Peer dependency check` step;
  - the CI comments are updated.
  Verify: `pnpm exec vitest run tests/release && node scripts/check-peers.mjs`

## 7. Docker builder (spec: Docker builder pin, production-only image; design D8)

- [ ] 7.1 Add the Dockerfile pin assertion to `tests/release/package-manager.test.ts`. Add per-image layout cases to `tests/docker/docker-smoke.test.ts`: no dangling links; no dev-only packages in `.pnpm`; no `bank-mcp` or `server` paths or link targets in the standalone image. Then rewrite the builder stage (`ARG PNPM_VERSION`, `ENV CI=true`, global npm install of pnpm, pnpm manifests, frozen install, `pnpm run build`, `pnpm prune --prod`). The daemon is not available locally, so the Docker build and smoke run in CI's `docker` job on the draft PR (design D14).
  Verify: `pnpm exec vitest run tests/release/package-manager.test.ts tests/docker/docker-smoke.test.ts && pnpm exec eslint tests/docker/docker-smoke.test.ts` (the Docker cases skip locally without a daemon)

## 8. Documentation

- [ ] 8.1 Update the doc assertions in `tests/release/verify-entrypoint.test.ts`. Then update:
  - `AGENTS.md`:
    - commands;
    - a setup note: pnpm 12.18.0, the `pmOnFail` auto-download behaviour, and a store that must share a filesystem with the worktrees;
    - gates and ladder;
    - the hard rule naming `npm publish` and `pnpm publish`;
  - `CLAUDE.md`;
  - `README.md`;
  - `docs/ARCHITECTURE.md`;
  - `docs/RELEASING.md`.

  Keep the npm registry policy wording and the `npm pack` consumer wording.
  Add `tests/release/npm-sweep.test.ts`. It runs
  `git grep -nE '(^|[^p])\bnpm (ci|run|ls|start)\b|\bnpx\b'` over the tree,
  excluding the archives, `docs/superpowers/`, `openspec/changes/`, `specs/`
  and the LTSM assets. Exit code 1 (no matches) passes; any code other than
  0 or 1 fails. Each match must equal an entry of an exact allowlist, written
  as `file:text` without line numbers:
  - the npm/npx e2e ask rules in `.claude/settings.json` and `tests/release/agent-policy.test.ts`, and that test's negative assertion for `Bash(npx vitest run *)`;
  - the npm consumer commands in `tests/artifacts/line-client-pack.test.ts`;
  - the negative assertions in `tests/release/release-workflow.test.ts`;
  - the negative assertions in `tests/release/package-manager.test.ts` (the workflow `npm (ci|run|ls)`/`npx` pattern and the Dockerfile `npm ci` check);
  - the sweep test's own pattern.

  The filtering is an exported pure function, `findUnexpected(matches, allowed)`. A unit case proves that it accepts the allowlisted lines and rejects two synthetic legacy commands. These lines, and every allowlist entry that contains a legacy command, are built from separate tokens, so the test file does not match its own grep. The sweep is run with the new test file staged.
  Verify: `pnpm exec vitest run tests/release && pnpm exec openspec validate --all --strict`

## 9. Final gate (design D14)

- [ ] 9.1 Run the local pre-PR gate and the pack check under the preflight environment, and record the results in `apply.md`. Open the PR as a draft, and state in its description the owner-approved exception (design D14, 2026-11-25): the Docker rung runs in CI. The Docker rung is complete only when CI's `docker` job (image builds, smoke and layout cases) is green.
  Verify: `pnpm run verify && pnpm exec vitest run --reporter=dot tests/artifacts/line-client-pack.test.ts`
