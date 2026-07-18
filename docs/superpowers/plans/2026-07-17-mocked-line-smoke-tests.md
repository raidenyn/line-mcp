# Mocked LINE Smoke Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, credential-free smoke tests that run strict mocked LINE behavior concurrently with both compiled application targets.

**Architecture:** Thread one optional `lineApiBaseUrl` from each CLI into every `LineClient`, preserving the production default. Build a local-only stateful LINE gateway under `tests/support`, then use a reusable child-process harness to run seeded and full OAuth scenarios against the composed and standalone CLIs.

**Tech Stack:** TypeScript 6, Node.js 24 `node:http`, Vitest 4, MCP SDK Streamable HTTP transport, Express application CLIs, SQLite, and the existing real LTSM WASM signer.

## Global Constraints

- Do not create a Git worktree; this repository explicitly forbids worktrees.
- Keep the live `npm run test:e2e` behavior unchanged.
- Keep the production LINE API default exactly `https://line-chrome-gw.line-apps.com`.
- Only `packages/server/src/cli.ts` and `packages/line-mcp/src/cli.ts` may read `LINE_API_BASE_URL`.
- Do not add a workspace package or production dependency for the mock.
- Do not edit `packages/line-client/assets/ltsm/*`.
- Use `@raidenyn/line-client`'s public `signForAccount` API for expected HMACs.
- Bind the mock to `127.0.0.1`; all fetched smoke-test URLs must remain local.
- Preserve package import boundaries and side-effect-free package entry points.
- Use TDD for each task: failing test, observed failure, minimal implementation, passing test, then commit.

## File Structure

### Production files to modify

- `packages/line-client/src/client.ts`: normalize and use the configurable LINE gateway.
- `packages/line-client/src/index.ts`: expose `lineApiBaseUrl` through `LineClientOptions`.
- `packages/line-mcp/src/request-client.ts`: forward the gateway to request-scoped clients.
- `packages/line-mcp/src/auth/oauth-router.ts`: use the gateway for QR login clients.
- `packages/line-mcp/src/auth/line-auth-provider.ts`: forward gateway configuration to OAuth routes.
- `packages/line-mcp/src/standalone.ts`: configure OAuth and request clients consistently.
- `packages/line-mcp/src/cli.ts`: read `LINE_API_BASE_URL` for standalone execution.
- `packages/server/src/request-client.ts`: preserve the gateway through the composition wrapper.
- `packages/server/src/server.ts`: configure OAuth and request clients consistently.
- `packages/server/src/cli.ts`: read `LINE_API_BASE_URL` for composed execution.

### Test-support files to create

- `tests/support/mock-line-server/fixtures.ts`: deterministic auth, chat, message, image, import, and expected-output fixtures.
- `tests/support/mock-line-server/state.ts`: QR, certificate, access-token, refresh, pagination, trace, and report state.
- `tests/support/mock-line-server/contracts.ts`: raw request, exact-body/header/HMAC validation, redaction, and LINE response helpers.
- `tests/support/mock-line-server/server.ts`: LINE, image, and authenticated control HTTP routes.
- `tests/support/mock-line-server/cli.ts`: standalone mock process readiness and shutdown.
- `tests/support/process-harness.ts`: managed process groups, readiness, logs, MCP connections, and cleanup.
- `tests/support/smoke-helpers.ts`: seeded credential preparation, OAuth driver, fixture-derived MCP assertions.

### Test files to create or modify

- Modify `packages/line-client/src/client.test.ts`.
- Create `packages/line-mcp/src/request-client.test.ts`.
- Modify `packages/line-mcp/src/auth/oauth-router.test.ts`.
- Modify `packages/server/src/request-client.test.ts`.
- Create `tests/smoke/mock-line-contract.test.ts`.
- Create `tests/smoke/process-harness.test.ts`.
- Create `tests/smoke/mock-line-smoke.test.ts`.

### Integration and documentation files to modify

- `package.json`
- `.github/workflows/ci.yml`
- `README.md`
- `CLAUDE.md`

---

### Task 1: Thread the LINE Gateway URL Through Production

**Files:**
- Modify: `packages/line-client/src/client.ts:4-5,82-112,143-188,223-257`
- Modify: `packages/line-client/src/index.ts:42-55`
- Modify: `packages/line-mcp/src/request-client.ts:23-53`
- Create: `packages/line-mcp/src/request-client.test.ts`
- Modify: `packages/line-mcp/src/auth/oauth-router.ts:24-35,260-267`
- Modify: `packages/line-mcp/src/auth/oauth-router.test.ts:56-73,305-359`
- Modify: `packages/line-mcp/src/auth/line-auth-provider.ts:57-74,124-135`
- Modify: `packages/line-mcp/src/standalone.ts:102-109,149-166`
- Modify: `packages/line-mcp/src/cli.ts:8-15`
- Modify: `packages/server/src/request-client.ts:24-40`
- Modify: `packages/server/src/request-client.test.ts:31-45`
- Modify: `packages/server/src/server.ts:39-52,113-138`
- Modify: `packages/server/src/cli.ts:6-35`
- Test: `packages/line-client/src/client.test.ts`

**Interfaces:**
- Produces: `LineClientOptions.lineApiBaseUrl?: string`.
- Produces: fourth optional `LineClient` constructor argument `lineApiBaseUrl?: string`.
- Produces: the same optional property on `RequestClientFactoryOptions`, `ServerRequestClientOptions`, `OAuthRouterDeps`, `LineAuthProviderOptions`, `StandaloneOptions`, and `ServerOptions`.
- Preserves: every existing constructor/factory call because all additions are optional.

- [ ] **Step 1: Add failing core-client URL tests**

Import `createLineClient` beside `LineClient`, then add these cases to
`packages/line-client/src/client.test.ts`:

```ts
describe('LineClient gateway base URL', () => {
  it('keeps the production gateway by default', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    await new LineClient(baseAuth, fetchFn).listChats();
    expect(fetchFn.mock.calls.every(([url]) =>
      url.startsWith('https://line-chrome-gw.line-apps.com/api/'),
    )).toBe(true);
  });

  it('uses and normalizes a custom gateway for ordinary requests', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new LineClient(baseAuth, fetchFn, undefined, 'http://127.0.0.1:18181/');

    await client.listChats();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [url] of fetchFn.mock.calls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:18181\/api\//);
      expect(url).not.toContain('18181//api');
    }
  });

  it('forwards the public createLineClient option', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = createLineClient(baseAuth, {
      fetch: fetchFn,
      lineApiBaseUrl: 'http://127.0.0.1:18184',
    });

    await client.listChats();

    expect(fetchFn.mock.calls.every(([url]) =>
      url.startsWith('http://127.0.0.1:18184/api/'),
    )).toBe(true);
  });

  it('uses the same custom gateway for token refresh', async () => {
    const soonAuth = { ...baseAuth, accessToken: makeFakeJwt(3600) };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/tokenRefresh')) {
        return new Response(JSON.stringify({ accessToken: makeFakeJwt(), refreshToken: 'rotated' }));
      }
      if (url.endsWith('/getAllChatMids')) return apiOk({ memberChatMids: [], invitedChatMids: [] });
      if (url.endsWith('/getAllContactIds')) return apiOk([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new LineClient(soonAuth, fetchFn, undefined, 'http://127.0.0.1:18182');

    await client.listChats();

    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:18182/api/auth/tokenRefresh');
  });

  it('does not rewrite an absolute image URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(Buffer.from([1]), {
      headers: { 'content-type': 'image/jpeg' },
    }));
    const client = new LineClient(baseAuth, fetchFn, undefined, 'http://127.0.0.1:18183');

    await client.getImageBuffer('http://127.0.0.1:19191/fixture.jpg');

    expect(fetchFn).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:19191/fixture.jpg');
  });
});
```

- [ ] **Step 2: Add failing factory and OAuth forwarding tests**

Create `packages/line-mcp/src/request-client.test.ts` with a mocked public client factory:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@raidenyn/line-client', async importOriginal => {
  const original = await importOriginal<typeof import('@raidenyn/line-client')>();
  return {
    ...original,
    createLineClient: vi.fn(() => ({
      getMessages: vi.fn(),
      getMessagesInRange: vi.fn(),
    })),
    withMessageCache: vi.fn((_api, _cache, ownerMid) => ({ ownerMid })),
  };
});

import { createLineClient } from '@raidenyn/line-client';
import { createRequestClientFactory } from './request-client';

describe('createRequestClientFactory gateway forwarding', () => {
  it('passes lineApiBaseUrl to each LINE client', async () => {
    const authData = {
      accessToken: 'access', refreshToken: 'refresh', certificate: 'certificate', mid: 'u-smoke',
      wrappedNonce: 'nonce', kdfParameter1: 'kdf1', kdfParameter2: 'kdf2',
    };
    const factory = createRequestClientFactory({
      cache: {
        getMessages: vi.fn().mockReturnValue([]),
        upsertMessages: vi.fn(),
        latestTimestamp: vi.fn().mockReturnValue(null),
        getDistinctChatMids: vi.fn().mockReturnValue([]),
      },
      resolveCredentials: vi.fn().mockResolvedValue(authData),
      lineApiBaseUrl: 'http://127.0.0.1:18200',
    });

    await factory({ provider: 'line', subject: authData.mid, mid: authData.mid, scopes: ['line'] });

    expect(createLineClient).toHaveBeenCalledWith(authData, {
      onAuthRefreshed: undefined,
      lineApiBaseUrl: 'http://127.0.0.1:18200',
    });
  });
});
```

Extend the existing OAuth test helper with `lineApiBaseUrl?: string`, initiate `/authorize`, and assert:

```ts
expect(LineClient).toHaveBeenCalledWith(
  undefined,
  globalThis.fetch,
  undefined,
  'http://127.0.0.1:18201',
);
```

Extend `packages/server/src/request-client.test.ts`'s passthrough case:

```ts
const lineApiBaseUrl = 'http://127.0.0.1:18202';
createServerRequestClientFactory({ cache, resolveCredentials, authStoreDir: '/tmp/does-not-matter', lineApiBaseUrl });
expect(factorySpy.mock.calls[0][0].lineApiBaseUrl).toBe(lineApiBaseUrl);
```

- [ ] **Step 3: Run focused tests and confirm the missing API fails**

Run:

```bash
npx vitest run packages/line-client/src/client.test.ts packages/line-mcp/src/request-client.test.ts packages/line-mcp/src/auth/oauth-router.test.ts packages/server/src/request-client.test.ts
```

Expected: FAIL because the fourth constructor argument and `lineApiBaseUrl` option properties do not exist or are ignored.

- [ ] **Step 4: Implement the minimal gateway seam**

Use one name everywhere: `lineApiBaseUrl`.

In `packages/line-client/src/client.ts`:

```ts
const DEFAULT_LINE_API_BASE_URL = 'https://line-chrome-gw.line-apps.com';

export class LineClient {
  private readonly lineApiBaseUrl: string;

  constructor(
    auth?: AuthData | null,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly onTokenRefreshed?: (snapshot: Readonly<AuthData>) => void | Promise<void>,
    lineApiBaseUrl = DEFAULT_LINE_API_BASE_URL,
  ) {
    this.lineApiBaseUrl = lineApiBaseUrl.replace(/\/$/, '');
    if (auth) this.auth = { ...auth };
  }
}
```

Replace only the first argument of the two existing `fetchFn` calls. The
ordinary request call becomes:

```ts
const response = await this.fetchFn(this.lineApiBaseUrl + path, {
  method: 'POST',
  headers,
  body,
  signal: opts.signal,
});
```

The refresh call becomes:

```ts
const response = await this.fetchFn(`${this.lineApiBaseUrl}/api/auth/tokenRefresh`, {
  method: 'POST',
  headers: { ...BASE_HEADERS, 'content-type': 'application/json' },
  body: JSON.stringify({ refreshToken: auth.refreshToken }),
});
```

In `packages/line-client/src/index.ts`:

```ts
export interface LineClientOptions {
  fetch?: typeof globalThis.fetch;
  onAuthRefreshed?: (snapshot: Readonly<AuthData>) => void | Promise<void>;
  lineApiBaseUrl?: string;
}

const inner = new LineClient(
  auth,
  options.fetch ?? globalThis.fetch,
  options.onAuthRefreshed,
  options.lineApiBaseUrl,
);
```

Add `lineApiBaseUrl?: string` to every interface named in this task's Interfaces block. Forward it in these exact constructions:

```ts
createLineClient(authData, {
  onAuthRefreshed: options.onAuthRefreshed,
  lineApiBaseUrl: options.lineApiBaseUrl,
});
```

```ts
new LineClient(undefined, globalThis.fetch, undefined, deps.lineApiBaseUrl);
```

```ts
new LineAuthProvider({
  secret,
  endpoints,
  credentialStore,
  authStoreDir,
  lineApiBaseUrl: options.lineApiBaseUrl,
});
```

```ts
createRequestClientFactory({
  cache,
  resolveCredentials,
  onAuthRefreshed,
  lineApiBaseUrl: options.lineApiBaseUrl,
});
```

Both CLIs pass:

```ts
lineApiBaseUrl: process.env.LINE_API_BASE_URL,
```

- [ ] **Step 5: Run focused and package-boundary tests**

Run:

```bash
npx vitest run packages/line-client/src/client.test.ts packages/line-mcp/src/request-client.test.ts packages/line-mcp/src/auth/oauth-router.test.ts packages/server/src/request-client.test.ts
npx vitest run tests/architecture/import-boundaries.test.ts
npm run build
```

Expected: all commands PASS; existing constructor call sites compile unchanged.

- [ ] **Step 6: Commit the gateway seam**

```bash
git add docs/superpowers/plans/2026-07-17-mocked-line-smoke-tests.md packages/line-client/src/client.ts packages/line-client/src/client.test.ts packages/line-client/src/index.ts packages/line-mcp/src/request-client.ts packages/line-mcp/src/request-client.test.ts packages/line-mcp/src/auth/oauth-router.ts packages/line-mcp/src/auth/oauth-router.test.ts packages/line-mcp/src/auth/line-auth-provider.ts packages/line-mcp/src/standalone.ts packages/line-mcp/src/cli.ts packages/server/src/request-client.ts packages/server/src/request-client.test.ts packages/server/src/server.ts packages/server/src/cli.ts
git commit -m "feat: configure LINE API gateway"
```

---

### Task 2: Build Deterministic Fixtures and Protocol State

**Files:**
- Create: `tests/support/mock-line-server/fixtures.ts`
- Create: `tests/support/mock-line-server/state.ts`
- Create: `tests/smoke/mock-line-contract.test.ts`

**Interfaces:**
- Produces: `buildMockFixtures({ origin, epochSeconds }): MockFixtures`.
- Produces: constants `MOCK_ACCOUNT_MID`, `MOCK_GROUP_MID`, `MOCK_DIRECT_MID`, `MOCK_PIN`, `VALID_STORAGE_KEY`, `JPEG_BYTES`, and `EXPORT_FILE_TEXT`.
- Produces: `MockLineState.configure`, `authenticateAccess`, `refresh`, `createSession`, `markQrCreated`, `markQrVerified`, `verifyCertificate`, `markPinVerified`, `completeLogin`, `requireSession`, `resolveBoundary`, `reject`, `report`, and `verifyFinal`.
- Produces: `MockScenarioConfig` and `MockReport`, consumed by the mock server and process harness.

- [ ] **Step 1: Write failing fixture and state tests**

Start `tests/smoke/mock-line-contract.test.ts` with pure state tests:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildMockFixtures,
  MOCK_GROUP_MID,
  MOCK_PIN,
} from '../support/mock-line-server/fixtures';
import { MockLineState } from '../support/mock-line-server/state';

const epochSeconds = Math.floor(Date.now() / 1000);
const fixtures = buildMockFixtures({ origin: 'http://127.0.0.1:19090', epochSeconds });

describe('mock LINE fixtures and state', () => {
  it('provides deterministic paginated message and image data', () => {
    expect(fixtures.messagesByChat[MOCK_GROUP_MID]).toHaveLength(205);
    expect(fixtures.messagesByChat[MOCK_GROUP_MID].at(-1)?.contentType).toBe(1);
    expect(fixtures.image.previewUrl).toBe('http://127.0.0.1:19090/fixtures/images/message-preview.jpg');
    expect(MOCK_PIN).toBe('592130');
  });

  it('rotates seeded credentials and supersedes the old pair', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-refresh', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
    });
    const oldAccess = state.fixtures.seededAuth.accessToken;
    const oldRefresh = state.fixtures.seededAuth.refreshToken;

    const rotated = state.refresh(oldRefresh);

    expect(rotated).not.toBeNull();
    expect(state.authenticateAccess(oldAccess).kind).toBe('superseded');
    expect(state.authenticateAccess(rotated!.accessToken).kind).toBe('current');
    expect(state.report().refreshCount).toBe(1);
  });

  it('requires the PIN branch before first login and accepts the issued certificate next', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-login', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
    });

    const first = state.createSession();
    state.markQrCreated(first.authSessionId);
    state.markQrVerified(first.authSessionId);
    expect(state.verifyCertificate(first.authSessionId, '')).toEqual({ accepted: false, pinRequired: true });
    state.markPinVerified(first.authSessionId);
    const issued = state.completeLogin(first.authSessionId);

    const second = state.createSession();
    state.markQrCreated(second.authSessionId);
    state.markQrVerified(second.authSessionId);
    expect(state.verifyCertificate(second.authSessionId, issued.certificate)).toEqual({ accepted: true, pinRequired: false });
  });

  it('distinguishes end-of-history from a foreign boundary', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-boundary', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const history = fixtures.messagesByChat[MOCK_GROUP_MID];
    const oldest = history[0];

    expect(state.resolveBoundary(MOCK_GROUP_MID, oldest.id, oldest.deliveredTime!)).toMatchObject({ kind: 'end' });
    expect(state.resolveBoundary(MOCK_GROUP_MID, 'missing', '0')).toEqual({ kind: 'invalid' });
  });
});
```

- [ ] **Step 2: Run the tests and confirm missing modules fail**

Run:

```bash
npx vitest run tests/smoke/mock-line-contract.test.ts
```

Expected: FAIL because `fixtures.ts` and `state.ts` do not exist.

- [ ] **Step 3: Implement deterministic fixtures**

Define stable safe MIDs and real storage material in `fixtures.ts`:

```ts
import type { AuthData, StorageKeyMaterial } from '@raidenyn/line-client';

export const MOCK_ACCOUNT_MID = 'u_mock_account_0001';
export const MOCK_GROUP_MID = 'c_mock_bank_group_0001';
export const MOCK_DIRECT_MID = 'u_mock_alice_0001';
export const MOCK_BANK_SENDER_MID = 'u_mock_bank_sender_0001';
export const MOCK_PIN = '592130';
export const MOCK_CERTIFICATE = 'mock-certificate-v1';

export const VALID_STORAGE_KEY: Readonly<StorageKeyMaterial> = {
  mid: MOCK_ACCOUNT_MID,
  wrappedNonce: 'AjsSI8WwGhQoymf7fzeYgp4ecqDpl9htub88/l+416eGYZ0AkRAyICML306xrIBT',
  kdfParameter1: 'W5kowvH9dJNVemz7XD2dww==',
  kdfParameter2: '+ZFNyJlBAnn2W5e9m/ALYA==',
};

export const JPEG_BYTES = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64');
export const EXPORT_FILE_TEXT = [
  'Chat history with Mock Bank Group',
  '',
  'Fri, 7/17/2026',
  '09:00\tAlice Mock\tImported deterministic message',
].join('\n');

export interface MockRawMessage {
  id: string;
  from: string;
  to: string;
  toType: number;
  createdTime: string;
  deliveredTime: string;
  contentType: number;
  text?: string;
  hasContent: boolean;
  contentMetadata?: Record<string, string>;
}

export interface MockFixtures {
  seededAuth: AuthData;
  tokenFixtures: {
    rotatedAccessToken: string;
    rotatedRefreshToken: string;
  };
  messagesByChat: Record<string, MockRawMessage[]>;
  image: { previewUrl: string; downloadUrl: string; bytes: Buffer; mimeType: 'image/jpeg' };
  expected: {
    listChatsText: string;
    recentMessagesText: string;
    importResult: Record<string, unknown>;
    transactions: readonly Record<string, unknown>[];
    summaries: Readonly<Record<string, unknown>>;
  };
}

function rawMessage(input: {
  id: string;
  from: string;
  to: string;
  createdTime: string;
  text?: string;
  contentType?: number;
  hasContent?: boolean;
  contentMetadata?: Record<string, string>;
}): MockRawMessage {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    toType: input.to === MOCK_GROUP_MID ? 2 : 0,
    createdTime: input.createdTime,
    deliveredTime: input.createdTime,
    contentType: input.contentType ?? 0,
    text: input.text,
    hasContent: input.hasContent ?? false,
    contentMetadata: input.contentMetadata,
  };
}
```

Generate JWTs without signing because the mock tracks issuance independently and `LineClient` only reads `exp`:

```ts
export function makeMockLineJwt(id: string, iat: number, exp: number): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    jti: id, aud: 'LINE', iat, exp, scp: 'LINE_CORE', rtid: `refresh-${id}`,
    rexp: iat + 31_536_000, ver: '3.1', aid: MOCK_ACCOUNT_MID,
    lsid: `session-${id}`, did: 'NONE', ctype: 'CHROMEOS',
    cmode: 'SECONDARY', cid: '0300000000',
  })).toString('base64url');
  return `${header}.${payload}.mock-signature`;
}
```

Build 205 oldest-first group messages at one-minute intervals. Use ordinary text for indices 0-201, then exact transaction texts and one image:

```ts
const groupMessages = Array.from({ length: 202 }, (_, index) => rawMessage({
  id: `group-history-${String(index).padStart(3, '0')}`,
  from: MOCK_DIRECT_MID,
  to: MOCK_GROUP_MID,
  createdTime: String(Date.UTC(2026, 6, 14, 0, index)),
  text: `Deterministic history message ${index}`,
}));

groupMessages.push(
  rawMessage({
    id: 'group-debit', from: MOCK_BANK_SENDER_MID, to: MOCK_GROUP_MID,
    createdTime: String(Date.UTC(2026, 6, 17, 2, 0)),
    text: 'MOCK TX -125.50 THB at Mock Cafe | 2026-07-17T02:00:00.000Z | acct 1234 | bal 1000.00',
  }),
  rawMessage({
    id: 'group-credit', from: MOCK_BANK_SENDER_MID, to: MOCK_GROUP_MID,
    createdTime: String(Date.UTC(2026, 6, 17, 3, 0)),
    text: 'MOCK TX +500.00 THB at Mock Employer | 2026-07-17T03:00:00.000Z | acct 1234 | bal 1500.00',
  }),
  rawMessage({
    id: 'group-image', from: MOCK_DIRECT_MID, to: MOCK_GROUP_MID,
    createdTime: String(Date.UTC(2026, 6, 17, 4, 0)), contentType: 1, hasContent: true,
    contentMetadata: { PREVIEW_URL: `${origin}/fixtures/images/message-preview.jpg`, DOWNLOAD_URL: `${origin}/fixtures/images/message-full.jpg` },
  }),
);
```

Return one group, one direct contact, all sender contacts, the seeded near-expiry auth, image URLs, and fixture-derived expected values from `buildMockFixtures`.

- [ ] **Step 4: Implement protocol state and report verification**

Use these exact public types in `state.ts`:

```ts
export type MockScenarioMode = 'seeded' | 'full-auth' | 'contract';
export type LoginBranch = 'pin' | 'certificate';
export type ExpectedRejectionKind =
  | 'missing_hmac' | 'invalid_hmac' | 'expired_access_token'
  | 'superseded_access_token' | 'unknown_access_token' | 'unknown_refresh_token'
  | 'missing_auth_header' | 'invalid_body' | 'invalid_session'
  | 'illegal_transition' | 'unknown_boundary' | 'unknown_route';

export interface MockScenarioConfig {
  scenarioId: string;
  mode: MockScenarioMode;
  epochSeconds: number;
  expectedRefreshCount: number;
  expectedLoginBranches: readonly LoginBranch[];
  expectedRejections: Partial<Record<ExpectedRejectionKind, number>>;
}

export interface MockReport {
  scenarioId: string | null;
  routeCounts: Readonly<Record<string, number>>;
  observedLoginBranches: readonly LoginBranch[];
  refreshCount: number;
  expectedRejections: Readonly<Record<string, number>>;
  observedExpectedRejections: Readonly<Record<string, number>>;
  violations: readonly { route: string; kind: ExpectedRejectionKind; diagnostic: unknown }[];
  pendingLineRequests: number;
  unresolvedSessions: number;
  verificationErrors: readonly string[];
  ok: boolean;
}
```

Implement `MockLineState` with this constructor and fixture ownership:

```ts
export class MockLineState {
  fixtures: MockFixtures;

  constructor(private readonly input: { origin: string }) {
    this.fixtures = buildMockFixtures({
      origin: input.origin,
      epochSeconds: Math.floor(Date.now() / 1000),
    });
  }

  configure(config: MockScenarioConfig): void {
    this.reset();
    this.config = config;
    this.fixtures = buildMockFixtures({ origin: this.input.origin, epochSeconds: config.epochSeconds });
    this.registerScenarioTokens();
  }
}
```

Use maps for tokens and sessions. `refresh` must mark both old tokens superseded, issue an access JWT with more than 24 hours remaining, rotate the refresh token, and increment `refreshCount`. `reject` consumes a configured expected rejection count; otherwise it appends a redacted violation. `verifyFinal` compares exact expected refresh/login/rejection counts and checks zero pending requests and unresolved sessions.

- [ ] **Step 5: Run the state tests**

Run:

```bash
npx vitest run tests/smoke/mock-line-contract.test.ts
```

Expected: PASS for all pure fixture/state cases.

- [ ] **Step 6: Commit fixtures and state**

```bash
git add tests/support/mock-line-server/fixtures.ts tests/support/mock-line-server/state.ts tests/smoke/mock-line-contract.test.ts
git commit -m "test: add deterministic LINE protocol state"
```

---

### Task 3: Implement the Strict Mock LINE HTTP Server

**Files:**
- Create: `tests/support/mock-line-server/contracts.ts`
- Create: `tests/support/mock-line-server/server.ts`
- Modify: `tests/smoke/mock-line-contract.test.ts`

**Interfaces:**
- Consumes: `MockFixtures`, `MockLineState`, `VALID_STORAGE_KEY` from Task 2.
- Produces: `createMockLineServer(options): MockLineServer`.
- Produces: local control routes `/__mock/health`, `/__mock/reset`, `/__mock/configure`, `/__mock/report`, and `/__mock/shutdown`.
- Produces: all LINE routes currently called by `LineClient` login, refresh, chat, contact, message, profile, identity, and image operations.

- [ ] **Step 1: Add failing HTTP contract tests**

Extend `tests/smoke/mock-line-contract.test.ts` with a real in-process server and helper:

```ts
import { beforeAll, afterAll } from 'vitest';
import { signForAccount } from '@raidenyn/line-client';
import { createMockLineServer, type MockLineServer } from '../support/mock-line-server/server';
import { VALID_STORAGE_KEY } from '../support/mock-line-server/fixtures';
import { REQUIRED_LINE_HEADERS } from '../support/mock-line-server/contracts';

let mock: MockLineServer;
let origin: string;

async function signedPost(pathname: string, body: string, accessToken = ''): Promise<Response> {
  const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken, path: pathname, body });
  return fetch(origin + pathname, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US',
      'content-type': 'application/json',
      origin: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'x-lal': 'en_US',
      'x-line-chrome-version': '3.7.2',
      'x-hmac': hmac,
      ...(accessToken ? { 'x-line-access': accessToken } : {}),
    },
    body,
  });
}

beforeAll(async () => {
  mock = createMockLineServer({ port: 0, controlToken: 'contract-control-token', pinPollDelayMs: 50 });
  ({ origin } = await mock.start());
});

afterAll(async () => {
  await mock.stop({ verify: false });
});
```

Add explicit cases for:

```ts
it('accepts an exact createSession body signed over raw bytes', async () => {
  mock.state.configure({
    scenarioId: 'valid-create-session', mode: 'contract', epochSeconds,
    expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
  });
  const response = await signedPost(
    '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
    '[ {} ]',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ code: 0, data: { authSessionId: expect.stringMatching(/^SQ/) } });
});

it('rejects a wrong HMAC and records the configured rejection', async () => {
  mock.state.configure({
    scenarioId: 'bad-hmac', mode: 'contract', epochSeconds,
    expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_hmac: 1 },
  });
  const response = await fetch(origin + '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', {
    method: 'POST',
    headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': Buffer.alloc(32).toString('base64') },
    body: '[{}]',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 10005, message: 'REQUEST_INVALID_HMAC' });
  expect(mock.state.report().ok).toBe(true);
});
```

Add one test for every configured rejection kind, one full PIN login sequence, one certificate login sequence, refresh rotation, list/chat/contact response shapes, recent/previous pagination including boundary re-inclusion, invalid foreign boundary, exact JPEG bytes, and control-route authentication.

- [ ] **Step 2: Run tests and confirm missing server modules fail**

Run:

```bash
npx vitest run tests/smoke/mock-line-contract.test.ts
```

Expected: FAIL because `contracts.ts` and `server.ts` do not exist.

- [ ] **Step 3: Implement raw request and validation helpers**

In `contracts.ts`, export:

```ts
export const REQUIRED_LINE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US',
  'content-type': 'application/json',
  origin: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'x-lal': 'en_US',
  'x-line-chrome-version': '3.7.2',
} as const;

export function lineOk<T>(data: T) {
  return { code: 0 as const, message: 'OK' as const, data };
}

export function lineApiError(code: number, message: string, data: unknown = null) {
  return { code, message, data };
}
```

Read at most 1 MiB of raw bytes before JSON parsing. Validate exact headers, required/forbidden `x-line-access`, long-poll headers, and raw-body HMAC. HMAC validation must be:

```ts
const expected = await signForAccount(VALID_STORAGE_KEY, {
  accessToken,
  path: request.pathname,
  body: request.rawBody.toString('utf8'),
});
const expectedBytes = Buffer.from(expected, 'base64');
const actualBytes = Buffer.from(actual, 'base64');
const valid = expectedBytes.length === 32 && actualBytes.length === 32 &&
  crypto.timingSafeEqual(expectedBytes, actualBytes);
```

Redact keys matching `/authorization|token|certificate|nonce|kdf|hmac|secret|mid/i`; retain only a SHA-256 fingerprint prefix when correlation is needed.

- [ ] **Step 4: Implement route dispatch and exact protocol behavior**

Use `node:http`, not Express, so handlers retain raw bytes. Dispatch these exact routes:

```ts
const LINE_ROUTES = {
  createSession: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
  createQrCode: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode',
  checkQr: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
  verifyCertificate: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate',
  createPin: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode',
  checkPin: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified',
  login: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
  identity: '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
  profile: '/api/talk/thrift/Talk/TalkService/getProfile',
  allChatMids: '/api/talk/thrift/Talk/TalkService/getAllChatMids',
  allContactIds: '/api/talk/thrift/Talk/TalkService/getAllContactIds',
  chats: '/api/talk/thrift/Talk/TalkService/getChats',
  contacts: '/api/talk/thrift/Talk/TalkService/getContactsV2',
  recent: '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2',
  previous: '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
  refresh: '/api/auth/tokenRefresh',
} as const;
```

The exact request bodies and responses are:

| Route key | Exact body shape | Response data |
|---|---|---|
| `createSession` | `[{}]` | `{ authSessionId }` |
| `createQrCode` | `[{ authSessionId }]` | `{ callbackUrl, longPollingMaxCount: 2, longPollingIntervalSec: 150 }` |
| `checkQr` | `[{ authSessionId }]` plus exact poll headers | `{}` |
| `verifyCertificate` | `[{ authSessionId, certificate }]` | success `{}` or HTTP 200 API code `10051`, nested code `2` |
| `createPin` | `[{ authSessionId }]` after rejection | `{ pinCode: '592130' }` |
| `checkPin` | `[{ authSessionId }]` plus exact poll headers | delayed success `{}` |
| `login` | `[{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]` | replacement certificate, tracked token pair, account MID |
| `identity` | `[]` | `VALID_STORAGE_KEY` fields without MID |
| `profile` | `[2]` | account MID and `Mock LINE Account` |
| `allChatMids` | `[{ withMemberChats: true, withInvitedChats: true }, 2]` | fixture group MID |
| `allContactIds` | `[2]` | fixture direct MID |
| `chats` | `[{ chatMids: [MOCK_GROUP_MID] }, 2]` | fixture group metadata |
| `contacts` | `[{ targetUserMids }]`, unique known MIDs, 1-50 | requested contact record only |
| `recent` | `[knownChatMid, count]`, integer 1-200 | newest-first suffix honoring count |
| `previous` | `[{ messageBoxId, endMessageId, messagesCount }, 1]` | boundary-inclusive older page or known end `[]` |
| `refresh` | `{ refreshToken }` with auth/HMAC headers forbidden | unwrapped rotated token pair |

Allow either arrival order inside the two `Promise.all` pairs used by `listChats`; do not create false ordering state between `allChatMids`/`allContactIds` or `chats`/`contacts`.

Serve `JPEG_BYTES` from both `/fixtures/images/message-preview.jpg` and `/fixtures/images/message-full.jpg` as `image/jpeg`.

Control routes require `x-mock-control-token`, call state methods, and never share LINE header/HMAC validation.

- [ ] **Step 5: Run strict contract tests**

Run:

```bash
npx vitest run tests/smoke/mock-line-contract.test.ts
```

Expected: PASS, including real WASM HMAC validation and all rejection probes.

- [ ] **Step 6: Commit the strict HTTP mock**

```bash
git add tests/support/mock-line-server/contracts.ts tests/support/mock-line-server/server.ts tests/smoke/mock-line-contract.test.ts
git commit -m "test: emulate strict LINE gateway behavior"
```

---

### Task 4: Add Mock CLI and Reliable Process Harness

**Files:**
- Create: `tests/support/mock-line-server/cli.ts`
- Create: `tests/support/process-harness.ts`
- Create: `tests/smoke/process-harness.test.ts`

**Interfaces:**
- Consumes: `createMockLineServer` from Task 3.
- Produces: `startMockLineServer(projectRoot): Promise<RunningMock>`.
- Produces: `startApplication({ target, projectRoot, dataRoot, port, lineApiBaseUrl }): Promise<RunningApp>`.
- Produces: `spawnManagedNode`, `reserveFreePort`, `waitForHttp`, `connectMcp`, and idempotent `terminate`/`close` methods.

- [ ] **Step 1: Write failing process lifecycle tests**

Create `tests/smoke/process-harness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { startMockLineServer, spawnManagedNode } from '../support/process-harness';

const projectRoot = path.resolve(__dirname, '..', '..');

describe('process harness', () => {
  it('starts and gracefully stops the standalone mock executable', async () => {
    const mock = await startMockLineServer(projectRoot);
    try {
      const response = await fetch(`${mock.origin}/__mock/health`, {
        headers: { 'x-mock-control-token': mock.controlToken },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', protocol: 'mock-line-v1' });
    } finally {
      await mock.shutdown({ verify: false });
    }
    expect(await mock.process.waitForExit(1_000)).toBe(0);
  });

  it('terminates a detached process group idempotently', async () => {
    const managed = await spawnManagedNode({
      label: 'long-running-fixture', cwd: projectRoot,
      args: ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready\\n')"],
      readyLine: line => line === 'ready',
    });
    await Promise.all([managed.terminate(), managed.terminate()]);
    expect(await managed.waitForExit(1_000)).not.toBeNull();
  });

  it('includes captured stderr when a child exits before readiness', async () => {
    await expect(spawnManagedNode({
      label: 'early-exit-fixture', cwd: projectRoot,
      args: ['-e', "process.stderr.write('fixture failed'); process.exit(7)"],
      readyLine: line => line === 'ready',
    })).rejects.toThrow(/fixture failed/);
  });
});
```

- [ ] **Step 2: Run tests and confirm missing harness fails**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts
```

Expected: FAIL because the CLI and process harness do not exist.

- [ ] **Step 3: Implement the standalone mock CLI**

`cli.ts` must prewarm real WASM signing before readiness:

```ts
await signForAccount(VALID_STORAGE_KEY, {
  accessToken: '',
  path: '/__mock/prewarm',
  body: '[]',
});
const server = createMockLineServer({
  host: '127.0.0.1',
  port: Number(process.env.PORT ?? '0'),
  controlToken: process.env.MOCK_LINE_CONTROL_TOKEN ?? '',
});
const address = await server.start();
process.stdout.write(JSON.stringify({
  event: 'mock-line-ready', host: address.host, port: address.port, protocol: 'mock-line-v1',
}) + '\n');
```

Reject an empty control token. Handle `SIGTERM`/`SIGINT` once, call `server.stop({ verify: true })`, and exit `1` when the report is not clean. `/__mock/shutdown` returns its report before closing the listener.

- [ ] **Step 4: Implement managed processes and control client**

Use `spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`. Capture bounded stdout/stderr, split stdout into lines, and race readiness against early exit and timeout.

Use this public shape:

```ts
export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  waitForExit(timeoutMs: number): Promise<number | null>;
  terminate(options?: { gracefulMs?: number }): Promise<void>;
}

export interface RunningMock {
  readonly process: ManagedProcess;
  readonly origin: string;
  readonly controlToken: string;
  reset(): Promise<void>;
  configure(config: MockScenarioConfig): Promise<void>;
  report(): Promise<MockReport>;
  shutdown(options?: { verify?: boolean }): Promise<MockReport>;
}
```

Start the TypeScript mock with:

```ts
args: [
  '-r', 'ts-node/register/transpile-only',
  path.join(projectRoot, 'tests/support/mock-line-server/cli.ts'),
],
env: {
  ...process.env,
  PORT: '0',
  MOCK_LINE_CONTROL_TOKEN: controlToken,
  TS_NODE_PROJECT: path.join(projectRoot, 'tsconfig.base.json'),
},
```

`terminate` sends `SIGTERM` to `-pid`, waits 2 seconds, sends `SIGKILL` to `-pid` if needed, and shares one cleanup promise across repeated calls. `startApplication` starts `packages/server/dist/cli.js` or `packages/line-mcp/dist/cli.js`, explicitly deletes inherited `TEST_TOKEN` and `LINE_AUTH_DATA`, supplies `PORT`, `DATA_DIR`, `BASE_PATH=/`, `PUBLIC_URL`, and `LINE_API_BASE_URL`, then waits for exact `/healthz` JSON.

- [ ] **Step 5: Run lifecycle tests repeatedly**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts
npx vitest run tests/smoke/process-harness.test.ts
```

Expected: both runs PASS and no process remains bound to a previous port.

- [ ] **Step 6: Commit process lifecycle support**

```bash
git add tests/support/mock-line-server/cli.ts tests/support/process-harness.ts tests/smoke/process-harness.test.ts
git commit -m "test: manage smoke test processes safely"
```

---

### Task 5: Add Seeded Composed and Standalone Smoke Scenarios

**Files:**
- Create: `tests/support/smoke-helpers.ts`
- Create: `tests/smoke/mock-line-smoke.test.ts`

**Interfaces:**
- Consumes: production gateway seam, `RunningMock`, `RunningApp`, `MockFixtures`, credential store, and MCP token codec.
- Produces: `prepareSeededDataRoot`, `connectMcp`, `assertToolSurface`, `assertResourceSurface`, `runMessengerAssertions`, and `runComposedBankAssertions`.
- Produces: composed-seeded and standalone-seeded process tests.

- [ ] **Step 1: Write failing seeded smoke tests**

Create `tests/smoke/mock-line-smoke.test.ts` with suite-owned mock lifecycle and scenario cleanup:

```ts
describe.sequential('mock-backed LINE smoke', () => {
  let mock: RunningMock;

  beforeAll(async () => {
    mock = await startMockLineServer(PROJECT_ROOT);
  }, 60_000);

  afterAll(async () => {
    await mock.shutdown({ verify: true });
  }, 15_000);

  it.each(['composed', 'standalone'] as const)('%s seeded credentials', async (target) => {
    const port = await reserveFreePort();
    const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-seeded-`);
    const fixtures = buildMockFixtures({ origin: mock.origin, epochSeconds });
    await mock.reset();
    await mock.configure({
      scenarioId: `${target}-seeded`, mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
    });
    const bearer = prepareSeededDataRoot({ dataRoot, appPort: port, fixtures });
    const app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
    const connection = await connectMcp(app.mcpUrl, bearer);
    try {
      await assertTargetSurface(connection.client, target);
      await runMessengerAssertions(connection.client, fixtures, app.origin);
      if (target === 'composed') await runComposedBankAssertions(connection.client, fixtures);
      const stored = loadStoredAuthRecord(MOCK_ACCOUNT_MID, path.join(dataRoot, 'auth'))!;
      expect(stored.accessToken).toBe(fixtures.tokenFixtures.rotatedAccessToken);
      expect(stored.refreshToken).toBe(fixtures.tokenFixtures.rotatedRefreshToken);
      expect(stored.displayName).toBe('Mock LINE Account');
      expect((await mock.report()).ok).toBe(true);
    } finally {
      await connection.close();
      await app.stop();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run the seeded tests and confirm helper failures**

Run:

```bash
npm run build
npx vitest run tests/smoke/mock-line-smoke.test.ts -t "seeded credentials"
```

Expected: FAIL because `smoke-helpers.ts` and seeded scenario helpers do not exist.

- [ ] **Step 3: Implement seeded root and MCP helpers**

`prepareSeededDataRoot` must use production persistence helpers, not hand-written file modes:

```ts
export function prepareSeededDataRoot(input: {
  dataRoot: string;
  appPort: number;
  fixtures: MockFixtures;
}): string {
  const secret = 'mock-mcp-signing-secret';
  fs.mkdirSync(input.dataRoot, { recursive: true });
  fs.writeFileSync(path.join(input.dataRoot, 'secret'), secret, 'utf8');
  persistAuthData(input.fixtures.seededAuth, 'Mock LINE Account', path.join(input.dataRoot, 'auth'));
  return createTokenCodec({
    secret,
    issuer: `http://localhost:${input.appPort}`,
    audience: `http://localhost:${input.appPort}/mcp`,
  }).issueAccessToken({ subject: MOCK_ACCOUNT_MID, scopes: ['line'], ttlSeconds: 3600 });
}
```

`connectMcp` creates a `StreamableHTTPClientTransport` with `Authorization: Bearer`, connects a `Client`, and returns one idempotent close function that closes client then transport.

- [ ] **Step 4: Implement exact messenger, resource, import, and bank assertions**

Use exact sorted surfaces:

```ts
const MESSENGER_TOOLS = ['complete_import', 'get_image', 'get_messages', 'initiate_import', 'list_chats'];
const BANK_TOOLS = ['get_transactions', 'manage_categories', 'manage_templates', 'sample_messages', 'summarize_transactions'];
const MESSENGER_RESOURCES = MESSENGER_TOOLS.map(name => `line://guide/tools/${name}`).concat('line://guide');
const COMPOSED_RESOURCES = MESSENGER_RESOURCES.concat(BANK_TOOLS.map(name => `line://guide/tools/${name}`));
```

Messenger assertions must:

1. Compare full `list_chats` text with `fixtures.expected.listChatsText`.
2. Call `get_messages` for `MOCK_GROUP_MID`, `count: 5`, compare full text with `fixtures.expected.recentMessagesText`, repeat, and compare again.
3. Decode the `get_image` result and compare exact MIME type and `JPEG_BYTES`.
4. Call `initiate_import`, upload `EXPORT_FILE_TEXT` to the returned local URL, call `complete_import` with `timezone: 'UTC'`, and compare the parsed result with `fixtures.expected.importResult`.
5. Read every resource and require `text/markdown`, non-empty text, and no `Guide file not found:` prefix.

For the composed target, upsert this exact template:

```ts
const template = {
  name: 'mock-signed-transaction',
  pattern: 'MOCK TX (?<original_amount>[+-][\\d,.]+) (?<original_currency>[A-Z]+) at (?<merchant>[^|]+) \\| (?<date>\\S+) \\| acct (?<account>\\S+) \\| bal (?<balance>[\\d,.]+)',
};
```

Then assert `sample_messages` and the custom template list. Call
`manage_templates` with `{ chatMid: MOCK_DIRECT_MID, action: 'list_presets' }`
and require `cardx` and `scb`. Call it again with
`{ chatMid: MOCK_DIRECT_MID, action: 'apply_preset', preset_name: 'cardx' }`,
list that chat's templates, and require the exact `cardx-debit` template before
deleting it by name. Upsert category
`{ name: 'Smoke Banking', pattern: 'Mock Cafe|Mock Employer' }`, then assert
exactly two transactions, one filtered debit, and exact month/category
summaries from fixture expected objects. Keep currencies THB so no Frankfurter
request can occur. Delete the custom group template and category at the end.

- [ ] **Step 5: Run seeded scenarios and inspect mock reports**

Run:

```bash
npx vitest run tests/smoke/mock-line-smoke.test.ts -t "seeded credentials"
```

Expected: both composed and standalone seeded scenarios PASS, each report shows exactly one LINE refresh, and app processes terminate cleanly.

- [ ] **Step 6: Commit seeded smoke coverage**

```bash
git add tests/support/smoke-helpers.ts tests/smoke/mock-line-smoke.test.ts
git commit -m "test: smoke both servers with seeded LINE auth"
```

---

### Task 6: Drive Full OAuth, PIN, Certificate Reuse, and MCP Refresh

**Files:**
- Modify: `tests/support/smoke-helpers.ts`
- Modify: `tests/smoke/mock-line-smoke.test.ts`

**Interfaces:**
- Consumes: full-auth mock state, real application OAuth routes, and process harness.
- Produces: `authorizeWithPkce(appOrigin): Promise<OAuthTokens>`.
- Produces: `refreshMcpToken(appOrigin, refreshToken): Promise<OAuthTokens>`.
- Produces: composed-full-auth and standalone-full-auth process tests.

- [ ] **Step 1: Add failing full-auth scenarios**

Add this second parameterized test:

```ts
it.each(['composed', 'standalone'] as const)('%s full OAuth login', async (target) => {
  const port = await reserveFreePort();
  const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-oauth-`);
  await mock.reset();
  await mock.configure({
    scenarioId: `${target}-full-auth`, mode: 'full-auth', epochSeconds,
    expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
  });
  const app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
  try {
    await assertMcpUnauthorized(app.origin, dataRoot, port);
    const first = await authorizeWithPkce(app.origin, { expectPin: true });
    const firstConnection = await connectMcp(app.mcpUrl, first.accessToken);
    await assertTargetSurface(firstConnection.client, target);
    expect(extractText(await firstConnection.client.callTool({ name: 'list_chats', arguments: {} })))
      .toBe(buildMockFixtures({ origin: mock.origin, epochSeconds }).expected.listChatsText);
    await firstConnection.close();

    const refreshed = await refreshMcpToken(app.origin, first.refreshToken);
    const refreshedConnection = await connectMcp(app.mcpUrl, refreshed.accessToken);
    await refreshedConnection.client.listTools();
    await refreshedConnection.close();

    await authorizeWithPkce(app.origin, { expectPin: false });
    const report = await mock.report();
    expect(report.observedLoginBranches).toEqual(['pin', 'certificate']);
    expect(report.routeCounts.createPin).toBe(1);
    expect(report.routeCounts.checkPin).toBe(1);
    expect(report.ok).toBe(true);
  } finally {
    await app.stop();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}, 120_000);
```

- [ ] **Step 2: Run full-auth cases and confirm missing OAuth helpers fail**

Run:

```bash
npx vitest run tests/smoke/mock-line-smoke.test.ts -t "full OAuth login"
```

Expected: FAIL because the PKCE, poll, token refresh, and unauthorized helpers do not exist.

- [ ] **Step 3: Implement deterministic PKCE authorization driver**

Implement this flow in `smoke-helpers.ts`:

```ts
export async function authorizeWithPkce(
  appOrigin: string,
  options: { expectPin: boolean },
): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://127.0.0.1:8765/callback';
  const registration = await fetch(`${appOrigin}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      client_name: 'mock-line-smoke', scope: 'line',
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json() as { client_id: string };
  const params = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'smoke-state',
  });
  const page = await (await fetch(`${appOrigin}/authorize?${params}`)).text();
  const contextText = page.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/)?.[1];
  if (!contextText) throw new Error('OAuth page did not include oauth-context');
  const { sid } = JSON.parse(contextText) as { sid: string };

  let observedPin: string | undefined;
  let code: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const poll = await (await fetch(`${appOrigin}/authorize/poll?sid=${encodeURIComponent(sid)}`)).json() as {
      phase: string; pin?: string; code?: string; error?: string;
    };
    if (poll.phase === 'pin_needed') observedPin = poll.pin;
    if (poll.phase === 'failed') throw new Error(`OAuth login failed: ${poll.error}`);
    if (poll.phase === 'complete') { code = poll.code; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(observedPin).toBe(options.expectPin ? MOCK_PIN : undefined);
  if (!code) throw new Error('OAuth login did not complete');
  const token = await fetch(`${appOrigin}/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier }),
  });
  expect(token.status).toBe(200);
  const body = await token.json() as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}
```

Keep the mock's `checkPinCodeVerified` response delayed by 250 ms so `/authorize/poll` must expose `pin_needed` before completion; do not depend on an arbitrary app-side sleep to create that phase.

- [ ] **Step 4: Implement MCP refresh and rejection checks**

`refreshMcpToken` posts `{ grant_type: 'refresh_token', refresh_token }` to `/token`, expects HTTP 200, and returns replacement tokens. Do not assert old MCP refresh-token revocation because current provider behavior does not revoke it.

`assertMcpUnauthorized` posts one JSON-RPC initialize-shaped body to `/mcp` with no bearer, garbage bearer, and an expired token minted using the data-root secret. Each response must be HTTP 401 with `{ error: 'invalid_token' }` and:

```text
Bearer error="invalid_token", resource_metadata="http://localhost:<port>/.well-known/oauth-protected-resource/mcp"
```

- [ ] **Step 5: Run all four smoke scenarios**

Run:

```bash
npx vitest run tests/smoke/mock-line-smoke.test.ts
```

Expected: four scenarios PASS; first OAuth login uses PIN, second uses the persisted certificate, MCP refresh works, and no mock violations or unresolved sessions remain.

- [ ] **Step 6: Commit full-auth smoke coverage**

```bash
git add tests/support/smoke-helpers.ts tests/smoke/mock-line-smoke.test.ts
git commit -m "test: smoke OAuth against mocked LINE"
```

---

### Task 7: Add the Command, CI Gate, Documentation, and Final Verification

**Files:**
- Modify: `package.json:9-16`
- Modify: `.github/workflows/ci.yml:9-93`
- Modify: `README.md:103-145`
- Modify: `CLAUDE.md:5-32,168-174`

**Interfaces:**
- Produces: self-contained `npm run test:smoke`.
- Produces: separate credential-free `smoke` CI job.
- Preserves: existing `test:unit`, `test:e2e`, artifact, and Docker job meanings.

- [ ] **Step 1: Add the local command and run it before CI/docs changes**

Add to `package.json`:

```json
"test:smoke": "npm run build && vitest run tests/smoke"
```

Run:

```bash
npm run test:smoke
```

Expected: mock contract, process harness, and four application scenarios PASS from one command, with no `.line-auth.json` read.

- [ ] **Step 2: Add the separate CI job**

Add to `.github/workflows/ci.yml`:

```yaml
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - name: Mock-backed LINE smoke tests
        run: npm run test:smoke
```

Update the workflow comments to state that this job runs both compiled targets against the local strict LINE mock and requires neither credentials nor Docker. Keep the note excluding live `test:e2e` from CI.

- [ ] **Step 3: Update operator and maintainer documentation**

Add `npm run test:smoke` to both command tables. Document these exact distinctions:

- `test:unit`: in-process unit/contract/migration tests.
- `test:smoke`: strict local LINE mock plus compiled composed and standalone CLIs, seeded and full OAuth paths, no credentials or Docker.
- `test:e2e`: manual live LINE account verification using `.line-auth.json`.
- Docker smoke: runtime-image startup and exact tool surfaces.

Update `CLAUDE.md`'s Tests section and CI description. Update `README.md`'s CI job count and smoke instructions. Add `LINE_API_BASE_URL` only as a test/development override; warn that production defaults to LINE and that a configured override receives LINE authorization headers.

- [ ] **Step 4: Run deterministic final gates**

Run:

```bash
npm run lint
npm run build
npm run test:unit
npm run test:smoke
npx vitest run tests/architecture/import-boundaries.test.ts
```

Expected: every command exits 0. Do not run `npm run test:e2e` without real credentials, and do not claim it passed.

- [ ] **Step 5: Inspect cleanup and repository state**

Run:

```bash
git status --short
git diff --check
```

Expected: only intended source, test, workflow, documentation, and plan changes are present; `git diff --check` emits no output. Verify no `packages/server/dist/cli.js`, `packages/line-mcp/dist/cli.js`, or mock process remains after `test:smoke`.

- [ ] **Step 6: Commit integration and documentation**

```bash
git add package.json .github/workflows/ci.yml README.md CLAUDE.md
git commit -m "ci: run mocked LINE smoke tests"
```

---

## Completion Checklist

- [ ] `LINE_API_BASE_URL` reaches both OAuth and request-scoped clients for both targets.
- [ ] The production default gateway and absolute image fetching remain unchanged.
- [ ] Mock requests validate exact method, headers, raw body, HMAC, auth, and state.
- [ ] Mock responses cover QR/PIN, certificate reuse, refresh, chats, contacts, pagination, profile, identity, and images.
- [ ] Expected negative probes cannot hide application-originated violations.
- [ ] Seeded composed and standalone scenarios rotate and persist LINE credentials.
- [ ] Full-auth composed and standalone scenarios prove PKCE, PIN, certificate reuse, MCP issuance, and MCP refresh.
- [ ] Composed smoke exercises all ten tools; standalone smoke exercises all five and proves bank surfaces absent.
- [ ] Every process and temporary root is cleaned on success and failure.
- [ ] `test:e2e` remains the unchanged manual live-account suite.
- [ ] Lint, build, unit, architecture, and mock smoke gates pass with fresh output.
