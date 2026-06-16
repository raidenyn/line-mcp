# Persistent Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist LINE credentials to disk so the server survives restarts without forcing re-authentication.

**Architecture:** Add `persistAuthData` (write) and `loadAuthFromDisk` (lazy read) helpers in `oauth.ts`. Wire lazy loading into `validateBearerToken` and `issueTokens` so a cold-start server automatically picks up the freshest LINE credentials from `DATA_DIR/auth/{mid}.json`. Write to disk at login time and on every LINE token refresh.

**Tech Stack:** Node.js `fs` (sync), TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/oauth.ts` | Modify | Add `persistAuthData`, `loadAuthFromDisk`; wire lazy load; replace `.line-auth.json` write |
| `src/index.ts` | Modify | Call `persistAuthData` in `makeLineClient` callback |
| `src/oauth.test.ts` | Create | Unit tests for all new helpers and lazy-load wiring |

---

### Task 1: Write tests and implement `persistAuthData`

**Files:**
- Create: `src/oauth.test.ts`
- Modify: `src/oauth.ts`

- [ ] **Step 1: Create `src/oauth.test.ts` with test setup and `persistAuthData` tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AuthData } from './line-client';

const TEST_AUTH: AuthData = {
  accessToken: 'stale-access-token',
  refreshToken: 'stale-refresh-token',
  certificate: 'test-cert',
  mid: 'u1234567890test',
  wrappedNonce: 'test-nonce',
  kdfParameter1: 'test-kdf1',
  kdfParameter2: 'test-kdf2',
};

const FRESH_AUTH: AuthData = {
  ...TEST_AUTH,
  accessToken: 'fresh-access-token',
  refreshToken: 'fresh-refresh-token',
};

type OAuthModule = typeof import('./oauth');

let tmpdir: string;
let mod: OAuthModule;

beforeEach(async () => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-mcp-test-'));
  vi.resetModules();
  process.env.DATA_DIR = tmpdir;
  mod = await import('./oauth');
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('persistAuthData', () => {
  it('writes AuthData to DATA_DIR/auth/{mid}.json', () => {
    mod.persistAuthData(TEST_AUTH);
    const filePath = path.join(tmpdir, 'auth', `${TEST_AUTH.mid}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written).toEqual(TEST_AUTH);
  });

  it('creates the auth/ directory if it does not exist', () => {
    const dir = path.join(tmpdir, 'auth');
    expect(fs.existsSync(dir)).toBe(false);
    mod.persistAuthData(TEST_AUTH);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not throw on write failure', async () => {
    vi.resetModules();
    process.env.DATA_DIR = '/proc/no-such-dir-99999';
    const badMod = await import('./oauth');
    expect(() => badMod.persistAuthData(TEST_AUTH)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they FAIL**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: FAIL — `persistAuthData is not a function` (not exported yet)

- [ ] **Step 3: Add `persistAuthData` to `src/oauth.ts`**

In `src/oauth.ts`, after the `latestAuthData` declaration (around line 50), add:

```typescript
export function persistAuthData(authData: AuthData): void {
  try {
    const dir = path.join(process.env.DATA_DIR ?? process.cwd(), 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${authData.mid}.json`), JSON.stringify(authData, null, 2));
  } catch (err) {
    process.stderr.write(`[OAuth] Failed to persist auth for ${authData.mid}: ${err}\n`);
  }
}
```

- [ ] **Step 4: Run tests to verify they PASS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "feat: add persistAuthData to write LINE credentials to disk"
```

---

### Task 2: Write tests and implement `loadAuthFromDisk`

**Files:**
- Modify: `src/oauth.ts`, `src/oauth.test.ts`

- [ ] **Step 1: Add `loadAuthFromDisk` tests to `src/oauth.test.ts`**

Append to `src/oauth.test.ts`:

```typescript
describe('loadAuthFromDisk', () => {
  it('reads AuthData from disk and populates latestAuthData', () => {
    mod.persistAuthData(FRESH_AUTH);
    mod.latestAuthData.clear();
    const result = mod.loadAuthFromDisk(FRESH_AUTH.mid);
    expect(result).toEqual(FRESH_AUTH);
    expect(mod.latestAuthData.get(FRESH_AUTH.mid)).toEqual(FRESH_AUTH);
  });

  it('returns null when file does not exist', () => {
    const result = mod.loadAuthFromDisk('u-nonexistent-mid');
    expect(result).toBeNull();
  });

  it('returns null and does not throw on corrupt JSON', () => {
    const dir = path.join(tmpdir, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST_AUTH.mid}.json`), 'not-valid-json');
    expect(() => mod.loadAuthFromDisk(TEST_AUTH.mid)).not.toThrow();
    expect(mod.loadAuthFromDisk(TEST_AUTH.mid)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests FAIL**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: FAIL — `loadAuthFromDisk is not a function`

- [ ] **Step 3: Add `loadAuthFromDisk` to `src/oauth.ts`**

In `src/oauth.ts`, after `persistAuthData`, add:

```typescript
export function loadAuthFromDisk(mid: string): AuthData | null {
  try {
    const file = path.join(process.env.DATA_DIR ?? process.cwd(), 'auth', `${mid}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const authData = JSON.parse(raw) as AuthData;
    latestAuthData.set(mid, authData);
    return authData;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they PASS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "feat: add loadAuthFromDisk to lazy-load LINE credentials from disk"
```

---

### Task 3: Wire lazy load into `issueTokens` with test

**Files:**
- Modify: `src/oauth.ts`, `src/oauth.test.ts`

- [ ] **Step 1: Add `issueTokens` lazy-load test to `src/oauth.test.ts`**

Append to `src/oauth.test.ts`:

```typescript
describe('issueTokens lazy load', () => {
  it('embeds fresh credentials from disk when latestAuthData is empty', () => {
    // Write FRESH_AUTH to disk; latestAuthData is empty (fresh module)
    mod.persistAuthData(FRESH_AUTH);
    // Issue a token with stale auth — issueTokens should lazy-load FRESH_AUTH from disk
    const { access_token } = mod.issueTokens(TEST_AUTH);
    // The token should embed FRESH_AUTH, so validateBearerToken returns it
    const result = mod.validateBearerToken(access_token);
    expect(result?.accessToken).toBe(FRESH_AUTH.accessToken);
  });
});
```

- [ ] **Step 2: Run tests to verify the new test FAILS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: FAIL — `issueTokens is not a function` (not yet exported)

- [ ] **Step 3: Export `issueTokens` and wire lazy load in `src/oauth.ts`**

Find the `issueTokens` function (currently `function issueTokens(...)`) and replace it:

```typescript
export function issueTokens(authData: AuthData): { access_token: string; refresh_token: string } {
  const mid = authData.mid;
  const freshAuth = latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? authData;
  const access_token = signToken({ authData: freshAuth, expiresAt: Date.now() + 86_400_000 });
  const refresh_token = signToken({ authData: freshAuth });
  return { access_token, refresh_token };
}
```

- [ ] **Step 4: Run tests to verify they PASS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "feat: wire lazy disk load into issueTokens"
```

---

### Task 4: Wire lazy load into `validateBearerToken` with test

**Files:**
- Modify: `src/oauth.ts`, `src/oauth.test.ts`

- [ ] **Step 1: Add `validateBearerToken` lazy-load test to `src/oauth.test.ts`**

Append to `src/oauth.test.ts`:

```typescript
describe('validateBearerToken lazy load', () => {
  it('returns fresh credentials from disk when latestAuthData is empty', () => {
    // Issue a token that embeds stale auth (no disk file yet — latestAuthData is empty)
    const { access_token } = mod.issueTokens(TEST_AUTH);
    // Now write FRESH_AUTH to disk (latestAuthData still empty)
    mod.persistAuthData(FRESH_AUTH);
    // Validate — should lazy-load FRESH_AUTH from disk
    const result = mod.validateBearerToken(access_token);
    expect(result?.accessToken).toBe(FRESH_AUTH.accessToken);
    // Subsequent access hits in-memory cache (disk loaded into latestAuthData)
    expect(mod.latestAuthData.get(TEST_AUTH.mid)?.accessToken).toBe(FRESH_AUTH.accessToken);
  });
});
```

- [ ] **Step 2: Run tests to verify the new test FAILS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: FAIL — `validateBearerToken` returns stale embedded token (`stale-access-token`), not `fresh-access-token`

- [ ] **Step 3: Update `validateBearerToken` in `src/oauth.ts`**

Find `validateBearerToken` and replace its last return line:

```typescript
export function validateBearerToken(token: string): AuthData | null {
  if (testOverrides.has(token)) return testOverrides.get(token)!;
  const payload = verifyToken<{ authData: AuthData; expiresAt: number }>(token);
  if (!payload || payload.expiresAt < Date.now()) return null;
  const mid = payload.authData.mid;
  return latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? payload.authData;
}
```

- [ ] **Step 4: Run all unit tests to verify they PASS**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "feat: wire lazy disk load into validateBearerToken"
```

---

### Task 5: Replace `.line-auth.json` write in `monitorLogin`

**Files:**
- Modify: `src/oauth.ts`

- [ ] **Step 1: Replace the `.line-auth.json` write block in `monitorLogin`**

In `src/oauth.ts`, inside `monitorLogin`, find and replace:

```typescript
    // Keep .line-auth.json in sync so e2e tests always have valid tokens
    try {
      fs.writeFileSync(
        path.join(process.cwd(), '.line-auth.json'),
        JSON.stringify(authData, null, 2),
      );
    } catch {
      // Non-fatal
    }
```

With:

```typescript
    persistAuthData(authData);
```

- [ ] **Step 2: Run unit tests to verify nothing broke**

```bash
npm run test:unit -- src/oauth.test.ts
```

Expected: PASS — 8 tests

- [ ] **Step 3: Commit**

```bash
git add src/oauth.ts
git commit -m "feat: persist auth on login, replacing .line-auth.json write"
```

---

### Task 6: Update `makeLineClient` callback in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `persistAuthData` to the import in `src/index.ts`**

Find the import line (around line 8):

```typescript
import { setupOAuthRoutes, validateBearerToken, latestAuthData, seedTestToken as oauthSeedTestToken, makeWwwAuthenticate } from './oauth';
```

Replace with:

```typescript
import { setupOAuthRoutes, validateBearerToken, latestAuthData, seedTestToken as oauthSeedTestToken, makeWwwAuthenticate, persistAuthData } from './oauth';
```

- [ ] **Step 2: Update `makeLineClient` to persist on token refresh**

Find the `makeLineClient` function (around line 209):

```typescript
function makeLineClient(authData: AuthData): LineClient {
  return new LineClient(authData, globalThis.fetch, () => {
    latestAuthData.set(authData.mid, authData);
  });
}
```

Replace with:

```typescript
function makeLineClient(authData: AuthData): LineClient {
  return new LineClient(authData, globalThis.fetch, () => {
    latestAuthData.set(authData.mid, authData);
    persistAuthData(authData);
  });
}
```

- [ ] **Step 3: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS — 8 tests

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
npm run build
```

Expected: no errors, `dist/` is updated

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: persist updated LINE tokens on refresh in makeLineClient"
```
