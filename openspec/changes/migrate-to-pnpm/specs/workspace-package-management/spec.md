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
Every package, including the root, MUST declare each workspace or third-party
package that its code or tests import.

#### Scenario: Internal ranges use the workspace protocol

- **WHEN** any manifest depends on an `@raidenyn/*` workspace package
- **THEN** the range is `workspace:^`

#### Scenario: Root tests resolve workspace packages they import

- **WHEN** the root smoke and support tests import `@raidenyn/line-mcp`, `@raidenyn/server` or another workspace package
- **THEN** that package is a declared dependency or dev dependency of the root
- **AND** the import resolves under pnpm's isolated `node_modules` layout

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
`pnpm-workspace.yaml` explicitly allows. `better-sqlite3` MUST be allowed so
that its native addon is built. An install that meets an unlisted build script
MUST fail rather than silently skip it.

#### Scenario: better-sqlite3 native addon is built

- **WHEN** `pnpm install --frozen-lockfile` completes in a fresh checkout
- **THEN** `better-sqlite3` loads and runs a query from a workspace package that depends on it

#### Scenario: Unlisted build script is rejected

- **WHEN** a newly added dependency declares an install script and is not allowlisted
- **THEN** `pnpm install` fails and names the ignored build

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
