## 1. Environment preflight (design D14)

- [ ] 1.1 Prepare the shell that every later Verify command runs in:
  - `export PATH="$HOME/.cache/node24/bin:$PATH"`, with Node 24 from the official tarball;
  - `export NODE_OPTIONS=--dns-result-order=ipv4first`;
  - pnpm 12.18.0 on `PATH` (`npm install -g pnpm@12.18.0`, with a user prefix if the global one is not writable);
  - an npm baseline: `npm ci` on the unmodified tree, then `./node_modules/.bin/vitest run --reporter=dot packages tests/architecture tests/release tests/harness` all green.

  Record the baseline and the environment in `apply.md`.
  Verify: `node -v | grep -q '^v24\.' && pnpm --version | grep -qx '12.18.0' && ./node_modules/.bin/vitest run --reporter=dot packages tests/architecture tests/release tests/harness`

## 2. Package manager foundation (specs: pinned manager, workspace protocol, build allowlist; design D1–D5)

- [ ] 2.1 Write the failing guards in `tests/release/package-manager.test.ts`. They cover:
  - an exact `packageManager` pin;
  - the pnpm lockfile, with no npm, shrinkwrap or yarn lockfile tracked;
  - `pnpm-workspace.yaml` (`packages`, `allowBuilds` exactly `better-sqlite3: true, fsevents: false`, `verifyDepsBeforeRun: false`);
  - `workspace:^` internal ranges;
  - root-declared `@raidenyn/*` imports in `tests/` and `scripts/`;
  - per-package declared bare imports, with only `vitest` as shared test tooling.

  Also update `tests/architecture/import-boundaries.test.ts` (pnpm workspace root, single `pnpm-lock.yaml`) and `tests/release/version-baseline.test.ts` (`workspace:^`, manifest-only versions).
  Verify: `./node_modules/.bin/vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts` (expected red; the failures name the pin, lockfile, workspace, ranges and `server`'s undeclared `better-sqlite3`)
- [ ] 2.2 Migrate the manifests:
  - add `pnpm-workspace.yaml`;
  - add the `packageManager` pin and drop `workspaces`;
  - change internal ranges to `workspace:^`;
  - add root dev dependencies `@raidenyn/line-mcp` and `@raidenyn/server`;
  - add `better-sqlite3` as a `packages/server` dev dependency;
  - run `pnpm import`, then `pnpm install` over the existing npm `node_modules`.

  Run the lockfile parity script (design D2) and record every difference with its reason in `apply.md`. Only then `git rm package-lock.json` and ignore it.
  Verify: `pnpm install --frozen-lockfile && pnpm run build && pnpm exec vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts && (cd packages/line-client-sqlite && node -e "const D=require('better-sqlite3');if(new D(':memory:').prepare('select 1 x').get().x!==1)process.exit(1)")`
- [ ] 2.3 Check a fresh install from a clean export, separately from the in-place migration: `git archive HEAD` into a directory under `~/.cache` (the same filesystem as the store). Record the timing in `apply.md`.
  Verify: `rm -rf "$HOME/.cache/pnpm-fresh" && mkdir -p "$HOME/.cache/pnpm-fresh" && git archive HEAD | tar -x -C "$HOME/.cache/pnpm-fresh" && (cd "$HOME/.cache/pnpm-fresh" && time pnpm install --frozen-lockfile && pnpm run build)`

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
- [ ] 5.3 Change the lint-on-edit hook's fallback and hint to `pnpm exec eslint` (with assertions in `tests/harness/lint-on-edit.test.ts` if it covers them). Change `tests/e2e.test.ts` to start the server with `pnpm exec ts-node`, and update its comments. Update the stale npm text in the `packages/line-mcp/src/standalone.test.ts` error messages and in the `tests/docker/docker-smoke.test.ts` comments.
  Verify: `pnpm exec vitest run tests/harness packages/line-mcp/src/standalone.test.ts`

## 6. CI and release workflows (spec: frozen installs; design D7)

- [ ] 6.1 Extend the release tests first:
  - `tests/release/release-workflow.test.ts`: the plan job's step list with `pnpm/action-setup@v6`, its exact install and plan commands, and the negative assertions extended to `pnpm publish` and `pnpm run release`.
  - `tests/release/package-manager.test.ts`: in every `ci.yml` and `release.yml` job that sets up Node, `pnpm/action-setup@v6` comes first with no `version` input, the cache is `cache: pnpm`, and the install command is exactly `pnpm install --frozen-lockfile` (`--ignore-scripts` added in the release plan job); no `npm ci`, `npm run`, `npm ls` or `npx` remains in any `run`.

  Then update both workflows: the commitlint steps use `pnpm exec commitlint`, the `npm ls --all` step is removed, and the CI comments are updated.
  Verify: `pnpm exec vitest run tests/release`

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
  Verify: `pnpm exec vitest run tests/release && pnpm exec openspec validate --all --strict && ! git grep -nE '(^|[^p])\bnpm (ci|run|ls|start)\b|\bnpx\b' -- . ':!openspec/changes/archive/**' ':!openspec/archived/**' ':!docs/superpowers/**' ':!openspec/changes/migrate-to-pnpm/**' ':!specs/**' ':!tests/artifacts/line-client-pack.test.ts' ':!tests/release/release-workflow.test.ts' ':!packages/line-client/assets/**'`

## 9. Final gate (design D14)

- [ ] 9.1 Run the local pre-PR gate and the pack check under the preflight environment, and record the results in `apply.md`. Open the PR as a draft. The Docker rung is complete only when CI's `docker` job (image builds, smoke and layout cases) is green on it.
  Verify: `pnpm run verify && pnpm exec vitest run --reporter=dot tests/artifacts/line-client-pack.test.ts`
