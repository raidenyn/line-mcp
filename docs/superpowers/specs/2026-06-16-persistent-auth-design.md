# Persistent Authentication Design

**Date:** 2026-06-16
**Topic:** Make LINE MCP server authentication survive server restarts using disk-persisted credentials

---

## Problem

MCP access tokens expire after 24 hours. Claude Code silently renews them via the MCP `refresh_token` grant, so re-authentication should never be required as long as the underlying LINE session is alive. However, this breaks in practice because:

- `latestAuthData` — the in-memory map of the freshest LINE credentials per user — is lost on server restart.
- When LINE tokens are rotated mid-session by `refreshIfExpired()`, the updated credentials are stored only in `latestAuthData`. After a restart, `issueTokens` falls back to the stale credentials embedded in the MCP refresh_token payload.
- If the LINE refresh token has rotated, the next LINE API call fails and the user must re-scan the QR code.

## Goal

LINE credentials must survive server restarts. Once a user authenticates, they should never need to re-authenticate as long as their LINE session is alive (LINE refresh token still valid).

## Non-Goals

- Encrypting stored credentials (filesystem access control is sufficient).
- MCP refresh token TTL (refresh tokens remain valid indefinitely, tied to LINE session lifetime).
- Changing the QR login or MCP OAuth flow in any other way.

---

## Design

### Storage format

Each LINE account's credentials are stored as:

```
DATA_DIR/auth/{mid}.json
```

The file contains the full `AuthData` object (plain JSON), identical in shape to the existing `.line-auth.json`:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "certificate": "...",
  "mid": "u...",
  "wrappedNonce": "...",
  "kdfParameter1": "...",
  "kdfParameter2": "..."
}
```

`DATA_DIR` defaults to `process.cwd()` and is set to `/data` in the Docker image — the same directory used for `.line-mcp-secret`.

One file per user. Multiple users are fully supported.

---

### Write paths

Credentials are written to disk in exactly two places, both in `oauth.ts` / `index.ts`:

**1. Initial login — `oauth.ts` `monitorLogin`**

After `authData` is obtained from `lineClient.getCompletedAuth()`, call `persistAuthData(authData)`. This replaces the existing `.line-auth.json` write.

**2. LINE token refresh — `index.ts` `makeLineClient`**

The `onTokenRefreshed` callback currently only calls `latestAuthData.set(authData.mid, authData)`. It will also call `persistAuthData(authData)` so rotated LINE tokens are immediately flushed to disk.

`persistAuthData(authData: AuthData): void` is defined and exported from `oauth.ts`:

```typescript
export function persistAuthData(authData: AuthData): void {
  const dir = path.join(process.env.DATA_DIR ?? process.cwd(), 'auth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${authData.mid}.json`), JSON.stringify(authData, null, 2));
}
```

Write errors are caught and logged as warnings — non-fatal. The in-memory map is always updated first.

---

### Read path (lazy loading)

No startup scan. Credentials are loaded from disk on the first access for a given `mid`, only when `latestAuthData.get(mid)` returns `undefined`.

`loadAuthFromDisk(mid: string): AuthData | null` in `oauth.ts`:

```typescript
function loadAuthFromDisk(mid: string): AuthData | null {
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

This is called in two places:

**`validateBearerToken`** — after verifying the MCP token signature, before the final credential lookup:

```typescript
// before:
return latestAuthData.get(payload.authData.mid) ?? payload.authData;

// after:
const mid = payload.authData.mid;
return latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? payload.authData;
```

**`issueTokens`** — same pattern, when deciding which LINE credentials to embed in the new MCP token:

```typescript
// before:
const freshAuth = latestAuthData.get(authData.mid) ?? authData;

// after:
const mid = authData.mid;
const freshAuth = latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? authData;
```

Once loaded, the `mid` entry stays in `latestAuthData` for the server lifetime — disk is only read once per mid per process.

---

### Error handling

| Scenario | Behaviour |
|---|---|
| `auth/{mid}.json` missing | `loadAuthFromDisk` returns `null`; falls back to embedded `authData` in MCP token |
| `auth/{mid}.json` corrupt / parse error | Same — caught by try/catch, returns `null` |
| `persistAuthData` write failure | Caught, logged as warning; in-memory map still updated; current session unaffected |
| `auth/` directory missing | `mkdirSync({ recursive: true })` creates it on first write |

---

### e2e tests

No changes needed. Tests use `seedTestToken` / `TEST_TOKEN` to bypass the full auth flow. The removed `.line-auth.json` write has no effect on tests.

---

## Files changed

| File | Change |
|---|---|
| `src/oauth.ts` | Add `persistAuthData` (exported), `loadAuthFromDisk` (internal); update `validateBearerToken` and `issueTokens` to call `loadAuthFromDisk`; update `monitorLogin` to call `persistAuthData` instead of writing `.line-auth.json` |
| `src/index.ts` | Import `persistAuthData`; update `makeLineClient` callback to also call `persistAuthData(authData)` |
