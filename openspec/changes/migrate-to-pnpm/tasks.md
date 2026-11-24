## 1. Tooling prerequisite

- [ ] 1.1 Make pnpm 12.18.0 available on `PATH` in the dev container (`npm install -g pnpm@12.18.0`, using a user prefix if the global prefix is not writable). This is an environment step, not a repository change. Verify: `pnpm --version`

## 2. Package manager foundation (specs: pinned manager, workspace protocol, frozen installs, build allowlist)

- [ ] 2.1 Write failing guards first:
  - `tests/release/package-manager.test.ts`: `packageManager` is an exact `pnpm@x.y.z`; `pnpm-lock.yaml` exists; `git ls-files` lists no `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`; `pnpm-workspace.yaml` declares `packages/*` and allows `better-sqlite3` builds; every `@raidenyn/*` dependency in every manifest is `workspace:^`; every bare `@raidenyn/*` import under `tests/` and `scripts/` is declared by the root manifest.
  - `tests/architecture/import-boundaries.test.ts`: the workspace root is private, declared in `pnpm-workspace.yaml` and has no `workspaces` field; there is a single root `pnpm-lock.yaml` and no package-local lockfiles of either kind.
  - `tests/release/version-baseline.test.ts`: internal ranges are `workspace:^`; versions are checked from the manifests only.
  Verify: `npx vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts` (expected red)
- [ ] 2.2 Migrate the manifests:
  - add `pnpm-workspace.yaml` (`packages`, `allowBuilds`);
  - add `"packageManager": "pnpm@12.18.0"` and drop `workspaces`;
  - rewrite internal ranges to `workspace:^`;
  - add `@raidenyn/line-mcp`, `@raidenyn/server` and `@raidenyn/bank-mcp` to the root `devDependencies`;
  - run `pnpm import` from the current `package-lock.json`, then `pnpm install`; delete `package-lock.json` and add it to `.gitignore`;
  - record in `apply.md` that the top-level resolved versions from `npm ls -ws --depth 0` before the migration match `pnpm ls -r --depth 0` after it.
  Verify: `pnpm install --frozen-lockfile && pnpm run build && pnpm exec vitest run tests/release/package-manager.test.ts tests/architecture/import-boundaries.test.ts tests/release/version-baseline.test.ts`

## 3. Verification entrypoints (spec: frozen installs; design D6)

- [ ] 3.1 Update `tests/release/verify-entrypoint.test.ts` script assertions to the pnpm forms (`pnpm run lint`, exactly one `pnpm run build`, `pnpm exec openspec validate --all --strict`, `verify:all` starts with `pnpm run verify`), then change the `verify`, `verify:all` and `test:smoke` scripts in `package.json` and the `npx --no-install` calls and hint text in `scripts/verify-changed.mjs` to `pnpm exec` and `pnpm run`. Verify: `pnpm exec vitest run tests/release/verify-entrypoint.test.ts && pnpm run verify:changed`

## 4. happy-dom vendoring under pnpm (spec: packed artifact stays npm-consumable; design D9, D10)

- [ ] 4.1 Confirm `tests/artifacts/line-client-pack.test.ts` fails under the pnpm layout (vendor cannot resolve `undici-types`). Then make `packages/line-client/scripts/vendor-happy-dom.js` resolve each package directory through `fs.realpathSync` before recursing, keep the dereferenced real copies (a symlinked bundled dependency crashes `npm pack`), and update the layout comments in the script and in the test. Verify: `pnpm exec vitest run tests/artifacts/line-client-pack.test.ts`

## 5. Hooks and agent policy (spec: agent permissions and hooks use pnpm; design D11, D12, D13)

- [ ] 5.1 Update `tests/release/agent-policy.test.ts` to expect:
  - the pnpm allow patterns;
  - e2e ask rules for `pnpm run test:e2e*`, `pnpm exec vitest run *e2e*`, `npm run test:e2e*` and `npx vitest run *e2e*`;
  - no broad `pnpm exec vitest run *` allow;
  - deny rules for both `npm publish*` and `pnpm publish*`.
  Then update `.claude/settings.json` to match. Verify: `pnpm exec vitest run tests/release/agent-policy.test.ts`
- [ ] 5.2 Switch `.husky/commit-msg` to `pnpm exec commitlint --edit "$1"`, and `tests/release/commit-policy.test.ts` to spawn `pnpm exec commitlint`. Verify: `pnpm exec vitest run tests/release/commit-policy.test.ts && printf 'feat: ok\n' > "$TMPDIR/msg" && sh .husky/commit-msg "$TMPDIR/msg"`
- [ ] 5.3 Change the `.claude/hooks/lint-on-edit.mjs` fallback and its overflow hint to `pnpm exec eslint`, with assertions in `tests/harness/lint-on-edit.test.ts` if it covers the hint; change `tests/e2e.test.ts` to start the server with `pnpm exec ts-node`, and update its process-group comment. Verify: `pnpm exec vitest run tests/harness`

## 6. CI and release workflows (spec: frozen installs; design D7)

- [ ] 6.1 Extend the release tests first:
  - `tests/release/release-workflow.test.ts`: the plan job's step list includes `pnpm/action-setup@v6` before `actions/setup-node@v7`; "Install dependencies" runs `pnpm install --frozen-lockfile --ignore-scripts`; "Plan the release" runs `pnpm run release:plan`.
  - New assertion in `tests/release/package-manager.test.ts`: in `ci.yml` and `release.yml`, every job that uses `actions/setup-node` runs `pnpm/action-setup@v6` earlier, with no `version` input, and sets `cache: pnpm`; no `run` contains `npm ci`, `npm run` or `npx`.
  Then update `.github/workflows/ci.yml` (five jobs, commitlint steps via `pnpm exec commitlint`, remove the `npm ls --all` step and its comment line) and `.github/workflows/release.yml`. Verify: `pnpm exec vitest run tests/release`

## 7. Docker builder (spec: Docker builder uses the pinned version; design D8)

- [ ] 7.1 Add a `tests/release/package-manager.test.ts` assertion that the Dockerfile builder's `ARG PNPM_VERSION` equals the `packageManager` version and that the Dockerfile copies `pnpm-lock.yaml` and `pnpm-workspace.yaml`, not `package-lock.json`. Then rewrite the builder stage:
  - `ARG PNPM_VERSION`, `ENV CI=true`, then `npm install -g pnpm@${PNPM_VERSION}`;
  - copy the manifests and `pnpm install --frozen-lockfile`;
  - `pnpm run build`;
  - `pnpm prune --prod`, or the D8 fallback;
  - update the stage comments.
  Verify: `pnpm exec vitest run tests/release/package-manager.test.ts && docker build --target server -t line-mcp-server:test . && docker build --target line-mcp -t line-mcp-standalone:test . && pnpm exec vitest run tests/docker/docker-smoke.test.ts`

## 8. Documentation

- [ ] 8.1 Update the doc assertions in `tests/release/verify-entrypoint.test.ts` (`pnpm run verify`, `pnpm run verify:changed`, `pnpm run verify:all`, `pnpm run test:e2e` in `AGENTS.md`). Then update `AGENTS.md`:
  - the command list, gates and ladder;
  - a setup line with `pnpm install` and the pinned version;
  - a note that the store must share a filesystem with the worktrees;
  - the hard rule naming both `npm publish` and `pnpm publish`.
  Also update `CLAUDE.md` (the permissions summary), `README.md` (install, commands, CI job descriptions, wording about the npm-workspace monorepo), `docs/ARCHITECTURE.md` (the workspace description, the Docker builder, `pnpm exec openspec`, the ladder) and `docs/RELEASING.md` (`pnpm run release:plan`). Keep wording about the public npm registry policy and the `npm pack` consumer test. Verify: `pnpm exec vitest run tests/release && pnpm exec openspec validate --all --strict`

## 9. Final gate

- [ ] 9.1 Run the full ladder rung required for Dockerfile and packaging changes. Record in `apply.md`:
  - the results;
  - fresh-worktree install timings for npm and for pnpm with a warm store;
  - the known unrelated `oauth-router.test.ts` ECONNREFUSED failures, if they appear, with the same result on the npm baseline.
  Verify: `pnpm run verify:all`
