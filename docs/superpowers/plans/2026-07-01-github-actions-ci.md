# GitHub Actions CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that runs ESLint, `tsc` build, and unit tests on every pull request, with the repo's first-ever linter set up and existing lint violations fixed so CI starts green.

**Architecture:** One workflow file (`.github/workflows/ci.yml`) triggered on `pull_request` to `main`, running a single job on Node 24: `npm ci` → `npm run lint` → `npm run build` → `npm run test:unit`. ESLint uses flat config (`eslint.config.js`) with `@eslint/js` + `typescript-eslint` recommended rules.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`), ESLint 10 (flat config), typescript-eslint 8, existing `vitest` + `tsc` toolchain.

## Global Constraints

- CI runs on Node 24 only (matches local dev, `node --version` → v24.15.0).
- CI runs `test:unit` only — never `test` or `test:e2e` (those require a real `.line-auth.json` LINE session that doesn't exist in CI). Spec: `docs/superpowers/specs/2026-07-01-github-actions-ci-design.md`.
- Trigger is `pull_request` targeting `main` only — no push trigger, no matrix.
- ESLint must exclude `dist/**`, `node_modules/**`, `package/**` (a pre-existing gitignored build artifact directory at repo root), and `src/ltsm/ltsmSandbox.js` (vendored third-party sandbox code).
- Fix pre-existing lint violations by editing the flagged code directly (or a scoped inline `eslint-disable-next-line` when the flagged pattern is intentional) — never by disabling a rule repo-wide to silence it.

---

### Task 1: Add ESLint, fix all pre-existing violations

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (add devDependencies + `lint` script)
- Modify: `src/line-client.test.ts:1` (remove unused import)
- Modify: `src/line-client.ts:538-542` (remove useless assignment)
- Modify: `src/ltsm.ts:115` (inline disable for intentional dynamic require)
- Modify: `tests/e2e.test.ts:36-38` (ternary → if/else)
- Modify: `src/caching-line-client.test.ts` (replace `as any` with a properly-typed cast, 13 call sites)
- Modify: `src/export-parser.ts:5,69` (inline disable for intentional BOM-strip regex)
- Test: none new — this task's "test" is the linter itself plus the existing test suite staying green

**Interfaces:**
- Produces: `npm run lint` (exit 0 on clean tree, non-zero with error list otherwise) — used by Task 2's CI workflow.

- [ ] **Step 1: Install ESLint dependencies**

Run:
```bash
npm install --save-dev eslint@^10.6.0 typescript-eslint@^8.62.1 @eslint/js@^10.0.1
```

Expected: `package.json` `devDependencies` gains `eslint`, `typescript-eslint`, `@eslint/js`; `package-lock.json` updates.

- [ ] **Step 2: Create the ESLint flat config**

Create `eslint.config.js`:

```javascript
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'package/**', 'src/ltsm/ltsmSandbox.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 3: Add the `lint` script**

In `package.json`, add to `"scripts"`:

```json
"lint": "eslint ."
```

Resulting `scripts` block:
```json
"scripts": {
  "test": "vitest run",
  "test:unit": "vitest run src",
  "test:e2e": "vitest run tests",
  "build": "tsc && cp src/index.html dist/index.html && cp -r src/ltsm dist/ltsm",
  "start": "ts-node src/index.ts",
  "lint": "eslint ."
}
```

- [ ] **Step 4: Run lint and confirm the known violation set**

Run: `npm run lint`

Expected: fails with exactly these violations (87 errors across 8 files — `package/dist/cjs/types.d.ts` is excluded by the `package/**` ignore, so it will NOT appear):
- `src/caching-line-client.test.ts` — 13× `@typescript-eslint/no-explicit-any`
- `src/export-parser.ts` — 2× `no-irregular-whitespace` (lines 5, 69)
- `src/index.ts` — 10× `@typescript-eslint/no-unused-vars` for `_uri` (these will be auto-fixed by Step 2's `argsIgnorePattern` — if they still show, config wasn't picked up; re-check Step 2)
- `src/line-client.test.ts` — 1× `@typescript-eslint/no-unused-vars` (`beforeEach`)
- `src/line-client.ts` — 1× `no-useless-assignment` (line 538)
- `src/ltsm.test.ts` — unused-vars for `_body`/`_init`/`_opts` (auto-fixed by `argsIgnorePattern`, same as `index.ts`)
- `src/ltsm.ts` — 1× `@typescript-eslint/no-require-imports` (line 115)
- `tests/e2e.test.ts` — 1× `@typescript-eslint/no-unused-expressions` (line 37)

If `src/index.ts` and `src/ltsm.test.ts` show 0 errors already (because `argsIgnorePattern: '^_'` took effect), that's correct — only the remaining 6 files need manual fixes below.

- [ ] **Step 5: Fix `src/line-client.test.ts` — remove unused import**

```typescript
// Before (line 1)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// After
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 6: Fix `src/line-client.ts` — remove useless assignment**

```typescript
// Before (lines 538-542)
    let allRaw: RawMessage[] = [];

    const firstPage = await this.fetchRawPage(chatMid, pageSize);
    const page0 = firstPage ?? [];
    allRaw = [...page0];

// After
    const firstPage = await this.fetchRawPage(chatMid, pageSize);
    const page0 = firstPage ?? [];
    let allRaw: RawMessage[] = [...page0];
```

- [ ] **Step 7: Fix `src/ltsm.ts` — annotate the intentional dynamic require**

```typescript
// Before (line 115)
    require('./ltsm/ltsmSandbox.js');

// After
    // Loaded dynamically at runtime after global fetch/window shims are installed above;
    // cannot be a static import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./ltsm/ltsmSandbox.js');
```

- [ ] **Step 8: Fix `tests/e2e.test.ts` — ternary-as-statement to if/else**

```typescript
// Before (lines 36-38)
        const req = http.get(`${baseUrl}/.well-known/oauth-authorization-server`, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error(`Status ${res.statusCode}`));
        });

// After
        const req = http.get(`${baseUrl}/.well-known/oauth-authorization-server`, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
```

- [ ] **Step 9: Fix `src/caching-line-client.test.ts` — replace `as any` with a typed cast**

```typescript
// Before (line 4)
import type { Message } from './line-client';

// After
import type { Message, LineClient } from './line-client';
```

Then replace all 13 occurrences (`replace_all`):

```typescript
// Before
const client = new CachingLineClient(inner as any, cache);
// ...and...
const client = new CachingLineClient(inner as any, new MessageCache(':memory:'));

// After
const client = new CachingLineClient(inner as unknown as LineClient, cache);
// ...and...
const client = new CachingLineClient(inner as unknown as LineClient, new MessageCache(':memory:'));
```

- [ ] **Step 10: Fix `src/export-parser.ts` — annotate intentional BOM-strip regexes**

```typescript
// Before (line 5)
  const firstLine = text.replace(/^﻿/, '').split('\n')[0] ?? '';

// After
  // eslint-disable-next-line no-irregular-whitespace -- strips a literal UTF-8 BOM (U+FEFF)
  const firstLine = text.replace(/^﻿/, '').split('\n')[0] ?? '';
```

```typescript
// Before (line 69, inside parseExportFile)
  const lines = text.replace(/^﻿/, '').split('\n');

// After
  // eslint-disable-next-line no-irregular-whitespace -- strips a literal UTF-8 BOM (U+FEFF)
  const lines = text.replace(/^﻿/, '').split('\n');
```

- [ ] **Step 11: Run lint again and confirm it's clean**

Run: `npm run lint`
Expected: exits 0, no errors printed.

- [ ] **Step 12: Run the build and unit tests to confirm nothing broke**

Run:
```bash
npm run build
npm run test:unit
```
Expected: both exit 0 (build compiles cleanly; all unit tests pass, same pass count as before these edits).

- [ ] **Step 13: Commit**

```bash
git add eslint.config.js package.json package-lock.json \
  src/line-client.test.ts src/line-client.ts src/ltsm.ts \
  tests/e2e.test.ts src/caching-line-client.test.ts src/export-parser.ts
git commit -m "chore: add ESLint and fix pre-existing lint violations"
```

---

### Task 2: Add the GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run lint` (Task 1), `npm run build`, `npm run test:unit` (both pre-existing in `package.json`).

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  lint-build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - run: npm run lint

      - run: npm run build

      - run: npm run test:unit
```

- [ ] **Step 2: Validate YAML syntax locally**

Run:
```bash
node -e "console.log(require('yaml') ? 'ok' : 'ok')" 2>/dev/null || python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid yaml')"
```
Expected: `valid yaml` printed (this only checks YAML is well-formed, not GitHub Actions semantics — the real check is Task 3's live PR run).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for lint, build, and unit tests"
```

---

### Task 3: Open a PR and verify CI is green

**Files:** none (repo operations only)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "ci: add GitHub Actions (lint, build, unit tests)" --body "$(cat <<'EOF'
## Summary
- Adds ESLint (flat config, typescript-eslint recommended) and fixes the pre-existing lint violations it surfaces
- Adds .github/workflows/ci.yml: runs lint + build + unit tests on every PR to main
- e2e tests are intentionally excluded from CI (they require a live .line-auth.json LINE session)

## Test plan
- [ ] CI run on this PR is green (lint, build, test:unit all pass)
EOF
)"
```

- [ ] **Step 3: Watch the CI run and confirm it's green**

Run:
```bash
gh pr checks --watch
```
Expected: the `lint-build-test` check reports `pass`. If it fails, read the failing step's log via `gh run view --log-failed`, fix the root cause locally, commit, push, and re-run this step.

- [ ] **Step 4: Report the PR URL to the user**

Print the PR URL returned by `gh pr create` (Step 2) so the user can review it.
