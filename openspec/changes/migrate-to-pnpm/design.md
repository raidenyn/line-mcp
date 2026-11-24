## Context

The repository is an npm-workspace monorepo with six TypeScript packages under
`packages/*`, built with one composite `tsc -b`. Packages consume each other
through compiled `dist` via `node_modules/@raidenyn/*` links. npm is assumed in:

- the root `package.json` (`workspaces`, `verify`/`verify:all`/`test:smoke`
  scripts built from `npm run` and `npx`) and `package-lock.json`;
- `scripts/verify-changed.mjs` (`npx --no-install eslint|vitest`);
- `.husky/commit-msg` (`npx --no -- commitlint`);
- `.claude/hooks/lint-on-edit.mjs` (falls back to `npx --no-install eslint`);
- `.claude/settings.json` allow/ask/deny patterns (`npm run …`, `npx vitest …`,
  `npm publish*`), asserted by `tests/release/agent-policy.test.ts`;
- `.github/workflows/ci.yml` (five jobs: `setup-node` with `cache: npm`,
  `npm ci`, `npm run …`, `npx …`, `npm ls --all`);
- `.github/workflows/release.yml` `plan` job (`npm ci --ignore-scripts`,
  `npm run release:plan`), asserted by `tests/release/release-workflow.test.ts`;
- the `Dockerfile` builder (`COPY package-lock.json`, `npm ci`, `npm run build`,
  `npm prune --omit=dev`);
- tests that read `package-lock.json` or pin npm text
  (`tests/architecture/import-boundaries.test.ts`,
  `tests/release/version-baseline.test.ts`,
  `tests/release/verify-entrypoint.test.ts`,
  `tests/release/commit-policy.test.ts`, `tests/e2e.test.ts`);
- `packages/line-client/scripts/vendor-happy-dom.js` (the `prepack` hook that
  copies happy-dom's closure into the package for `bundleDependencies`);
- docs (`AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`,
  `docs/RELEASING.md`).

No skill under `.agents/skills/` or `.claude/skills/`, and nothing under
`.opencode/`, references npm.

The benchmark and the breakage inventory are in `brainstorm.md`.

## Goals / Non-Goals

**Goals:**
- One pinned pnpm version used everywhere: local, hooks, CI, release, Docker.
- A fresh worktree is ready after `pnpm install --frozen-lockfile` from a warm
  store, in about a second.
- Same resolved dependency versions as today (lockfile imported, not
  re-resolved).
- Same images: both Docker targets still build, load `better-sqlite3`, and
  pass the Docker smoke.
- Every existing gate (`verify`, `verify:all`, CI jobs) keeps the same
  coverage.

**Non-Goals:**
- Per-target `pnpm deploy` in Docker to shrink the standalone image.
- Dependency upgrades: versions stay as locked today.
- `minimumReleaseAge` or other new supply-chain policy settings.
- Installing pnpm in the dev-container image (outside this repository).
- Fixing the unrelated `oauth-router.test.ts` ECONNREFUSED failures seen in
  this container.

## Decisions

**D1. pnpm 12.18.0, pinned through `packageManager`.** `"packageManager":
"pnpm@12.18.0"` in the root manifest is the single source of truth. 12.18.0 is
the newest 12.x release more than two weeks old (published 2026-11-05).
`pnpm/action-setup@v6` reads it in CI. A release test asserts that the
Dockerfile's `PNPM_VERSION` equals it. The pin stays exact: pnpm refuses to run
with a mismatched version when `packageManager` is set, which keeps local
installs consistent.

**D2. Lockfile from `pnpm import`.** `pnpm-lock.yaml` is generated from the
current `package-lock.json` with `pnpm import`, so resolved versions do not
move. `package-lock.json` is then deleted, and `.gitignore` ignores
`package-lock.json` to stop it from coming back.

**D3. Isolated (default) `node_modules` layout.** Not `node-linker=hoisted`
(see brainstorm, Alternative B). Undeclared imports become failures, which is
desirable. The root declares every workspace package that root-level tests and
scripts import (`@raidenyn/line-mcp`, `@raidenyn/server`, `@raidenyn/bank-mcp`
as dev dependencies, beside the existing root dependencies).

**D4. `workspace:^` for internal ranges.** This applies to the root and to
`bank-mcp`, `line-client-sqlite`, `line-mcp` and `server`. The release process
never bumps manifests or publishes, so publish-time rewriting is irrelevant.
`version-baseline.test.ts` then asserts `workspace:^` and reads versions from
the manifests, since `pnpm-lock.yaml` does not record workspace versions the
way `package-lock.json` did.

**D5. `pnpm-workspace.yaml` holds configuration.**
```yaml
packages:
  - packages/*
allowBuilds:
  better-sqlite3: true
```
No `.npmrc`. An unknown build script makes `pnpm install` fail
(`ERR_PNPM_IGNORED_BUILDS`), which is the intended gate. If 12.18.0 turns out
to need a different key than `allowBuilds` (verified against 12.23.0), use the
key that version documents, and record it in `apply.md`.

**D6. Command mapping.**
| npm | pnpm |
| --- | --- |
| `npm ci` | `pnpm install --frozen-lockfile` |
| `npm ci --ignore-scripts` | `pnpm install --frozen-lockfile --ignore-scripts` |
| `npm run <s>` | `pnpm run <s>` |
| `npx <bin>` / `npx --no-install <bin>` | `pnpm exec <bin>` |
| `npm run commitlint -- <args>` | `pnpm exec commitlint <args>` |

User-facing scripts keep their names (`verify`, `test:unit`, …). Docs say
`pnpm run verify`, and `pnpm verify` also works.

**D7. CI.** Each job that installs dependencies adds `pnpm/action-setup@v6`
(no `version` input, so it reads `packageManager`) before `actions/setup-node@v7`
with `cache: pnpm`, then `pnpm install --frozen-lockfile`. The `check` job's
`npm ls --all` "dependency-closure check" is replaced by
`pnpm install --frozen-lockfile` (lockfile and manifests must agree) together
with the isolated layout, which fails the build and tests on undeclared imports.
The step is removed, not translated: `pnpm ls` does not fail on the problems
`npm ls` reported. The release `plan` job keeps `--ignore-scripts`; its step
list gains `pnpm/action-setup@v6`.

**D8. Docker builder.**
```dockerfile
FROM node:24 AS builder
ARG PNPM_VERSION=12.18.0
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/<each>/package.json …
RUN pnpm install --frozen-lockfile
…
RUN pnpm run build
RUN pnpm prune --prod
```
- pnpm is installed with npm, not corepack: corepack is not bundled from Node 25
  on and has key-rotation failures.
- `CI=true` stops pnpm from prompting before it recreates `node_modules`
  without a TTY.
- If `pnpm prune --prod` does not reduce the tree in 12.18.0, use
  `pnpm install --prod --frozen-lockfile --offline` instead.
- The runtime stages are unchanged in shape. They copy `/app/node_modules`
  (which holds `.pnpm` and relative symlinks) and the `packages/` tree, which
  carries each package's `node_modules` symlinks into `/app/node_modules/.pnpm`.
- The standalone target still copies only its four packages, and their
  symlinks resolve within the copied root `node_modules`.
- `docker-smoke.test.ts` proves both targets load `better-sqlite3` and serve
  `tools/list`.

**D9. happy-dom vendoring.** `vendor-happy-dom.js` resolves every package
directory through `fs.realpathSync` before recursing. Under pnpm this finds
happy-dom's dependencies as siblings inside
`node_modules/.pnpm/<pkg>@<ver>/node_modules/`, and under npm it changes
nothing. The script keeps copying with `dereference: true` and replacing the
pnpm symlink at `packages/line-client/node_modules/happy-dom` with a real copy.
This is required: `npm pack` crashes ("Exit handler never called!") when the
bundled dependency is a symlink. The copy never writes into the store, because
`rmSync` on the symlink removes only the link. A later `pnpm install` may
restore the symlink, and the next `prepack` re-vendors.

**D10. The packed-artifact test stays on npm.** `line-client-pack.test.ts`
simulates an external consumer: `npm pack`, `npm init`, offline
`npm install` of the tarball, `npm ls`. That is correct consumer behaviour and
needs no pnpm. Only comments that describe the workspace layout change.
`TSC_BIN` (`node_modules/.bin/tsc`) still exists under pnpm.

**D11. Agent policy.**
- Allow patterns become `Bash(pnpm run lint*)`, `Bash(pnpm run build*)`,
  `Bash(pnpm run test:unit*)`, `Bash(pnpm run test:smoke*)`,
  `Bash(pnpm run verify*)`, `Bash(pnpm exec vitest run packages*)` (and the
  same for each `tests/*` prefix listed today), and `Bash(pnpm exec eslint *)`.
- The ask list covers the e2e suite in both managers' forms
  (`Bash(pnpm run test:e2e*)`, `Bash(pnpm exec vitest run *e2e*)`,
  `Bash(npm run test:e2e*)`, `Bash(npx vitest run *e2e*)`), because
  `node_modules/.bin` still makes `npx` work.
- The deny list keeps `Bash(npm publish*)` and adds `Bash(pnpm publish*)`.
- `agent-policy.test.ts` asserts all of this. The `AGENTS.md` hard rule names
  both managers.

**D12. Hooks.**
- `.husky/commit-msg` runs `pnpm exec commitlint --edit "$1"`.
- `lint-on-edit.mjs` keeps preferring `node_modules/.bin/eslint`, falls back to
  `pnpm exec eslint`, and prints `pnpm exec eslint <file>` in its overflow
  hint.
- `session-context.mjs` already reads `node_modules/.bin/openspec`, which pnpm
  also creates, so it needs no change.

**D13. Tests that encode npm.** These are updated in the same task as the code
they guard:
- `import-boundaries.test.ts`: the workspace is declared in
  `pnpm-workspace.yaml` as `packages/*`, there is a single root
  `pnpm-lock.yaml`, and there are no package-local `pnpm-lock.yaml` or
  `package-lock.json` files.
- `verify-entrypoint.test.ts`: `pnpm run` and `pnpm exec` forms, one build.
- `release-workflow.test.ts`: the plan step list and its commands.
- `commit-policy.test.ts`: spawns `pnpm exec commitlint`.
- `e2e.test.ts`: `pnpm exec ts-node`.
- `version-baseline.test.ts`: per D4.

## Risks / Trade-offs

- [Contributors without pnpm cannot install] → README and AGENTS.md document
  `npm install -g pnpm@12.18.0` (or `corepack enable` on Node 24). pnpm's
  `packageManager` check reports a mismatched version clearly.
- [Store on a different filesystem from the worktree falls back to copying,
  which is slower] → Document that the store (default
  `~/.local/share/pnpm/store`) must share a filesystem with the worktrees. That
  is true in the current dev container.
- [Strict layout surfaces a phantom dependency only at runtime in Docker] →
  The Docker smoke runs both images' real CLI and a `tools/list` roundtrip.
  `pnpm run verify:all` is required for this change.
- [The `allowBuilds`/`prune` behaviour differs in 12.18.0 from the 12.23.0
  bench] → D5 and D8 name the fallbacks, and verification runs against the
  pinned version.
- [`npm pack` on the pnpm layout regresses later] → The CI `pack-line-client`
  job keeps running the real pack/install test.
- [Lockfile diff is unreadable in review] → It is generated by `pnpm import`
  from the reviewed `package-lock.json`. Reviewers check that the
  `pnpm ls -r --depth 0` versions match the old `npm ls --depth 0` output,
  recorded in `apply.md`.

## Migration Plan

1. One PR switches everything: there is no supported mixed state, and CI must
   be green on pnpm before merge.
2. After merge, each existing worktree runs `pnpm install` once. A stale npm
   `node_modules` tree is replaced, and pnpm asks for confirmation or removes
   it under `CI=true`.
3. Rollback: revert the PR. `package-lock.json` returns with it, and
   `npm ci` works again.

## Open Questions

None.
