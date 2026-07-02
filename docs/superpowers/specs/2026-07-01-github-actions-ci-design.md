# GitHub Actions CI (Lint + Build + Unit Tests on PRs)

**Date:** 2026-07-01
**Status:** Approved

## Overview

The repo has no CI and no linter. This spec adds a GitHub Actions workflow that runs on every pull request, and adds an ESLint setup to make the "run linter" part of that meaningful.

## Scope

- New: `.github/workflows/ci.yml`
- New: `eslint.config.js` (flat config)
- New devDependencies: `eslint`, `typescript-eslint`, `@eslint/js`
- New `package.json` script: `"lint": "eslint ."`
- Fix any pre-existing lint violations found when the new linter is first run, so CI starts green.

**Out of scope:**
- e2e tests (`tests/e2e.test.ts`) — require a real `.line-auth.json` LINE login session; cannot run in CI without live credentials. Remain a local-only/manual check.
- Prettier / formatting enforcement.
- Branch protection rules (repo admin setting, not a code change).

## Workflow

**File:** `.github/workflows/ci.yml`

**Trigger:** `pull_request` targeting `main`.

**Job (single job, ubuntu-latest):**
1. `actions/checkout@v4`
2. `actions/setup-node@v4` — `node-version: 24`, `cache: npm`
3. `npm ci`
4. `npm run lint`
5. `npm run build`
6. `npm run test:unit`

No matrix — Node 24 only, matching the local dev environment. All four steps run in one job (fail-fast is fine; there's no benefit to parallelizing four fast steps into separate jobs for a repo this size).

## ESLint Setup

- Flat config (`eslint.config.js`), since installed ESLint will be v9+.
- `@eslint/js` recommended rules + `typescript-eslint` recommended rules.
- Lint scope: `src/**/*.ts` and `tests/**/*.ts`.
- Excludes: `dist/`, `node_modules/`, `src/ltsm/ltsmSandbox.js` (vendored/extracted third-party code, not to be edited or held to project lint rules).

## Testing / Validation

- After the workflow is added, push a branch and open a PR against `main` so Actions actually runs.
- Confirm lint, build, and test:unit steps all pass in the Actions run (fix any real violations surfaced by the new linter rather than suppressing them, unless a rule is clearly wrong for this codebase).

## Files Changed

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | New CI workflow |
| `eslint.config.js` | New ESLint flat config |
| `package.json` | Add `lint` script + eslint/typescript-eslint devDependencies |
| (any files with lint violations) | Fix violations surfaced by first lint run |
