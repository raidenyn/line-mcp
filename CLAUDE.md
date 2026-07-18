# CLAUDE.md

Operational guide for agents working in this repository. Deep architecture
reference: `docs/ARCHITECTURE.md`.

This is a **LINE MCP server** — an npm-workspace monorepo of six TypeScript
packages (`packages/*`, `tsc -b`, CommonJS output) building two runnable
servers: the composed server (`@raidenyn/server`, ten tools) and the
standalone messenger server (`@raidenyn/line-mcp`, five tools).

## Commands

```bash
npm run build        # tsc -b — composite build of all six packages
npm run clean        # tsc -b --clean
npm start            # composed server: node packages/server/dist/cli.js (HTTP MCP on localhost:3000)
node packages/line-mcp/dist/cli.js                       # standalone messenger server
npm run lint         # eslint .
npm run test:unit    # in-process unit / contract / migration + import-boundary tests
npm run test:smoke   # local LINE mock + compiled CLIs (no credentials, no Docker)
npm run test:e2e     # live LINE e2e (requires .line-auth.json; manual, pre-release only)
npx vitest run <file>                                    # single test file
npx vitest run tests/docker/docker-smoke.test.ts         # both Docker targets: healthz + tools/list
npx vitest run tests/artifacts/line-client-pack.test.ts  # packed line-client artifact check
```

`LINE_API_BASE_URL` repoints the LINE client at a different gateway — tests
and development only. Production leaves it unset; any override still receives
real LINE authorization headers, so only point it at a trusted endpoint.

## Workflow

**Branching**

- Start every new brainstorming/feature session on a fresh `type/<topic>`
  branch (`feat/`, `fix/`, `docs/`, `chore/`, …) created from `origin/main`.
- Never commit directly to `main`. Do not create or offer git worktrees.
- If `origin/master` is requested but absent, use `origin/main`.

**Commits & PR titles — Conventional Commits, semver-mapped**

- Format `type(scope?): subject`. Allowed types: `feat`, `fix`, `refactor`,
  `test`, `docs`, `chore`, `ci`, `build`, `perf`.
- Breaking changes: `!` after the type/scope, or a `BREAKING CHANGE:` footer.
- Semver mapping: `feat` → minor, `fix` → patch, breaking → major.
- **Name every PR in the identical format** — squash-merge turns the PR
  title into the commit subject on `main`.

**Pre-PR gate (mandatory)**

- Always, before creating any PR:
  `npm run lint && npm run build && npm run test:unit && npm run test:smoke`
- Touched `Dockerfile` or `docker-compose.yml` → also
  `npx vitest run tests/docker/docker-smoke.test.ts`
- Touched line-client packaging, vendoring, or `assets` → also
  `npx vitest run tests/artifacts/line-client-pack.test.ts`
- The live e2e suite is manual-only; never required for a PR.

**Code review**

- If a PR already exists for the branch, post review findings as inline
  comments anchored to the relevant lines of that PR; report in chat only
  when there is no PR.

## Code style

`npm run lint` must pass. Match the conventions of the file you are editing.

## Hard rules

- Never edit `packages/line-client/assets/ltsm/*` (proprietary LINE artifacts).
- Never `npm publish` any package — no public distribution is approved.
- Never run two servers against the same data root.

## Doc map

- `README.md` — user-facing overview, tool tables, Docker usage, security notes.
- `docs/ARCHITECTURE.md` — packages, guides, auth, persistence, Docker, test
  details. **Update it in the same PR as any structural change.**
- `specs/*.md` — reverse-engineered LINE protocol reference.
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — design docs and
  implementation plans; new designs go here.
- `packages/line-client/THIRD_PARTY_NOTICES.md` — LTSM distribution policy.
