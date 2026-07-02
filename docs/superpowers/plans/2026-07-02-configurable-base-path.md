# Configurable Base Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LINE MCP server run under a configurable URL prefix (`BASE_PATH` env var), defaulting to root `/` so existing deployments are unaffected.

**Architecture:** A pure `normalizeBasePath()` helper collapses `BASE_PATH` into either `''` (root) or a clean `/prefix` string. `index.ts` and `oauth.ts` prefix every route path with it, and fold it into every absolute URL they construct (OAuth metadata, `WWW-Authenticate`, upload URLs, startup logs). The two `/.well-known/*` OAuth discovery routes are a special case: the prefix is appended *after* the well-known segment (RFC 8414 / MCP auth spec placement), not prepended like other routes.

**Tech Stack:** TypeScript, Express 5, Vitest.

## Global Constraints

- `BASE_PATH` unset, `''`, or `'/'` must produce byte-identical routing/URLs to the current (pre-change) behavior — this is the existing default and must not regress.
- Well-known OAuth discovery paths are suffixed (`/.well-known/oauth-authorization-server<basePath>`), never prefixed like the other routes.
- `Dockerfile` and `docker-compose.yml` must explicitly set `BASE_PATH=/`.
- Follow existing test style: `src/oauth.test.ts` boots a real `http.Server` + `express()` app and hits it with `fetch`; new tests should match that pattern, not introduce a new one.

---

### Task 1: `normalizeBasePath` helper

**Files:**
- Create: `src/base-path.ts`
- Test: `src/base-path.test.ts`

**Interfaces:**
- Produces: `normalizeBasePath(raw: string | undefined): string` — used by `src/index.ts` (Task 4) to compute `basePath` once in `main()`, and indirectly exercised by `src/oauth.ts` (Task 2/3) via the `basePath` parameter it accepts.

`index.ts` cannot be unit-tested directly (it calls `main()` unconditionally at module load, which binds a real port and touches SQLite/LINE auth), so this helper lives in its own file purely so it's testable in isolation.

- [ ] **Step 1: Write the failing test**

Create `src/base-path.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeBasePath } from './base-path';

describe('normalizeBasePath', () => {
  it('returns empty string for undefined', () => {
    expect(normalizeBasePath(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(normalizeBasePath('')).toBe('');
  });

  it('returns empty string for root slash', () => {
    expect(normalizeBasePath('/')).toBe('');
  });

  it('strips a single trailing slash', () => {
    expect(normalizeBasePath('/line-mcp/')).toBe('/line-mcp');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeBasePath('/line-mcp///')).toBe('/line-mcp');
  });

  it('adds a leading slash when missing', () => {
    expect(normalizeBasePath('line-mcp')).toBe('/line-mcp');
  });

  it('preserves a nested path', () => {
    expect(normalizeBasePath('/tools/line-mcp')).toBe('/tools/line-mcp');
  });

  it('leaves an already-normalized path unchanged', () => {
    expect(normalizeBasePath('/line-mcp')).toBe('/line-mcp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/base-path.test.ts`
Expected: FAIL — `Cannot find module './base-path'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/base-path.ts`:

```typescript
export function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/base-path.test.ts`
Expected: PASS — 8/8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/base-path.ts src/base-path.test.ts
git commit -m "feat: add normalizeBasePath helper"
```

---

### Task 2: Thread `basePath` through `src/oauth.ts`

**Files:**
- Modify: `src/oauth.ts`

**Interfaces:**
- Consumes: nothing new (no import changes).
- Produces: `setupOAuthRoutes(app: Express, port: number, basePath: string): void` (was `(app, port)`), `makeWwwAuthenticate(port: number, basePath: string): string` (was `(port)`). Both new params are consumed by `src/index.ts` (Task 4) and `src/oauth.test.ts` (Task 3).

This task changes route registration and every self-referential URL the OAuth layer builds. There's no new test here — Task 3 updates the existing test file to match (test-first isn't practical for a signature-wide rename; the existing suite is the regression net, and Task 3 extends it before/after this change would both be red for unrelated reasons, so we do the implementation then fix+extend the suite in one pass).

- [ ] **Step 1: Change `setupOAuthRoutes` signature and the `base` URL to include `basePath`**

In `src/oauth.ts`, find:

```typescript
export function setupOAuthRoutes(app: Express, port: number): void {
  const base = `http://localhost:${port}`;

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['line'],
    });
  });

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  // RFC 7591 Dynamic Client Registration
  app.post('/register', (req: Request, res: Response) => {
```

Replace with:

```typescript
export function setupOAuthRoutes(app: Express, port: number, basePath: string): void {
  const base = `http://localhost:${port}${basePath}`;

  app.get(`/.well-known/oauth-protected-resource${basePath}`, (_req: Request, res: Response) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['line'],
    });
  });

  app.get(`/.well-known/oauth-authorization-server${basePath}`, (_req: Request, res: Response) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  // RFC 7591 Dynamic Client Registration
  app.post(`${basePath}/register`, (req: Request, res: Response) => {
```

Note `base` now already embeds `basePath`, so `${base}/mcp`, `${base}/authorize` etc. are correct without further edits — only the `app.get`/`app.post` **path** arguments (first argument, not the JSON body) need `basePath` prepended, since those are matched against the incoming request path, not built from `base`.

- [ ] **Step 2: Prefix the `/authorize` route**

Find:

```typescript
  app.get('/authorize', async (req: Request, res: Response) => {
```

Replace with:

```typescript
  app.get(`${basePath}/authorize`, async (req: Request, res: Response) => {
```

- [ ] **Step 3: Pass `basePath` into the authorize page's poll script**

The authorize page's client-side JS does `fetch('/authorize/poll?sid=...')` — an absolute path that resolves against the origin root, bypassing any prefix. It must be told the prefix explicitly.

Find:

```typescript
function authorizePageHtml(qrDataUrl: string, sid: string, state: string, redirectUri: string): string {
```

Replace with:

```typescript
function authorizePageHtml(qrDataUrl: string, sid: string, state: string, redirectUri: string, basePath: string): string {
```

Find (inside the `<script>` block):

```typescript
const sid = ${JSON.stringify(sid)};
const state = ${JSON.stringify(state)};
const redirectUri = ${JSON.stringify(redirectUri)};
const status = document.getElementById('status');
```

Replace with:

```typescript
const sid = ${JSON.stringify(sid)};
const state = ${JSON.stringify(state)};
const redirectUri = ${JSON.stringify(redirectUri)};
const basePath = ${JSON.stringify(basePath)};
const status = document.getElementById('status');
```

Find:

```typescript
    const res = await fetch('/authorize/poll?sid=' + encodeURIComponent(sid));
```

Replace with:

```typescript
    const res = await fetch(basePath + '/authorize/poll?sid=' + encodeURIComponent(sid));
```

Find the call site:

```typescript
      res.setHeader('Content-Type', 'text/html');
      res.send(authorizePageHtml(qrDataUrl, sid, state ?? '', redirect_uri));
```

Replace with:

```typescript
      res.setHeader('Content-Type', 'text/html');
      res.send(authorizePageHtml(qrDataUrl, sid, state ?? '', redirect_uri, basePath));
```

- [ ] **Step 4: Prefix the `/authorize/poll` route**

Find:

```typescript
  app.get('/authorize/poll', (req: Request, res: Response) => {
```

Replace with:

```typescript
  app.get(`${basePath}/authorize/poll`, (req: Request, res: Response) => {
```

- [ ] **Step 5: Prefix the `/token` route**

Find:

```typescript
  app.post('/token', (req: Request, res: Response) => {
```

Replace with:

```typescript
  app.post(`${basePath}/token`, (req: Request, res: Response) => {
```

- [ ] **Step 6: Prefix the `/import-upload` route**

Find:

```typescript
  app.post(
    '/import-upload',
    express.raw({ type: '*/*', limit: '10mb' }),
    (req: Request, res: Response) => {
```

Replace with:

```typescript
  app.post(
    `${basePath}/import-upload`,
    express.raw({ type: '*/*', limit: '10mb' }),
    (req: Request, res: Response) => {
```

- [ ] **Step 7: Update `makeWwwAuthenticate`**

Find:

```typescript
export function makeWwwAuthenticate(port: number): string {
  return `Bearer error="invalid_token", resource_metadata="http://localhost:${port}/.well-known/oauth-protected-resource"`;
}
```

Replace with:

```typescript
export function makeWwwAuthenticate(port: number, basePath: string): string {
  return `Bearer error="invalid_token", resource_metadata="http://localhost:${port}/.well-known/oauth-protected-resource${basePath}"`;
}
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in `src/oauth.test.ts` and `src/index.ts` only (calls to `setupOAuthRoutes`/`makeWwwAuthenticate` with the old 2-arg signature) — no errors inside `src/oauth.ts` itself. These call sites are fixed in Task 3 and Task 4.

- [ ] **Step 9: Commit**

```bash
git add src/oauth.ts
git commit -m "feat: thread basePath through OAuth routes and metadata"
```

---

### Task 3: Update and extend `src/oauth.test.ts`

**Files:**
- Modify: `src/oauth.test.ts`

**Interfaces:**
- Consumes: `setupOAuthRoutes(app, port, basePath)`, `makeWwwAuthenticate(port, basePath)` from Task 2.

This task both fixes the existing suite (which calls the old signatures) and adds coverage for non-root `basePath` behavior, since this is the primary place OAuth route/metadata correctness is exercised.

- [ ] **Step 1: Fix the existing root-basePath call sites**

Find (in the `beforeAll` block):

```typescript
      setupOAuthRoutes(app, addr.port);
```

Replace with:

```typescript
      setupOAuthRoutes(app, addr.port, '');
```

Find:

```typescript
describe('makeWwwAuthenticate', () => {
  it('includes port and resource_metadata URL', () => {
    const header = makeWwwAuthenticate(3001);
    expect(header).toContain('Bearer error="invalid_token"');
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource');
  });
});
```

Replace with:

```typescript
describe('makeWwwAuthenticate', () => {
  it('includes port and resource_metadata URL', () => {
    const header = makeWwwAuthenticate(3001, '');
    expect(header).toContain('Bearer error="invalid_token"');
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource');
  });

  it('appends basePath after the well-known segment, not before', () => {
    const header = makeWwwAuthenticate(3001, '/line-mcp');
    expect(header).toContain('http://localhost:3001/.well-known/oauth-protected-resource/line-mcp');
    expect(header).not.toContain('/line-mcp/.well-known');
  });
});
```

- [ ] **Step 2: Run the existing suite to confirm the root-basePath fix works**

Run: `npx vitest run src/oauth.test.ts`
Expected: All previously-passing tests PASS again (they were red after Task 2 until this fix).

- [ ] **Step 3: Add a second server instance mounted under a non-root basePath**

Find the test lifecycle block:

```typescript
let server: http.Server;
let base: string;
```

Replace with:

```typescript
let server: http.Server;
let base: string;
let server2: http.Server;
let base2: string;
const BASE_PATH_2 = '/line-mcp';
```

Find:

```typescript
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      setupOAuthRoutes(app, addr.port, '');
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
```

Replace with:

```typescript
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      setupOAuthRoutes(app, addr.port, '');
      resolve();
    });
  });

  const app2 = express();
  app2.use(express.json());
  app2.use(express.urlencoded({ extended: false }));

  await new Promise<void>((resolve) => {
    server2 = http.createServer(app2);
    server2.listen(0, '127.0.0.1', () => {
      const addr = server2.address() as { port: number };
      base2 = `http://127.0.0.1:${addr.port}`;
      setupOAuthRoutes(app2, addr.port, BASE_PATH_2);
      resolve();
    });
  });
});

afterAll(() => Promise.all([
  new Promise<void>((resolve) => server.close(() => resolve())),
  new Promise<void>((resolve) => server2.close(() => resolve())),
]));
```

- [ ] **Step 4: Add a describe block for non-root basePath behavior**

Add at the end of the file (after the last `describe` block):

```typescript
// ───────────────────────────────────────────────────────────
// Non-root basePath ('/line-mcp')
// ───────────────────────────────────────────────────────────

describe('non-root basePath', () => {
  it('serves protected-resource metadata at the well-known suffix location', async () => {
    const { status, body } = await req(`${base2}/.well-known/oauth-protected-resource${BASE_PATH_2}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.resource).toBe(`${base2}${BASE_PATH_2}/mcp`);
    expect(b.authorization_servers).toEqual([`${base2}${BASE_PATH_2}`]);
  });

  it('does not serve protected-resource metadata at the unprefixed well-known location', async () => {
    const { status } = await req(`${base2}/.well-known/oauth-protected-resource`);
    expect(status).toBe(404);
  });

  it('serves AS metadata at the well-known suffix location with prefixed endpoints', async () => {
    const { status, body } = await req(`${base2}/.well-known/oauth-authorization-server${BASE_PATH_2}`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b.issuer).toBe(`${base2}${BASE_PATH_2}`);
    expect(b.authorization_endpoint).toBe(`${base2}${BASE_PATH_2}/authorize`);
    expect(b.token_endpoint).toBe(`${base2}${BASE_PATH_2}/token`);
    expect(b.registration_endpoint).toBe(`${base2}${BASE_PATH_2}/register`);
  });

  it('does not mount routes at the unprefixed AS well-known location', async () => {
    const { status } = await req(`${base2}/.well-known/oauth-authorization-server`);
    expect(status).toBe(404);
  });

  it('serves /authorize under the prefix, not at root', async () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'claude-code',
      redirect_uri: 'http://localhost:8765/callback',
      code_challenge: s256('verifier123'),
      code_challenge_method: 'S256',
      state: 'st',
    });
    const prefixed = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
    expect(prefixed.status).not.toBe(400);

    const unprefixed = await req(`${base2}/authorize?${params}`);
    expect(unprefixed.status).toBe(404);
  });

  it('embeds the basePath in the authorize page poll script', async () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'claude-code',
      redirect_uri: 'http://localhost:8765/callback',
      code_challenge: s256('verifier123'),
      code_challenge_method: 'S256',
      state: 'st',
    });
    const { body: html } = await req(`${base2}${BASE_PATH_2}/authorize?${params}`);
    expect(html as string).toContain(`const basePath = ${JSON.stringify(BASE_PATH_2)};`);
    expect(html as string).toContain(`fetch(basePath + '/authorize/poll?sid='`);
  });

  it('serves /token under the prefix, not at root', async () => {
    const prefixed = await req(`${base2}${BASE_PATH_2}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'implicit' }),
    });
    expect(prefixed.status).toBe(400); // reaches the handler, rejected for bad grant_type

    const unprefixed = await req(`${base2}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'implicit' }),
    });
    expect(unprefixed.status).toBe(404); // route doesn't exist at root
  });
});
```

- [ ] **Step 5: Run the full oauth test suite**

Run: `npx vitest run src/oauth.test.ts`
Expected: PASS — all existing tests plus the new `non-root basePath` describe block (7 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/oauth.test.ts
git commit -m "test: cover non-root basePath in OAuth route/metadata tests"
```

---

### Task 4: Thread `basePath` through `src/index.ts` and `src/index.html`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.html`

**Interfaces:**
- Consumes: `normalizeBasePath` from `src/base-path.ts` (Task 1); `setupOAuthRoutes(app, port, basePath)` and `makeWwwAuthenticate(port, basePath)` from `src/oauth.ts` (Task 2).

No new automated test here — `index.ts` runs `main()` at import time (binds a real port, opens SQLite, etc.) so it isn't unit-testable in isolation, and there's no existing precedent for testing it that way in this codebase. Task 5 covers this with a manual verification pass plus the existing e2e suite (which exercises the default root-basePath path end-to-end already).

- [ ] **Step 1: Import `normalizeBasePath`**

Find:

```typescript
import { cacheDbPath } from './data-dir';
import fs from 'fs';
```

Replace with:

```typescript
import { cacheDbPath } from './data-dir';
import { normalizeBasePath } from './base-path';
import fs from 'fs';
```

- [ ] **Step 2: Compute `basePath` in `main()` and prefix the `/` and `/mcp` routes**

Find:

```typescript
async function main() {
  // Two separate connections to the same SQLite file — safe since each touches a disjoint table
  // (messages vs categories) and better-sqlite3 is synchronous, so writes never overlap.
  sharedCache = new MessageCache(cacheDbPath());
  categoryStore = new CategoryStore(cacheDbPath());
  startSyncLoop(sharedCache);
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  const WWW_AUTH = makeWwwAuthenticate(PORT);
  seedTestToken();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  setupOAuthRoutes(app, PORT);

  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  app.post('/mcp', async (req, res) => {
```

Replace with:

```typescript
async function main() {
  // Two separate connections to the same SQLite file — safe since each touches a disjoint table
  // (messages vs categories) and better-sqlite3 is synchronous, so writes never overlap.
  sharedCache = new MessageCache(cacheDbPath());
  categoryStore = new CategoryStore(cacheDbPath());
  startSyncLoop(sharedCache);
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  const basePath = normalizeBasePath(process.env.BASE_PATH);
  const WWW_AUTH = makeWwwAuthenticate(PORT, basePath);
  seedTestToken();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  setupOAuthRoutes(app, PORT, basePath);

  app.get(`${basePath}/`, (_req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  app.post(`${basePath}/mcp`, async (req, res) => {
```

- [ ] **Step 3: Prefix the `GET /mcp` 405 route and the startup log lines**

Find:

```typescript
  app.get('/mcp', (_req, res) => {
    res.status(405).send('Use POST /mcp');
  });

  app.listen(PORT, '0.0.0.0', () => {
    process.stderr.write(`LINE MCP server listening on http://localhost:${PORT}/mcp\n`);
    process.stderr.write(`Add to Claude Code: claude mcp add --transport http --scope user line http://localhost:${PORT}/mcp\n`);
  });
```

Replace with:

```typescript
  app.get(`${basePath}/mcp`, (_req, res) => {
    res.status(405).send('Use POST /mcp');
  });

  app.listen(PORT, '0.0.0.0', () => {
    process.stderr.write(`LINE MCP server listening on http://localhost:${PORT}${basePath}/mcp\n`);
    process.stderr.write(`Add to Claude Code: claude mcp add --transport http --scope user line http://localhost:${PORT}${basePath}/mcp\n`);
  });
```

- [ ] **Step 4: Prefix the `initiate_import` upload URL**

Find:

```typescript
    const token = crypto.randomUUID();
    pendingUploads.set(token, { mid: authData.mid, expires: Date.now() + 900_000 }); // 15 min
    const base = process.env['PUBLIC_URL']?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${base}/import-upload?token=${token}`;
```

Replace with:

```typescript
    const token = crypto.randomUUID();
    pendingUploads.set(token, { mid: authData.mid, expires: Date.now() + 900_000 }); // 15 min
    const base = process.env['PUBLIC_URL']?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${base}${normalizeBasePath(process.env.BASE_PATH)}/import-upload?token=${token}`;
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Update `src/index.html` to compute the MCP URL and well-known link from the current path**

The landing page is served as a static file (`res.sendFile`), so `basePath` can't be injected server-side — it's derived client-side from `window.location.pathname` instead.

Find:

```html
<footer>
  OAuth 2.0 metadata: <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>
</footer>
```

Replace with:

```html
<footer>
  OAuth 2.0 metadata: <a id="wellknown-link" href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>
</footer>
```

Find:

```javascript
<script>
(function () {
  var mcpUrl = window.location.origin + '/mcp';

  document.getElementById('endpoint-display').textContent = mcpUrl;
  document.getElementById('cc-cmd').textContent =
    'claude mcp add --transport http --scope user line ' + mcpUrl;

  var lmsCfg = document.getElementById('lms-cfg');
  lmsCfg.textContent = JSON.stringify({ name: 'line', transport: 'http', url: mcpUrl }, null, 2);

  document.getElementById('generic-url').textContent = mcpUrl;

  document.querySelectorAll('.copy-btn').forEach(function (btn) {
```

Replace with:

```javascript
<script>
(function () {
  var basePath = window.location.pathname.replace(/\/$/, '');
  var mcpUrl = window.location.origin + basePath + '/mcp';

  document.getElementById('endpoint-display').textContent = mcpUrl;
  document.getElementById('cc-cmd').textContent =
    'claude mcp add --transport http --scope user line ' + mcpUrl;

  var lmsCfg = document.getElementById('lms-cfg');
  lmsCfg.textContent = JSON.stringify({ name: 'line', transport: 'http', url: mcpUrl }, null, 2);

  document.getElementById('generic-url').textContent = mcpUrl;

  var wellKnownPath = '/.well-known/oauth-authorization-server' + basePath;
  var wellKnownLink = document.getElementById('wellknown-link');
  wellKnownLink.textContent = wellKnownPath;
  wellKnownLink.href = wellKnownPath;

  document.querySelectorAll('.copy-btn').forEach(function (btn) {
```

Note the well-known link is *suffixed* with `basePath` (matching the spec-compliant discovery placement from Task 2), while `mcpUrl` is *prefixed* — these are deliberately different concatenation orders.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/index.html
git commit -m "feat: apply basePath to index.ts routes, upload URLs, and landing page"
```

---

### Task 5: Docker files, docs, and end-to-end verification

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the running server built from Tasks 1–4.

- [ ] **Step 1: Add `BASE_PATH` to `Dockerfile`**

Find:

```dockerfile
ENV PORT=3000
ENV DATA_DIR=/data
```

Replace with:

```dockerfile
ENV PORT=3000
ENV DATA_DIR=/data
ENV BASE_PATH=/
```

- [ ] **Step 2: Add `BASE_PATH` to `docker-compose.yml`**

Find:

```yaml
services:
  line-mcp:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - line-mcp-data:/data
```

Replace with:

```yaml
services:
  line-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - BASE_PATH=/
    volumes:
      - line-mcp-data:/data
```

- [ ] **Step 3: Document `BASE_PATH` in README.md**

Find:

```markdown
### Docker (recommended)

```bash
docker compose up -d
claude mcp add --transport http --scope user line http://localhost:3000/mcp
```

Call any LINE tool in Claude — the OAuth flow will trigger automatically on first use.
```

Replace with:

```markdown
### Docker (recommended)

```bash
docker compose up -d
claude mcp add --transport http --scope user line http://localhost:3000/mcp
```

Call any LINE tool in Claude — the OAuth flow will trigger automatically on first use.

To run behind a reverse proxy under a URL prefix instead of at the domain root, set `BASE_PATH` (e.g. `BASE_PATH=/line-mcp` in `docker-compose.yml`) and include the same prefix in the `claude mcp add` URL (`http://localhost:3000/line-mcp/mcp`).
```

- [ ] **Step 4: Document `BASE_PATH` in CLAUDE.md**

Find:

```markdown
**Transport**: Streamable HTTP on `http://localhost:PORT` (default port 3000). Claude Code adds the server as an HTTP MCP connector.
```

Replace with:

```markdown
**Transport**: Streamable HTTP on `http://localhost:PORT` (default port 3000). Claude Code adds the server as an HTTP MCP connector. All routes are mounted under `BASE_PATH` (default `/`, normalized via `normalizeBasePath()` in `base-path.ts`) — the OAuth discovery routes (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) are the one exception, where `BASE_PATH` is appended *after* the well-known segment per RFC 8414 rather than prepended.
```

- [ ] **Step 5: Run the full unit test suite**

Run: `npm run test:unit`
Expected: All tests PASS, including the new `base-path.test.ts` and the extended `oauth.test.ts`.

- [ ] **Step 6: Build and manually verify root behavior (default) is unchanged**

Run:

```bash
npm run build
PORT=3999 node dist/index.js &
sleep 1
curl -s http://localhost:3999/.well-known/oauth-authorization-server | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3999/mcp
kill %1
```

Expected: The well-known response contains `"issuer":"http://localhost:3999"` (no trailing path), and the `/mcp` GET returns `405` (matches the existing `Use POST /mcp` behavior).

- [ ] **Step 7: Manually verify non-root `BASE_PATH` behavior**

Run:

```bash
PORT=3999 BASE_PATH=/line-mcp node dist/index.js &
sleep 1
curl -s http://localhost:3999/.well-known/oauth-authorization-server/line-mcp | head -c 300
echo
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3999/.well-known/oauth-authorization-server
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3999/line-mcp/mcp
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3999/mcp
kill %1
```

Expected: First `curl` returns AS metadata with `"issuer":"http://localhost:3999/line-mcp"` and endpoints under `/line-mcp/...`; the unprefixed well-known request returns `404`; `GET /line-mcp/mcp` returns `405` (reaches the route); `GET /mcp` (unprefixed) returns `404` (route doesn't exist there anymore).

- [ ] **Step 8: Run the e2e suite to confirm no regression on the default path**

Requires `.line-auth.json` to exist (per `CLAUDE.md`) — skip this step with a note if not available in the current environment, otherwise run:

Run: `npm run test:e2e`
Expected: PASS — the harness doesn't set `BASE_PATH`, so it exercises the default-root code path exactly as before this change.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile docker-compose.yml README.md CLAUDE.md
git commit -m "docs: document BASE_PATH and set explicit default in Docker files"
```
