## ADDED Requirements

### Requirement: pnpm is the single pinned package manager

The repository MUST declare its package manager as an exact pnpm version in the
root `package.json` `packageManager` field. The repository MUST NOT contain a
`package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`. Every place that pins
pnpm separately (the Docker builder) MUST use the same version.

#### Scenario: Manifest pins pnpm exactly

- **WHEN** a reader checks the root `package.json`
- **THEN** `packageManager` is `pnpm@<major>.<minor>.<patch>` with no range

#### Scenario: No npm lockfile is tracked

- **WHEN** the repository files are listed
- **THEN** `pnpm-lock.yaml` exists at the root
- **AND** no `package-lock.json` or `npm-shrinkwrap.json` exists anywhere outside `node_modules`

#### Scenario: Docker builder uses the pinned version

- **WHEN** the `Dockerfile` builder stage installs pnpm
- **THEN** the version it installs equals the `packageManager` version

### Requirement: Workspace packages are declared and linked through the workspace protocol

The workspace MUST be declared in `pnpm-workspace.yaml` as `packages/*`. Every
dependency on another workspace package MUST use the `workspace:` protocol.
Every package, including the root, MUST declare (as a dependency, dev
dependency or peer dependency) each workspace or third-party package that its
code or tests import. The only exception is shared test tooling that the root
declares for all packages; that list MUST be explicit and currently contains
only `vitest`.

#### Scenario: Internal ranges use the workspace protocol

- **WHEN** any manifest depends on an `@raidenyn/*` workspace package
- **THEN** the range is `workspace:^`

#### Scenario: Root tests resolve workspace packages they import

- **WHEN** the root smoke and support tests import `@raidenyn/line-mcp`, `@raidenyn/server` or another workspace package
- **THEN** that package is a declared dependency or dev dependency of the root
- **AND** the import resolves under pnpm's isolated `node_modules` layout

#### Scenario: Package imports are declared by the owning package

- **WHEN** a source or test file under `packages/<name>/src` imports a bare specifier that is not a Node built-in or listed shared test tooling
- **THEN** `packages/<name>/package.json` declares it in `dependencies`, `devDependencies` or `peerDependencies`

### Requirement: Installs are reproducible from the lockfile

Every automated install (CI jobs, the release plan job, the Docker builder) MUST
run `pnpm install --frozen-lockfile`, adding `--ignore-scripts` where scripts
are disabled today, and MUST fail when the lockfile does not match the
manifests.

#### Scenario: CI installs with a frozen lockfile

- **WHEN** a CI job that needs dependencies runs
- **THEN** it sets up pnpm from `packageManager` and runs `pnpm install --frozen-lockfile`

#### Scenario: Release plan installs without scripts

- **WHEN** the release workflow's `plan` job installs dependencies
- **THEN** it runs `pnpm install --frozen-lockfile --ignore-scripts`

### Requirement: Dependency build scripts are allowlisted

Dependency lifecycle build scripts MUST run only for packages that
`pnpm-workspace.yaml` explicitly allows. Every locked dependency that declares
an install script MUST be listed explicitly, either allowed or denied:
`better-sqlite3` MUST be allowed so that its native addon is built, and the
macOS-only `fsevents` MUST be denied. When scripts are enabled, an install that
meets an unlisted build script MUST fail rather than silently skip it.

#### Scenario: better-sqlite3 native addon is built

- **WHEN** `pnpm install --frozen-lockfile` completes in a fresh checkout
- **THEN** a workspace package that depends on `better-sqlite3` opens an in-memory database and runs a query

#### Scenario: Every locked install script is reviewed

- **WHEN** `pnpm install --frozen-lockfile` runs with scripts enabled on Linux, or on macOS where `fsevents` is installed
- **THEN** it completes without an ignored-build error, because every package with an install script is listed in `allowBuilds`

#### Scenario: Unlisted build script is rejected

- **WHEN** an install with scripts enabled meets a dependency that declares an install script and is not listed in `allowBuilds`
- **THEN** `pnpm install` fails and names the ignored build

### Requirement: Docker images ship a production-only, link-complete tree

Both runtime images MUST contain no broken symlinks under `/app`, MUST NOT
contain development-only packages (TypeScript, Vitest, ESLint, semantic-release,
commitlint) in the shipped `node_modules`, and the standalone `line-mcp` image
MUST NOT contain or link to the `bank-mcp` or `server` packages.

#### Scenario: Composed image layout

- **WHEN** the `server` image is inspected
- **THEN** no symlink under `/app` is dangling
- **AND** `/app/node_modules/.pnpm` contains no `typescript@`, `vitest@`, `eslint@`, `semantic-release@` or `@commitlint+` entries

#### Scenario: Standalone image layout

- **WHEN** the `line-mcp` image is inspected
- **THEN** no symlink under `/app` is dangling
- **AND** no path or symlink target under `/app` refers to `packages/bank-mcp` or `packages/server`

### Requirement: The packed line-client artifact remains consumable by npm

`npm pack` of `@raidenyn/line-client` MUST still bundle happy-dom's full
dependency closure when the workspace is installed with pnpm. The packed
artifact gate MUST keep using npm to pack, install and inspect the tarball, as
an external consumer would.

#### Scenario: Pack under the pnpm layout

- **WHEN** `npm pack` runs in `packages/line-client` of a pnpm-installed workspace
- **THEN** the prepack vendoring resolves happy-dom and every transitive dependency
- **AND** the tarball installs offline into a directory outside the checkout with no unmet dependencies

### Requirement: Agent permissions and hooks use pnpm commands

The committed agent policy MUST allow the pnpm forms of the lint, build, unit,
smoke and verify commands. It MUST ask before running the live e2e suite in
both its pnpm and npm/npx forms. It MUST deny both `npm publish` and
`pnpm publish`. The commit-message hook and the lint-on-edit hook MUST invoke
tools through pnpm or the local `node_modules/.bin`, not `npx`.

#### Scenario: Publishing is denied for both managers

- **WHEN** an agent attempts `pnpm publish` or `npm publish`
- **THEN** the committed policy denies the command

#### Scenario: e2e suite still asks

- **WHEN** an agent runs `pnpm run test:e2e` or `npx vitest run tests/e2e.test.ts`
- **THEN** the committed policy asks before running it
