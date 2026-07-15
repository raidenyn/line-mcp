# Reusable LINE Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse durable LINE sessions and certificates so MCP refresh survives restarts and repeat OAuth authorization is QR-only when LINE accepts the saved certificate.

**Architecture:** Harden the existing file-backed auth helpers in `oauth.ts`, extending each record with an optional profile display name and exposing one validated enumeration path for OAuth and background sync. Keep QR bootstrap unauthenticated by passing only the selected certificate to `LineClient.login`, then persist completed credentials atomically before issuing an OAuth code. Multiple accounts use short-lived server-side selection state whose browser representation contains labels and opaque identifiers only.

**Tech Stack:** TypeScript 6, Node.js 20 `fs`/`crypto`, Express 5, Vitest 4, existing LINE Chrome thrift endpoints

## Global Constraints

- Preserve one file per account at `DATA_DIR/auth/<mid>.json`; existing files containing only the seven `AuthData` fields remain valid.
- Auth directories use mode `0700`; auth record temporary and destination files use mode `0600`.
- QR bootstrap calls must not carry saved LINE access or refresh tokens.
- Selector HTML, query parameters, browser storage, and logs must not contain credentials or full MIDs.
- Durable auth persistence must complete before `latestAuthData`, `pendingCodes`, or login-session `complete` state is updated.
- Expected certificate rejection falls back to PIN; network and unexpected server failures fail login.
- Do not add credential encryption, token revocation policy, a new database, or unrelated session-cleanup changes.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/oauth.ts` | Modify | Validate, enumerate, atomically persist auth records; manage account selection; enforce durable login completion and restart-safe token refresh |
| `src/oauth.test.ts` | Modify | Auth-store, selector, completion-ordering, and restart-oriented token tests |
| `src/line-client.ts` | Modify | Accept an explicit pending certificate and retrieve the authenticated profile display name |
| `src/line-client.test.ts` | Modify | Verify certificate acceptance/rejection state transitions, unauthenticated QR bootstrap, and profile lookup behavior |
| `src/sync.ts` | Modify | Reuse validated auth-record enumeration and safely persist rotated LINE tokens |
| `src/sync.test.ts` | Modify | Verify background sync ignores incomplete and MID-mismatched records through the shared validator |
| `src/index.ts` | Modify | Persist refreshed LINE credentials without turning disk failure into a failed in-process refresh |
| `README.md` | Modify | Document restart continuity, account selection, and repeat QR behavior |
| `CLAUDE.md` | Modify | Keep the repository architecture and auth-flow guidance accurate |

---

### Task 1: Validated Atomic Auth Store

**Files:**
- Modify: `src/oauth.ts:60-93`
- Modify: `src/oauth.test.ts:347-525`
- Modify: `src/sync.ts:1-59`
- Modify: `src/sync.test.ts:13-89`

**Interfaces:**
- Consumes: `AuthData`, `dataDirAuth()`, and `latestAuthData`.
- Produces: `StoredAuthRecord`, `authDataFromStoredRecord(record)`, `persistAuthData(authData, displayName?, storeDir?)`, `loadStoredAuthRecord(mid, storeDir?)`, `listStoredAuthRecords(storeDir?)`, and the existing `loadAuthFromDisk(mid)` behavior.

- [ ] **Step 1: Replace the old persistence expectations with failing validation, enumeration, and atomic-write tests**

In `src/oauth.test.ts`, retain `TEST_AUTH` and `FRESH_AUTH`, then replace the current `persistAuthData` and `loadAuthFromDisk` blocks with tests covering the public interfaces below. Use a fresh `tmpdir` and dynamic `import('./oauth')` as the current tests do.

```typescript
describe('stored auth records', () => {
  it('atomically writes a complete record with displayName and restrictive modes', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');

    const dir = path.join(tmpdir, 'auth');
    const file = path.join(dir, `${TEST_AUTH.mid}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...TEST_AUTH,
      displayName: 'Personal LINE',
    });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([`${TEST_AUTH.mid}.json`]);
  });

  it('preserves an existing displayName when refreshed credentials omit it', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    mod.persistAuthData(FRESH_AUTH);

    expect(mod.loadStoredAuthRecord(TEST_AUTH.mid)).toEqual({
      ...FRESH_AUTH,
      displayName: 'Personal LINE',
    });
  });

  it('throws without replacing the previous record when rename fails', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    expect(() => mod.persistAuthData(FRESH_AUTH)).toThrow('rename denied');
    rename.mockRestore();
    expect(mod.loadStoredAuthRecord(TEST_AUTH.mid)?.accessToken).toBe(TEST_AUTH.accessToken);
    expect(fs.readdirSync(path.join(tmpdir, 'auth'))).toEqual([`${TEST_AUTH.mid}.json`]);
  });

  it('lists valid legacy and named records while isolating invalid files', () => {
    const dir = path.join(tmpdir, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST_AUTH.mid}.json`), JSON.stringify(TEST_AUTH));
    fs.writeFileSync(path.join(dir, 'u-second.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-second',
      displayName: 'Work LINE',
    }));
    fs.writeFileSync(path.join(dir, 'u-corrupt.json'), '{');
    fs.writeFileSync(path.join(dir, 'u-incomplete.json'), JSON.stringify({ mid: 'u-incomplete' }));
    fs.writeFileSync(path.join(dir, 'u-mismatch.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-other',
    }));
    fs.writeFileSync(path.join(dir, 'u-empty-name.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-empty-name',
      displayName: '',
    }));

    expect(mod.listStoredAuthRecords().map(record => record.mid).sort()).toEqual([
      TEST_AUTH.mid,
      'u-second',
    ].sort());
  });

  it('rejects unsafe MIDs and non-string auth fields', () => {
    expect(mod.loadStoredAuthRecord('../escape')).toBeNull();
    const dir = path.join(tmpdir, 'auth');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'u-bad.json'), JSON.stringify({
      ...TEST_AUTH,
      mid: 'u-bad',
      certificate: 42,
    }));
    expect(mod.loadStoredAuthRecord('u-bad')).toBeNull();
  });

  it('does not populate latestAuthData during enumeration', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    mod.latestAuthData.clear();
    mod.listStoredAuthRecords();
    expect(mod.latestAuthData.size).toBe(0);
  });

  it('strips selector metadata before caching LINE auth data', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    mod.latestAuthData.clear();

    expect(mod.loadAuthFromDisk(TEST_AUTH.mid)).toEqual(TEST_AUTH);
    expect(mod.latestAuthData.get(TEST_AUTH.mid)).toEqual(TEST_AUTH);
    expect(mod.latestAuthData.get(TEST_AUTH.mid)).not.toHaveProperty('displayName');
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run: `npx vitest run src/oauth.test.ts -t "stored auth records"`

Expected: FAIL because `loadStoredAuthRecord` and `listStoredAuthRecords` are not exported, `persistAuthData` does not preserve names or throw, and invalid complete-shape records are currently accepted.

- [ ] **Step 3: Implement strict record parsing and atomic replacement in `src/oauth.ts`**

Replace the existing persistence block with this interface and behavior. Keep logging credential-free; use the caught error only for persistence callers, not while reporting invalid record contents.

```typescript
export interface StoredAuthRecord extends AuthData {
  displayName?: string;
}

export function authDataFromStoredRecord(record: StoredAuthRecord): AuthData {
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    certificate: record.certificate,
    mid: record.mid,
    wrappedNonce: record.wrappedNonce,
    kdfParameter1: record.kdfParameter1,
    kdfParameter2: record.kdfParameter2,
  };
}

const AUTH_FIELDS: ReadonlyArray<keyof AuthData> = [
  'accessToken',
  'refreshToken',
  'certificate',
  'mid',
  'wrappedNonce',
  'kdfParameter1',
  'kdfParameter2',
];

function parseStoredAuthRecord(value: unknown, expectedMid: string): StoredAuthRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mid !== expectedMid || !isSafeMid(expectedMid)) return null;
  if (AUTH_FIELDS.some(field => typeof candidate[field] !== 'string' || candidate[field] === '')) return null;
  if ('displayName' in candidate &&
      (typeof candidate.displayName !== 'string' || candidate.displayName.trim() === '')) return null;
  return candidate as unknown as StoredAuthRecord;
}

export function loadStoredAuthRecord(
  mid: string,
  storeDir = dataDirAuth(),
): StoredAuthRecord | null {
  if (!isSafeMid(mid)) return null;
  try {
    const file = path.resolve(storeDir, `${mid}.json`);
    if (!file.startsWith(path.resolve(storeDir) + path.sep)) return null;
    return parseStoredAuthRecord(JSON.parse(fs.readFileSync(file, 'utf8')), mid);
  } catch {
    return null;
  }
}

export function listStoredAuthRecords(storeDir = dataDirAuth()): StoredAuthRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: StoredAuthRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const mid = entry.name.slice(0, -5);
    const record = loadStoredAuthRecord(mid, storeDir);
    if (record) records.push(record);
    else process.stderr.write(`[OAuth] Ignoring invalid auth record for ${maskMid(mid)}\n`);
  }
  return records;
}

export function persistAuthData(
  authData: AuthData,
  displayName?: string,
  storeDir = dataDirAuth(),
): void {
  if (!isSafeMid(authData.mid) || !parseStoredAuthRecord(authData, authData.mid)) {
    throw new Error('Refusing to persist invalid LINE authentication data');
  }
  const existingName = loadStoredAuthRecord(authData.mid, storeDir)?.displayName;
  const name = displayName?.trim() || existingName;
  const record: StoredAuthRecord = { ...authData, ...(name ? { displayName: name } : {}) };
  const dir = path.resolve(storeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const destination = path.resolve(dir, `${authData.mid}.json`);
  if (!destination.startsWith(dir + path.sep)) throw new Error('Unsafe auth record path');
  const temporary = path.join(
    dir,
    `.${authData.mid}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
}

export function loadAuthFromDisk(mid: string): AuthData | null {
  const record = loadStoredAuthRecord(mid);
  if (!record) return null;
  const authData = authDataFromStoredRecord(record);
  latestAuthData.set(mid, authData);
  return authData;
}
```

Add a `maskMid(mid: string): string` helper near `isSafeMid`; for short/unsafe input return `"unknown"`, otherwise return the first four and last four characters separated by `...`.

- [ ] **Step 4: Run the focused auth-store tests and verify green**

Run: `npx vitest run src/oauth.test.ts -t "stored auth records"`

Expected: PASS for all new stored-auth-record tests.

- [ ] **Step 5: Add failing sync tests for incomplete and mismatched complete records**

Append to `src/sync.test.ts` inside `describe('syncAll')`:

```typescript
it.each([
  ['incomplete', { mid: 'u123', accessToken: 'tok' }],
  ['mismatched', { ...TEST_AUTH, mid: 'u-other' }],
])('skips %s auth records through shared validation', async (_label, value) => {
  const cache = new MessageCache(':memory:');
  cache.upsertMessages('chat1', [msg('1', '1000')]);
  const authDir = mkdtempSync(join(tmpdir(), 'sync-test-'));
  writeFileSync(join(authDir, 'u123.json'), JSON.stringify(value));
  const makeClient = vi.fn();

  await syncAll(cache, { authDir, makeClient });

  expect(makeClient).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run the sync tests and verify the red state**

Run: `npx vitest run src/sync.test.ts`

Expected: FAIL for the incomplete record because `sync.ts` currently checks only `mid` and `accessToken`.

- [ ] **Step 7: Replace duplicate sync parsing with `listStoredAuthRecords`**

In `src/sync.ts`, remove `readdirSync`, `readFileSync`, `join`, and the per-file JSON parser. Import `listStoredAuthRecords` and iterate its result:

```typescript
import {
  authDataFromStoredRecord,
  latestAuthData,
  listStoredAuthRecords,
  persistAuthData,
} from './oauth';

// inside syncAll, after chatMids is known to be non-empty
const records = listStoredAuthRecords(resolve(options.authDir ?? getAuthDir()));
if (records.length === 0) return;

for (const record of records) {
  const authData = authDataFromStoredRecord(record);
  const mid = authData.mid;
  latestAuthData.set(mid, authData);
  const client = makeClient(authData, cache);
  let synced = 0;
  let errors = 0;
  for (const chatMid of chatMids) {
    try {
      await client.getMessagesInRange(chatMid, 0);
      synced++;
    } catch (err) {
      process.stderr.write(`[sync] Error syncing ${chatMid} for ${mid}: ${(err as Error).message}\n`);
      errors++;
    }
  }
  process.stderr.write(`[sync] mid=${mid}: ${synced} chats synced, ${errors} errors\n`);
}
```

Move `const chatMids = cache.getDistinctChatMids()` before enumeration so an empty cache still performs no filesystem work. Preserve the existing missing-directory behavior through `listStoredAuthRecords` returning `[]`.

- [ ] **Step 8: Run storage and sync tests together**

Run: `npx vitest run src/oauth.test.ts src/sync.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the validated auth-store unit**

```bash
git add src/oauth.ts src/oauth.test.ts src/sync.ts src/sync.test.ts
git commit -m "fix: validate and atomically persist LINE auth records"
```

---

### Task 2: Certificate-Only QR Login and Profile Name

**Files:**
- Modify: `src/line-client.ts:16-24,225-420`
- Modify: `src/line-client.test.ts:30-46,616-end`

**Interfaces:**
- Consumes: an optional certificate selected by OAuth and the existing LINE QR state machine.
- Produces: `login(certificate?: string): Promise<{ qrUrl: string }>` and `getProfileDisplayName(): Promise<string>`.

- [ ] **Step 1: Add a deterministic QR-login fetch harness and failing accepted-certificate test**

Append a `describe('LineClient QR login')` block to `src/line-client.test.ts`. The harness must record parsed request bodies and headers and return complete responses for the QR sequence:

```typescript
function makeLoginFetch(verifyResponse: Response) {
  const calls: Array<{ url: string; body: unknown[]; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '[]')) as unknown[];
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, body, headers });
    if (url.includes('createSession')) return apiOk({ authSessionId: 'session-1' });
    if (url.includes('createQrCode')) return apiOk({
      callbackUrl: 'https://line.me/R/nv/QRLogin?sid=session-1',
      longPollingMaxCount: 1,
      longPollingIntervalSec: 1,
    });
    if (url.includes('checkQrCodeVerified')) return apiOk({});
    if (url.includes('verifyCertificate')) return verifyResponse;
    if (url.includes('createPinCode')) return apiOk({ pinCode: '123456' });
    if (url.includes('checkPinCodeVerified')) return apiOk({});
    if (url.includes('qrCodeLoginV2')) return apiOk({
      certificate: 'replacement-cert',
      tokenV3IssueResult: { accessToken: makeFakeJwt(), refreshToken: 'new-refresh' },
      mid: 'u123',
    });
    if (url.includes('getEncryptedIdentityV3')) return apiOk({
      wrappedNonce: 'new-nonce',
      kdfParameter1: 'new-kdf1',
      kdfParameter2: 'new-kdf2',
    });
    if (url.includes('getProfile')) return apiOk({ mid: 'u123', displayName: 'Personal LINE' });
    return apiOk({});
  });
  return { fetchFn, calls };
}

it('uses an explicit certificate, keeps QR bootstrap unauthenticated, and skips PIN when accepted', async () => {
  const { fetchFn, calls } = makeLoginFetch(apiOk({}));
  const client = new LineClient(null, fetchFn);

  await client.login('saved-cert');
  await expect(client.waitForPin()).resolves.toBeNull();
  await client.waitForCompletion();

  const bootstrap = calls.filter(call =>
    call.url.includes('createSession') || call.url.includes('createQrCode'));
  expect(bootstrap.every(call => call.headers['x-line-access'] === undefined)).toBe(true);
  const verify = calls.find(call => call.url.includes('verifyCertificate'))!;
  expect(verify.body).toEqual([{ authSessionId: 'session-1', certificate: 'saved-cert' }]);
  expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
  expect(calls.some(call => call.url.includes('checkPinCodeVerified'))).toBe(false);
});
```

- [ ] **Step 2: Run the accepted-certificate test and verify red**

Run: `npx vitest run src/line-client.test.ts -t "uses an explicit certificate"`

Expected: FAIL because `login` ignores its argument and sends an empty certificate when the client has no active auth.

- [ ] **Step 3: Decouple the pending certificate from active authentication**

Change `LineClient.login` and its pending-state assignment:

```typescript
async login(certificate?: string): Promise<{ qrUrl: string }> {
  // retain abort, createSession, createQrCode, key generation, and completion setup
  this.pendingCertificate = certificate?.trim() ? certificate : null;
  // do not read this.auth?.certificate here
}
```

Leave `request()` unchanged so the empty `auth` on the OAuth login client guarantees no `x-line-access` header during bootstrap.

- [ ] **Step 4: Run the accepted-certificate test and verify green**

Run: `npx vitest run src/line-client.test.ts -t "uses an explicit certificate"`

Expected: PASS.

- [ ] **Step 5: Add failing rejection and unexpected-failure tests**

Add these tests to the same block:

```typescript
it('falls back to one PIN flow when LINE rejects a stale certificate', async () => {
  const { fetchFn, calls } = makeLoginFetch(apiErr(401, 'certificate rejected'));
  const client = new LineClient(null, fetchFn);

  await client.login('stale-cert');
  await expect(client.waitForPin()).resolves.toBe('123456');
  await client.waitForCompletion();

  expect(calls.filter(call => call.url.includes('createPinCode'))).toHaveLength(1);
  expect(calls.filter(call => call.url.includes('checkPinCodeVerified'))).toHaveLength(1);
  expect(client.getCompletedAuth()?.certificate).toBe('replacement-cert');
});

it('fails login instead of entering PIN on a verifyCertificate server failure', async () => {
  const { fetchFn, calls } = makeLoginFetch(httpErr(500));
  const client = new LineClient(null, fetchFn);

  await client.login('saved-cert');
  await client.waitForPin();
  await expect(client.waitForCompletion()).rejects.toThrow('HTTP 500');
  expect(calls.some(call => call.url.includes('createPinCode'))).toBe(false);
});
```

- [ ] **Step 6: Run the rejection tests and verify behavior**

Run: `npx vitest run src/line-client.test.ts -t "certificate"`

Expected: PASS. The tests characterize the existing distinction between expected API/client rejection and fatal 5xx/network failure while adding coverage for the explicit certificate input.

- [ ] **Step 7: Add failing authenticated-profile tests**

Add:

```typescript
it('returns the authenticated account display name', async () => {
  const fetchFn = vi.fn().mockResolvedValue(apiOk({
    mid: baseAuth.mid,
    displayName: 'Personal LINE',
  }));
  const client = new LineClient(baseAuth, fetchFn);
  await expect(client.getProfileDisplayName()).resolves.toBe('Personal LINE');
  expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual([2]);
});

it.each([
  [{ mid: baseAuth.mid, displayName: '' }, 'missing display name'],
  [{ mid: 'u-other', displayName: 'Wrong Account' }, 'profile MID mismatch'],
])('rejects an invalid authenticated profile', async (profile, message) => {
  const client = new LineClient(baseAuth, vi.fn().mockResolvedValue(apiOk(profile)));
  await expect(client.getProfileDisplayName()).rejects.toThrow(message);
});
```

- [ ] **Step 8: Run profile tests and verify red**

Run: `npx vitest run src/line-client.test.ts -t "authenticated account|invalid authenticated profile"`

Expected: FAIL because `getProfileDisplayName` does not exist.

- [ ] **Step 9: Implement focused profile retrieval**

Add to `LineClient` after `getCompletedAuth`:

```typescript
async getProfileDisplayName(): Promise<string> {
  if (!this.auth) throw new Error('Not authenticated');
  const profile = await this.request<{ mid: string; displayName: string }>(
    '/api/talk/thrift/Talk/TalkService/getProfile',
    [2],
  );
  if (profile.mid !== this.auth.mid) throw new Error('LINE profile MID mismatch');
  const displayName = profile.displayName?.trim();
  if (!displayName) throw new Error('LINE profile missing display name');
  return displayName;
}
```

- [ ] **Step 10: Run all `LineClient` unit tests**

Run: `npx vitest run src/line-client.test.ts`

Expected: PASS.

- [ ] **Step 11: Commit the LINE login unit**

```bash
git add src/line-client.ts src/line-client.test.ts
git commit -m "fix: reuse saved certificates during LINE QR login"
```

---

### Task 3: OAuth Account Selection and Durable Completion

**Files:**
- Modify: `src/oauth.ts:121-195,197-349`
- Modify: `src/oauth.test.ts:10-28,64-108,203-279,282-345`

**Interfaces:**
- Consumes: `listStoredAuthRecords`, `loadStoredAuthRecord`, `persistAuthData`, `LineClient.login(certificate?)`, and `LineClient.getProfileDisplayName()`.
- Produces: `POST <basePath>/authorize/select`, short-lived opaque selection sessions, account selector HTML, and login sessions that become complete only after durable storage.

- [ ] **Step 1: Make OAuth route tests use an isolated auth directory and inspect constructed clients**

Extend the current `vi.mock('./line-client')` factory so each constructed client is available and supports the new method:

```typescript
const createdClients: Array<{
  login: ReturnType<typeof vi.fn>;
  waitForPin: ReturnType<typeof vi.fn>;
  waitForCompletion: ReturnType<typeof vi.fn>;
  getCompletedAuth: ReturnType<typeof vi.fn>;
  getProfileDisplayName: ReturnType<typeof vi.fn>;
}> = [];
const profileLookup = vi.fn().mockResolvedValue('Personal LINE');

const LineClient = vi.fn().mockImplementation(function LineClient() {
  const client = {
    login: vi.fn().mockResolvedValue({ qrUrl: 'https://line.me/R/nv/QRLogin?sid=fakesid' }),
    waitForPin: vi.fn().mockResolvedValue(null),
    waitForCompletion: vi.fn().mockResolvedValue(undefined),
    getCompletedAuth: vi.fn().mockReturnValue(mockAuthData),
    getProfileDisplayName: profileLookup,
  };
  createdClients.push(client);
  return client;
});

return {
  LineClient,
  __createdClients: createdClients,
  __profileLookup: profileLookup,
  __mockAuthData: mockAuthData,
};
```

Create one temporary auth directory for each HTTP test server in `beforeAll`, pass it as the fourth argument to `setupOAuthRoutes`, and remove it in `afterAll`:

```typescript
let authStoreDir: string;
let authStoreDir2: string;

authStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-routes-'));
setupOAuthRoutes(app, addr.port, '', authStoreDir);

authStoreDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-routes-prefix-'));
setupOAuthRoutes(app2, addr.port, BASE_PATH_2, authStoreDir2);
```

Clear both directories and the mock client array in route-test `beforeEach` so account records and sessions do not leak between tests. Reset `__profileLookup` to resolve `Personal LINE` each time.

- [ ] **Step 2: Add failing zero- and one-account route tests**

Inside `describe('GET /authorize')`, add:

```typescript
it('starts first-time QR login without a certificate when no account is saved', async () => {
  const { __createdClients } = await import('./line-client') as unknown as {
    __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
  };
  const response = await req(`${base}/authorize?${validParams}`);
  expect(response.status).toBe(200);
  expect(__createdClients.at(-1)?.login).toHaveBeenCalledWith(undefined);
});

it('automatically starts QR login with the only saved certificate', async () => {
  fs.writeFileSync(path.join(authStoreDir, `${sampleAuthData.mid}.json`), JSON.stringify({
    ...sampleAuthData,
    displayName: 'Personal LINE',
  }));
  const { __createdClients } = await import('./line-client') as unknown as {
    __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
  };

  const response = await req(`${base}/authorize?${validParams}`);

  expect(response.status).toBe(200);
  expect(__createdClients.at(-1)?.login).toHaveBeenCalledWith(sampleAuthData.certificate);
});
```

- [ ] **Step 3: Run the account-count route tests and verify red**

Run: `npx vitest run src/oauth.test.ts -t "first-time QR|only saved certificate"`

Expected: FAIL because `setupOAuthRoutes` has no auth-directory parameter and `/authorize` always calls `login()` without a selected certificate.

- [ ] **Step 4: Extract validated OAuth input and a shared QR-session starter**

In `src/oauth.ts`, add these types and helpers before `setupOAuthRoutes`:

```typescript
interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
}

interface AccountSelectionSession {
  request: AuthorizationRequest;
  choices: Map<string, string>;
  expiresAt: number;
}

const accountSelectionSessions = new Map<string, AccountSelectionSession>();

async function startQrLogin(
  request: AuthorizationRequest,
  selected: StoredAuthRecord | null,
  authStoreDir: string,
  basePath: string,
  res: Response,
): Promise<void> {
  const lineClient = new LineClient();
  const { qrUrl } = await lineClient.login(selected?.certificate);
  const qrDataUrl = await QRCode.toDataURL(qrUrl);
  const sid = crypto.randomBytes(16).toString('hex');
  loginSessions.set(sid, {
    lineClient,
    ...request,
    authStoreDir,
    previousDisplayName: selected?.displayName,
    phase: 'qr',
  });
  void monitorLogin(sid);
  res.type('html').send(authorizePageHtml(
    qrDataUrl,
    sid,
    request.state,
    request.redirectUri,
    basePath,
  ));
}
```

Extend `LoginSession` with `authStoreDir: string` and `previousDisplayName?: string`. Change `setupOAuthRoutes` to:

```typescript
export function setupOAuthRoutes(
  app: Express,
  port: number,
  basePath: string,
  authStoreDir = dataDirAuth(),
): void {
```

After current OAuth query validation, construct `AuthorizationRequest`, call `listStoredAuthRecords(authStoreDir)`, and invoke `startQrLogin` for zero or one record.

- [ ] **Step 5: Run zero- and one-account tests and verify green**

Run: `npx vitest run src/oauth.test.ts -t "first-time QR|only saved certificate"`

Expected: PASS.

- [ ] **Step 6: Add failing multiple-account selector and tamper tests**

Add route-test helpers that write two valid records named `Personal LINE` and `Work LINE`. Then add:

```typescript
it('renders human names and opaque choices without starting QR for multiple accounts', async () => {
  writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
  writeRouteAuth('u-work', 'Work LINE', 'work-cert');
  const { LineClient } = await import('./line-client');

  const { status, body } = await req(`${base}/authorize?${validParams}`);
  const html = body as string;

  expect(status).toBe(200);
  expect(html).toContain('Personal LINE');
  expect(html).toContain('Work LINE');
  expect(html).not.toContain('u-personal');
  expect(html).not.toContain('u-work');
  expect(html).not.toContain('personal-cert');
  expect(html).not.toContain(sampleAuthData.accessToken);
  expect(LineClient).not.toHaveBeenCalled();
});

it('uses the selected account certificate once and rejects replay', async () => {
  writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
  writeRouteAuth('u-work', 'Work LINE', 'work-cert');
  const selector = await req(`${base}/authorize?${validParams}`);
  const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
  const form = new URLSearchParams({ selection_session: selectionSession, choice: workChoice });

  const selected = await req(`${base}/authorize/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  expect(selected.status).toBe(200);
  expect((await lastCreatedClient()).login).toHaveBeenCalledWith('work-cert');

  const replay = await req(`${base}/authorize/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  expect(replay.status).toBe(400);
});

it('returns 400 for an unknown selection session', async () => {
  const response = await postSelection('missing-session', 'missing-choice');
  expect(response.status).toBe(400);
});

it('returns 400 for a tampered choice and consumes the selection session', async () => {
  writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
  writeRouteAuth('u-work', 'Work LINE', 'work-cert');
  const selector = await req(`${base}/authorize?${validParams}`);
  const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));

  expect((await postSelection(selectionSession, 'missing-choice')).status).toBe(400);
  expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
});

it('returns 400 when the selected record disappears before submission', async () => {
  writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
  writeRouteAuth('u-work', 'Work LINE', 'work-cert');
  const selector = await req(`${base}/authorize?${validParams}`);
  const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
  fs.unlinkSync(path.join(authStoreDir, 'u-work.json'));

  expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
});

it('expires account selection sessions after ten minutes', async () => {
  vi.useFakeTimers();
  try {
    writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
    writeRouteAuth('u-work', 'Work LINE', 'work-cert');
    const selector = await req(`${base}/authorize?${validParams}`);
    const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));
    vi.advanceTimersByTime(600_001);

    expect((await postSelection(selectionSession, workChoice)).status).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});

it('uses opaque choices to distinguish duplicate display names', async () => {
  writeRouteAuth('u-personal', 'LINE Account', 'personal-cert');
  writeRouteAuth('u-work', 'LINE Account', 'work-cert');
  const selector = await req(`${base}/authorize?${validParams}`);
  const html = bodyAsHtml(selector);
  const choices = [...html.matchAll(/name="choice" value="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(choices).size).toBe(2);
});

it('shows a masked MID for a legacy record without displayName', async () => {
  writeRouteAuth('u-personal', 'Personal LINE', 'personal-cert');
  fs.writeFileSync(path.join(authStoreDir, 'u123456789abcdef.json'), JSON.stringify({
    ...sampleAuthData,
    mid: 'u123456789abcdef',
    certificate: 'legacy-cert',
  }));

  const selector = await req(`${base}/authorize?${validParams}`);
  const html = bodyAsHtml(selector);
  expect(html).toContain('u123...cdef');
  expect(html).not.toContain('u123456789abcdef');
});
```

Add these concrete helpers in `src/oauth.test.ts` (use the existing `sampleAuthData` fixture and `req` helper):

```typescript
function writeRouteAuth(mid: string, displayName: string, certificate: string): void {
  fs.writeFileSync(path.join(authStoreDir, `${mid}.json`), JSON.stringify({
    ...sampleAuthData,
    mid,
    certificate,
    displayName,
  }));
}

function bodyAsHtml(response: { body: unknown }): string {
  expect(typeof response.body).toBe('string');
  return response.body as string;
}

function parseSelector(html: string): {
  selectionSession: string;
  personalChoice: string;
  workChoice: string;
} {
  const selectionSession = html.match(/name="selection_session" value="([^"]+)"/)?.[1];
  const rows = [...html.matchAll(/value="([^"]+)"[^>]*>\s*([^<]+)</g)];
  const choiceFor = (label: string) => rows.find(([, , text]) => text.trim() === label)?.[1];
  const personalChoice = choiceFor('Personal LINE');
  const workChoice = choiceFor('Work LINE');
  if (!selectionSession || !personalChoice || !workChoice) {
    throw new Error('Could not parse account selector');
  }
  return { selectionSession, personalChoice, workChoice };
}

async function postSelection(
  selectionSession: string,
  choice: string,
  targetBase = base,
  targetPath = '',
) {
  return req(`${targetBase}${targetPath}/authorize/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ selection_session: selectionSession, choice }),
  });
}

async function lastCreatedClient() {
  const lineModule = await import('./line-client') as unknown as {
    __createdClients: Array<{ login: ReturnType<typeof vi.fn> }>;
  };
  return lineModule.__createdClients.at(-1)!;
}
```

In the non-root `BASE_PATH_2` suite, add:

```typescript
it('serves account selection submission under the configured base path', async () => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'claude-code',
    redirect_uri: 'http://localhost:8765/callback',
    code_challenge: s256('verifier123'),
    code_challenge_method: 'S256',
    state: 'st',
  });
  fs.writeFileSync(path.join(authStoreDir2, 'u-personal.json'), JSON.stringify({
    ...sampleAuthData,
    mid: 'u-personal',
    certificate: 'personal-cert',
    displayName: 'Personal LINE',
  }));
  fs.writeFileSync(path.join(authStoreDir2, 'u-work.json'), JSON.stringify({
    ...sampleAuthData,
    mid: 'u-work',
    certificate: 'work-cert',
    displayName: 'Work LINE',
  }));
  const selector = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
  const { selectionSession, workChoice } = parseSelector(bodyAsHtml(selector));

  const selected = await postSelection(
    selectionSession,
    workChoice,
    base2,
    BASE_PATH_2,
  );

  expect(selected.status).toBe(200);
  expect((await lastCreatedClient()).login).toHaveBeenCalledWith('work-cert');
});
```

- [ ] **Step 7: Run selector tests and verify red**

Run: `npx vitest run src/oauth.test.ts -t "multiple accounts|selected account|unknown session|tampered choice|selected record|selector submission"`

Expected: FAIL because selector HTML, selection sessions, and `/authorize/select` do not exist.

- [ ] **Step 8: Implement safe labels, selector HTML, and one-time server-side selection**

Add:

```typescript
function accountLabel(record: StoredAuthRecord): string {
  return record.displayName ?? maskMid(record.mid);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function accountSelectorHtml(
  basePath: string,
  selectionSession: string,
  choices: Array<{ id: string; label: string }>,
): string {
  const options = choices.map(({ id, label }, index) => `
    <label>
      <input type="radio" name="choice" value="${escapeHtml(id)}"${index === 0 ? ' checked' : ''}>
      ${escapeHtml(label)}
    </label>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Select LINE account</title></head><body>
<h1>Select LINE account</h1>
<form method="post" action="${escapeHtml(basePath)}/authorize/select">
<input type="hidden" name="selection_session" value="${escapeHtml(selectionSession)}">
${options}
<button type="submit">Continue</button>
</form></body></html>`;
}
```

For multiple records, prune expired selection sessions and create the state with:

```typescript
const now = Date.now();
for (const [sid, selection] of accountSelectionSessions) {
  if (selection.expiresAt < now) accountSelectionSessions.delete(sid);
}
const selectionSession = crypto.randomBytes(16).toString('hex');
const choices = records.map(record => ({
  id: crypto.randomBytes(16).toString('hex'),
  mid: record.mid,
  label: accountLabel(record),
}));
accountSelectionSessions.set(selectionSession, {
  request: authorizationRequest,
  choices: new Map(choices.map(choice => [choice.id, choice.mid])),
  expiresAt: now + 600_000,
});
res.type('html').send(accountSelectorHtml(basePath, selectionSession, choices));
```

Only `id` and `label` are passed to `accountSelectorHtml`; `mid` stays in the server-side map.

The POST handler must:

```typescript
const sessionId = typeof req.body?.selection_session === 'string'
  ? req.body.selection_session : '';
const choice = typeof req.body?.choice === 'string' ? req.body.choice : '';
const selection = accountSelectionSessions.get(sessionId);
accountSelectionSessions.delete(sessionId);
if (!selection || selection.expiresAt < Date.now()) {
  res.status(400).send('Account selection expired or invalid; restart authorization.');
  return;
}
const mid = selection.choices.get(choice);
const record = mid ? loadStoredAuthRecord(mid, authStoreDir) : null;
if (!record) {
  res.status(400).send('Selected account is no longer available; restart authorization.');
  return;
}
await startQrLogin(selection.request, record, authStoreDir, basePath, res);
```

Wrap `startQrLogin` failures in the same controlled `500 Failed to start LINE login` response used by the GET route.

- [ ] **Step 9: Run all selector and base-path tests**

Run: `npx vitest run src/oauth.test.ts -t "GET /authorize|selector|selection|non-root basePath"`

Expected: PASS.

- [ ] **Step 10: Add failing persistence-order and profile-fallback tests**

Add these HTTP-test helpers:

```typescript
const routeParams = () => new URLSearchParams({
  response_type: 'code',
  client_id: 'claude-code',
  redirect_uri: 'http://localhost:8765/callback',
  code_challenge: s256('verifier123'),
  code_challenge_method: 'S256',
  state: 'st',
});

async function withOAuthServer(
  authStorePath: string,
  run: (serverBase: string) => Promise<void>,
  setupRoutes: typeof setupOAuthRoutes = setupOAuthRoutes,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const localServer = http.createServer(app);
  await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const port = (localServer.address() as { port: number }).port;
  setupRoutes(app, port, '', authStorePath);
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => localServer.close(() => resolve()));
  }
}

function sessionIdFromQrPage(html: string): string {
  const sid = html.match(/const sid = "([^"]+)"/)?.[1];
  if (!sid) throw new Error('QR page did not contain a login session ID');
  return sid;
}

async function waitForTerminalLogin(serverBase: string, sid: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await req(`${serverBase}/authorize/poll?sid=${encodeURIComponent(sid)}`);
    const body = response.body as { phase: string; code?: string; error?: string };
    if (body.phase === 'complete' || body.phase === 'failed') return body;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Login session did not reach a terminal phase');
}
```

Then add:

```typescript
it('does not issue a code or update memory when durable persistence fails', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-blocked-'));
  const blockedAuthPath = path.join(parent, 'auth');
  fs.writeFileSync(blockedAuthPath, 'not a directory');
  latestAuthData.clear();

  await withOAuthServer(blockedAuthPath, async serverBase => {
    const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
    const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
    const pollBody = await waitForTerminalLogin(serverBase, sid);

    expect(pollBody.phase).toBe('failed');
    expect(pollBody.code).toBeUndefined();
    expect(latestAuthData.has('umid')).toBe(false);
  });
});

it('persists the profile name before reporting login complete', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-success-'));
  await withOAuthServer(store, async serverBase => {
    const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
    const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
    const pollBody = await waitForTerminalLogin(serverBase, sid);

    expect(pollBody.phase).toBe('complete');
    expect(pollBody.code).toBeTypeOf('string');
    expect(JSON.parse(fs.readFileSync(path.join(store, 'umid.json'), 'utf8')))
      .toMatchObject({ mid: 'umid', displayName: 'Personal LINE' });
  });
});

it('retains the saved display name when profile lookup fails', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oauth-profile-fallback-'));
  fs.writeFileSync(path.join(store, 'umid.json'), JSON.stringify({
    accessToken: 'old-token',
    refreshToken: 'old-refresh',
    certificate: 'old-cert',
    mid: 'umid',
    wrappedNonce: 'old-nonce',
    kdfParameter1: 'old-kdf1',
    kdfParameter2: 'old-kdf2',
    displayName: 'Existing Name',
  }));
  const lineModule = await import('./line-client') as unknown as {
    __profileLookup: ReturnType<typeof vi.fn>;
  };
  lineModule.__profileLookup.mockRejectedValueOnce(new Error('profile unavailable'));

  await withOAuthServer(store, async serverBase => {
    const authorize = await req(`${serverBase}/authorize?${routeParams()}`);
    const sid = sessionIdFromQrPage(bodyAsHtml(authorize));
    expect((await waitForTerminalLogin(serverBase, sid)).phase).toBe('complete');
    expect(JSON.parse(fs.readFileSync(path.join(store, 'umid.json'), 'utf8')).displayName)
      .toBe('Existing Name');
  });
});
```

- [ ] **Step 11: Run completion-order tests and verify red**

Run: `npx vitest run src/oauth.test.ts -t "persistence failure|saved JSON|profile lookup"`

Expected: FAIL because `monitorLogin` currently creates a pending code and marks the session complete before best-effort persistence, and it does not fetch profile metadata.

- [ ] **Step 12: Reorder `monitorLogin` around durable persistence**

After `getCompletedAuth`, enrich the name without making profile failure fatal, persist first, and only then publish credentials and the OAuth code:

```typescript
const authData = session.lineClient.getCompletedAuth();
if (!authData) throw new Error('Login completed but no auth data returned');

let displayName = session.previousDisplayName;
try {
  displayName = await session.lineClient.getProfileDisplayName();
} catch {
  process.stderr.write(`[OAuth] Profile name unavailable for ${maskMid(authData.mid)}\n`);
}

try {
  persistAuthData(authData, displayName, session.authStoreDir);
} catch {
  process.stderr.write(`[OAuth] Could not persist completed login for ${maskMid(authData.mid)}\n`);
  session.phase = 'failed';
  session.error = 'Unable to save LINE login securely; check DATA_DIR/auth permissions and try again.';
  return;
}
latestAuthData.set(authData.mid, authData);

const code = crypto.randomBytes(16).toString('hex');
pendingCodes.set(code, {
  authData,
  codeChallenge: session.codeChallenge,
  codeChallengeMethod: session.codeChallengeMethod,
  redirectUri: session.redirectUri,
  clientId: session.clientId,
  expiresAt: Date.now() + 600_000,
});
session.code = code;
session.phase = 'complete';
```

Keep the outer catch for LINE login and profile-independent failures. The dedicated persistence catch above must log only the operation and masked MID, never the filesystem error or record contents.

- [ ] **Step 13: Run the complete OAuth test file**

Run: `npx vitest run src/oauth.test.ts`

Expected: PASS.

- [ ] **Step 14: Commit the OAuth selection and completion unit**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "fix: select saved LINE accounts before OAuth login"
```

---

### Task 4: Refresh Persistence and Restart Continuity

**Files:**
- Modify: `src/oauth.ts:103-119`
- Modify: `src/oauth.test.ts:471-525`
- Modify: `src/index.ts:10,917-925`
- Modify: `src/sync.ts:6-19`
- Modify: `README.md:65-72,115-119`
- Modify: `CLAUDE.md` OAuth, `line-client.ts`, and auth-flow sections

**Interfaces:**
- Consumes: `persistAuthData` preserving a stored display name and self-contained MCP refresh tokens signed by `data/secret`.
- Produces: `recordRefreshedAuth(authData): void`, used by interactive and background clients, plus verified restart behavior.

- [ ] **Step 1: Add failing refreshed-auth failure and name-preservation tests**

In the dynamically imported auth-store suite in `src/oauth.test.ts`, add:

```typescript
describe('recordRefreshedAuth', () => {
  it('updates memory and disk while preserving the account display name', () => {
    mod.persistAuthData(TEST_AUTH, 'Personal LINE');
    mod.latestAuthData.clear();

    mod.recordRefreshedAuth(FRESH_AUTH);

    expect(mod.latestAuthData.get(TEST_AUTH.mid)).toEqual(FRESH_AUTH);
    expect(mod.loadStoredAuthRecord(TEST_AUTH.mid)).toEqual({
      ...FRESH_AUTH,
      displayName: 'Personal LINE',
    });
  });

  it('keeps refreshed credentials in memory when persistence fails', () => {
    const blocked = path.join(tmpdir, 'blocked-auth');
    fs.writeFileSync(blocked, 'not a directory');

    expect(() => mod.recordRefreshedAuth(FRESH_AUTH, blocked)).not.toThrow();
    expect(mod.latestAuthData.get(TEST_AUTH.mid)).toEqual(FRESH_AUTH);
  });
});
```

- [ ] **Step 2: Run refreshed-auth tests and verify red**

Run: `npx vitest run src/oauth.test.ts -t "recordRefreshedAuth"`

Expected: FAIL because `recordRefreshedAuth` does not exist.

- [ ] **Step 3: Implement the non-fatal refresh boundary**

Add to `src/oauth.ts`:

```typescript
export function recordRefreshedAuth(
  authData: AuthData,
  storeDir = dataDirAuth(),
): void {
  latestAuthData.set(authData.mid, authData);
  try {
    persistAuthData(authData, undefined, storeDir);
  } catch {
    process.stderr.write(
      `[OAuth] Refreshed LINE auth for ${maskMid(authData.mid)} but could not persist it\n`,
    );
  }
}
```

- [ ] **Step 4: Replace duplicated refresh callbacks**

In `src/index.ts`, import `recordRefreshedAuth` instead of `latestAuthData` and `persistAuthData`, then use:

```typescript
new LineClient(authData, globalThis.fetch, () => recordRefreshedAuth(authData))
```

Make the same import and callback replacement in `src/sync.ts`. Do not change `LineClient.refreshIfExpired`; its callback remains synchronous and cannot fail due to disk persistence.

- [ ] **Step 5: Run refreshed-auth, sync, and client refresh tests**

Run: `npx vitest run src/oauth.test.ts src/sync.test.ts src/line-client.test.ts -t "recordRefreshedAuth|syncAll|concurrent refresh|token when JWT"`

Expected: PASS.

- [ ] **Step 6: Add a restart-oriented refresh-token characterization test**

Use one temporary `DATA_DIR`, import `oauth.ts`, persist `FRESH_AUTH`, and issue tokens from `TEST_AUTH`. Capture the returned MCP refresh token. Call `vi.resetModules()`, re-import `oauth.ts` with the same `DATA_DIR` so it reloads the same `data/secret`, mount a fresh Express app, and POST the captured token:

```typescript
const first = await import('./oauth');
first.persistAuthData(FRESH_AUTH, 'Personal LINE');
const { refresh_token } = first.issueTokens(TEST_AUTH);

vi.resetModules();
const restarted = await import('./oauth');
const { LineClient } = await import('./line-client');
vi.mocked(LineClient).mockClear();
await withOAuthServer(path.join(tmpdir, 'auth'), async restartBase => {
  const response = await fetch(`${restartBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string };
  expect(restarted.validateBearerToken(body.access_token)?.accessToken)
    .toBe(FRESH_AUTH.accessToken);
  expect(restarted.latestAuthData.get(TEST_AUTH.mid)?.accessToken)
    .toBe(FRESH_AUTH.accessToken);
  expect(LineClient).not.toHaveBeenCalled();
}, restarted.setupOAuthRoutes);
```

The shared server helper closes in `finally`; the `LineClient` assertion proves `/authorize` was not involved.

- [ ] **Step 7: Run the restart test and verify continuity**

Run: `npx vitest run src/oauth.test.ts -t "refresh token after restart"`

Expected: PASS as characterization of the existing signed-token and lazy-disk-load path. Keep `issueTokens` resolution exactly `latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? authData`; do not introduce server-side MCP token storage.

- [ ] **Step 8: Update user and maintainer documentation**

In `README.md`, update the auth flow and security notes to state:

```markdown
2. If several saved LINE accounts exist, choose the account by its LINE profile name
3. Scan the QR code with that account
4. Enter the PIN on first login or when LINE rejects an old saved certificate
5. Claude Code receives tokens automatically and retries the tool call

**Token lifecycle:** MCP refresh tokens remain usable across server restarts while
`data/secret` and the corresponding `data/auth/<mid>.json` record remain available.
Repeat authorization reuses the saved LINE certificate and normally requires QR
confirmation without a PIN.
```

Document `data/auth/*.json` as sensitive live credentials with `0600` files under a `0700` directory.

In `CLAUDE.md`, update the `oauth.ts`, `line-client.ts`, and auth-flow descriptions with `StoredAuthRecord`, account selector behavior, profile-name persistence, certificate-only login initialization, atomic persistence ordering, and `recordRefreshedAuth`.

- [ ] **Step 9: Run full verification**

Run: `npm run test:unit`

Expected: all unit tests pass with zero failures.

Run: `npm run build`

Expected: TypeScript exits successfully and `dist/` is generated.

Run: `npm run lint`

Expected: ESLint exits successfully with zero errors.

Run: `git diff --check origin/main...HEAD`

Expected: no whitespace errors.

- [ ] **Step 10: Commit refresh integration and documentation**

```bash
git add src/oauth.ts src/oauth.test.ts src/index.ts src/sync.ts README.md CLAUDE.md
git commit -m "fix: preserve LINE auth continuity across restarts"
```

Do not stage `dist/`, temporary auth files, or unrelated `specs/proposals/` worktree files.
