# Data Directory Reorganization Design

**Date:** 2026-06-23
**Status:** Approved

## Problem

File storage is scattered and inconsistent:

| Artifact | Current path | Issues |
|---|---|---|
| Signing key | `.line-mcp-secret` (cwd or `DATA_DIR`) | Hidden file, `line-` prefix |
| Auth credentials | `auth/<mid>.json` (cwd or `DATA_DIR`) | Correct, but not under a `data/` subfolder locally |
| Templates | `.line-templates/<chatMid>.json` (always cwd) | Hidden, `line-` prefix, **ignores `DATA_DIR`** |
| Message cache | `.line-cache/messages.db` (always cwd) | Hidden, `line-` prefix, **ignores `DATA_DIR`** |

## Goals

- All runtime artifacts live under a single `data/` directory
- No hidden folders (no leading `.`)
- No `line-` prefix in file/folder names
- All locations respect the `DATA_DIR` environment variable
- Docker setup unchanged (named volume `line-mcp-data:/data`, `ENV DATA_DIR=/data`)

## New Directory Layout

```
data/
  secret                   # signing key (was .line-mcp-secret)
  auth/
    <mid>.json             # LINE credentials (format unchanged)
  templates/
    <chatMid>.json         # regex templates (was .line-templates/)
  cache/
    messages.db            # SQLite message cache (was .line-cache/)
```

Locally `data/` lives in the project root and is gitignored. In Docker, `DATA_DIR=/data` maps to the `line-mcp-data` named volume.

## Architecture

### New module: `src/data-dir.ts`

Single source of truth for all data paths:

```typescript
import * as path from 'path';

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

export const secretPath   = (): string => path.join(dataDir(), 'secret');
export const authDir      = (): string => path.join(dataDir(), 'auth');
export const templatesDir = (): string => path.join(dataDir(), 'templates');
export const cacheDbPath  = (): string => path.join(dataDir(), 'cache', 'messages.db');
```

All functions are lazy (called at runtime, not module load) so tests can set `DATA_DIR` before the first call.

### Changes per file

**`src/oauth.ts`**
- `loadOrCreateSecret()`: replace hardcoded `path.join(DATA_DIR ?? cwd(), '.line-mcp-secret')` with `secretPath()`
- `persistAuthData()` / `loadAuthFromDisk()`: replace `path.resolve(baseDir, 'auth')` with `authDir()`

**`src/template-store.ts`**
- `DEFAULT_STORE_DIR`: replace `path.join(process.cwd(), '.line-templates')` with `templatesDir()`
- All other code unchanged (already accepts optional `storeDir` param for tests)

**`src/index.ts`**
- `new MessageCache('.line-cache/messages.db')` → `new MessageCache(cacheDbPath())`
- Update tool description strings that mention `.line-templates/<chatMid>.json`

**`src/sync.ts`**
- Already reads `authDir` from `oauth.ts` — picks up the change automatically, no edit needed

**`.gitignore`**
- Add `data/`
- Remove `.line-mcp-secret`, `auth/`, `.line-templates/`, `.line-cache/`

**`docker-compose.yml`** — no change (already has `line-mcp-data:/data`)

**`Dockerfile`** — no change (already has `ENV DATA_DIR=/data`)

## Migration

No automatic migration. After deploying:
1. `mkdir -p data/auth data/templates data/cache`
2. `cp .line-mcp-secret data/secret`
3. `cp auth/*.json data/auth/`
4. `cp .line-templates/*.json data/templates/`
5. `cp .line-cache/messages.db data/cache/`

## Testing

- **Unit tests** (`npm run test:unit`): `template-store.test.ts` uses explicit `storeDir`; `message-cache.test.ts` uses `:memory:` — both isolated, no changes needed.
- **`data-dir.ts`**: pure path composition, no dedicated test.
- **Smoke test**: start server locally, verify `data/secret` and `data/cache/messages.db` are created on first run.
- **e2e tests** (`npm run test:e2e`): seed token path unchanged — run to confirm server still starts.
