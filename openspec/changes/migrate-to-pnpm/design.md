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
Dockerfile's `PNPM_VERSION` equals it. The pin stays exact. With 12.18.0's
default `pmOnFail: download`, a different globally installed pnpm downloads and
runs the pinned version instead of refusing, so every checkout runs 12.18.0.
That default is kept on purpose and documented in AGENTS.md.

**D2. Lockfile from `pnpm import`, with a parity check.** `pnpm import`
re-resolves the tree, using the versions in `package-lock.json` as preferences,
so parity is checked rather than assumed. The check is
`tools/lockfile-parity.mjs` in this change folder, run as
`node tools/lockfile-parity.mjs <dir-with-yaml-installed> <package-lock.json> <pnpm-lock.yaml>`.
It loads `yaml` through `createRequire`, and it reads the last YAML document
of `pnpm-lock.yaml`, because the pinned `packageManager` can add a leading
document. It reports four things:

1. **Inventory**: the `name@version` sets from both lockfiles. Entries with
   `inBundle: true` are listed separately, because pnpm does not record
   bundled packages.
2. **Importer edges**: for each importer and each dependency, including
   `devDependencies`, `optionalDependencies` and `peerDependencies`, the
   resolved version on each side.
   - npm: the version found by Node's lookup over the lockfile paths.
   - pnpm: `importers.<id>.<section>.<name>.version`, with workspace links
     compared by name.
3. **Package edges** in parent context: for each `parent@version` and child,
   the set of child versions across every instance of that parent.
   - npm: Node's lookup from each instance path.
   - pnpm: `snapshots`, with peer suffixes stripped.

   npm records no peer-context identity, so per-parent-version sets are the
   finest level the two lockfiles can be compared at. That limitation is
   accepted.
4. **Deliberate manifest edges** (D3/D4) are checked separately, so they are
   not mistaken for drift: root dev dependencies on `@raidenyn/line-mcp` and
   `@raidenyn/server`, and the `server` dev dependency on `better-sqlite3`.
   The tool runs twice.
   - Right after `pnpm import`, before those edits.
   - Again on the lockfile that ships. That run must show the same inventory
     and package edges, plus exactly those three importer edges. Workspace
     links are compared by their resolved target path, and `better-sqlite3`
     must resolve to the already-locked 12.11.1.

**Result on pnpm 12.18.0** (run on 2026-11-25 against the current
`package-lock.json`, before the manifest additions):
- importer edges: no differences;
- inventory: only `ansi-regex@6.2.2` and `content-type@2.0.0` disappear;
- package edges: four parents were deduplicated onto a version already
  locked elsewhere and within their declared ranges:
  - `type-is@2.1.0` and `@octokit/request@10.0.11`: `content-type` 2.0.0 →
    2.1.0. 2.1.0 is already used by `body-parser`. `type-is` is a production
    dependency of `express`.
  - `marked-terminal@7.3.0` and `strip-ansi@7.2.0`: `ansi-regex` 6.2.2 →
    6.6.0. 6.6.0 is already locked. These are release tooling only.
- also different, as expected:
  - `debug@4.4.3 → supports-color@7.2.0`: pnpm links an optional peer that is
    already present;
  - 65 edges under `npm@11.18.0`: its bundled dependencies, which pnpm does
    not list.

These dedupe changes are accepted as the migration's only dependency drift,
and `apply.md` records them. Any further difference in the implementation run
(for example after the lockfile changes again) stops the work, and is reported
to the owner rather than patched. A fix, if one is wanted, is a reviewed
parent-scoped `overrides` entry. After the check, `package-lock.json` is
deleted and `.gitignore` ignores it.

**D3. Isolated (default) `node_modules` layout.** Not `node-linker=hoisted`
(see brainstorm, Alternative B). Undeclared imports become failures, which is
desirable. The isolated layout alone does not prove that packages declare
their imports: a package can still resolve anything in the root's
`node_modules` by walking up the directory tree. A release test therefore
checks that each package's bare imports are declared by that package, with an
explicit shared-test-tooling exception (`vitest`, declared once at the root).
Specifiers are taken from TypeScript's `ts.preProcessFile` (imports, exports,
`import()`, and `require` calls; comments ignored), not a text scan. The same
check covers root-level code (`tests/**`, `scripts/**`, `vitest.config.ts`,
`eslint.config.js`) against the root manifest, and internal ranges in
`dependencies`, `devDependencies`, `peerDependencies` and
`optionalDependencies`.
Imports found today:
- `packages/server` tests import `better-sqlite3` without declaring it, so it
  becomes a server dev dependency.
- `@modelcontextprotocol/sdk` is a peer dependency of `bank-mcp`, `line-mcp`
  and `mcp-runtime`, which counts as declared.

The root adds `@raidenyn/line-mcp` and `@raidenyn/server` as dev dependencies,
because root tests import them. `@raidenyn/bank-mcp` is not added, because
nothing at the root imports it.

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
  fsevents: false
verifyDepsBeforeRun: false
```
- `allowBuilds` and `strictDepBuilds` (on by default) were verified on 12.18.0.
  An unlisted build script fails the install (`ERR_PNPM_IGNORED_BUILDS`),
  which is the intended gate.
- `fsevents` (macOS-only, has an install script) is denied explicitly, so a
  macOS install does not fail on it. It is an optional dependency of the
  watcher tooling and is not needed at build or run time.
- `pnpm-lock.yaml` does not record which packages have install scripts, so
  completeness is enforced by pnpm itself: with `strictDepBuilds`, an install
  on a platform that meets an unlisted script fails. Linux is verified locally
  and in CI. The only macOS-specific script in the tree, `fsevents`, is listed
  explicitly.
- `verifyDepsBeforeRun: false` keeps `pnpm run` and `pnpm exec` from
  installing anything implicitly, so the release plan job's scripts-disabled
  install stays the only install there.
- No `.npmrc`.

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
before `actions/setup-node@v7` with `cache: pnpm`, then
`pnpm install --frozen-lockfile`. The action gets no `version` input, so it
reads `packageManager`, and no `run_install` input, so it does not install by
itself. The release `plan` job keeps `--ignore-scripts`, and its step list
gains `pnpm/action-setup@v6`.

The `check` job's `npm ls --all` dependency-closure check is replaced by two
signals:
- the frozen install (lockfile and manifests agree) together with the
  declared-import guard (D3), which cover missing and extraneous dependencies;
- a `Peer dependency check` step running `node scripts/check-peers.mjs`, which
  covers invalid peers. A frozen install skips peer diagnostics.

`scripts/check-peers.mjs` runs `pnpm peers check --lockfile-only --json`. It
exits 1, printing the offending entries, when any importer has a non-empty
`bad` or `missing` object or a non-empty `conflicts` array. Verified on
12.18.0: the command reports all seven importers with empty fields today.

A release test asserts the install steps exactly. The set of jobs that set up
Node is `ci.yml` {`commit-policy`, `check`, `pack-line-client`, `docker`,
`smoke`} and `release.yml` {`plan`}. Each has exactly one step whose `run`
mentions `pnpm install` (`--ignore-scripts` added for `plan`), and that step's
`run` equals the expected command after trimming. The `pnpm/action-setup` step
has no `with` block. The negative assertions in
`release-workflow.test.ts` (no publish, no release run) extend to
`pnpm publish` and `pnpm run release`.

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
- The single production recipe is `pnpm prune --prod` at the workspace root.
  On 12.18.0 it was verified to remove TypeScript, Vitest and ESLint from
  `.pnpm` and keep the built `better-sqlite3` addon.
- The runtime stages are unchanged in shape. They copy `/app/node_modules`
  (which holds `.pnpm` and relative symlinks) and the `packages/` tree, which
  carries each package's `node_modules` symlinks into `/app/node_modules/.pnpm`.
- The standalone target still copies only its four packages, and their
  symlinks resolve within the copied root `node_modules`.
- `docker-smoke.test.ts` proves both targets load `better-sqlite3` and serve
  `tools/list`. It gains a layout case per image, run with
  `docker run --rm --entrypoint sh <image> -c …`, that asserts:
  - `find /app -xtype l` prints nothing (no dangling links);
  - `/app/node_modules/.pnpm` has no `typescript@`, `vitest@`, `eslint@`,
    `semantic-release@` or `@commitlint+` entries;
  - for the standalone image, no path under `/app` or symlink target
    (`find /app -type l -exec readlink {} +`) contains `packages/bank-mcp` or
    `packages/server`.

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

**D14. Verification environment.** The dev container runs Node 26 and has no
Docker daemon.
- Local gates run under Node 24, which the repository pins. The implementer
  downloads the official Node 24 Linux x64 tarball into `~/.cache/node24` and
  puts it first on `PATH` for every command in this change.
- The `oauth-router.test.ts` "non-root basePath" failures come from this
  container's `/etc/hosts`. Node binds `listen(0, 'localhost')` to `::1`,
  while the test client connects to `127.0.0.1`. They fail identically under
  npm and under Node 24, and pass with
  `NODE_OPTIONS=--dns-result-order=ipv4first`.
- Local gates run with that `NODE_OPTIONS`, and `apply.md` records that. The
  test itself is not changed here; that is a separate fix. If any gate still
  fails, the full gate is not green: the failure is recorded, and each
  downstream check is run on its own.
- The Docker rung (image builds, Docker smoke with the layout cases) runs in
  CI's `docker` job on the draft PR. This is a recorded one-off exception to
  the AGENTS.md rule that `verify:all` passes before a PR is opened; the owner
  approved it on 2026-11-25 because no Docker daemon is available. Before the
  draft opens, the implementer runs every non-Docker part of `verify:all`
  locally: `pnpm run verify` and the pack test. The PR stays draft until the
  `docker` job is green, and the PR description states the exception.

## Risks / Trade-offs

- [Contributors without pnpm cannot install] → README and AGENTS.md document
  `npm install -g pnpm@12.18.0` (or `corepack enable` on Node 24). pnpm's
  `packageManager` check reports a mismatched version clearly.
- [Store on a different filesystem from the worktree falls back to copying,
  which is slower] → Document that the store (default
  `~/.local/share/pnpm/store`) must share a filesystem with the worktrees. That
  is true in the current dev container.
- [Strict layout surfaces a phantom dependency only at runtime in Docker] →
  The Docker smoke runs both images' real CLI, a `tools/list` roundtrip and
  the layout cases. It runs in CI's `docker` job, which must be green before
  the PR is marked ready (D14).
- [macOS installs are not verified in this change] → `fsevents` is denied
  explicitly; a macOS contributor who hits another ignored build adds it to
  `allowBuilds` after review.
- [The `allowBuilds`/`prune` behaviour differs in 12.18.0 from the 12.23.0
  bench] → Both were re-checked on 12.18.0, and verification runs against the
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
