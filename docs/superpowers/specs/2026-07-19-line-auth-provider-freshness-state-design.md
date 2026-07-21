# LineAuthProvider freshness state: from process-global to instance-owned

**Issue:** [#79](https://github.com/raidenyn/line-mcp/issues/79) — follow-up to PR #77, same precedent as #78.

## Problem

`LineAuthProvider.resolveCredentials()` consults a **module-level, process-global**
`latestAuthData` map (`packages/line-mcp/src/auth/credential-store.ts`), keyed by
MID alone, before falling back to the injected `CredentialStore`. The public
factories `createServer` and `createStandaloneServer` support independent,
explicit `dataRoot`s, so two provider instances constructed in the same process
with the same MID but different `dataRoot`s can resolve the *other* root's
freshness snapshot from memory instead of their own store's. The
`CredentialStore` boundary (the intended per-root persistence seam) is honored
only on the cold-load path; the warm-cache shortcut bypasses it entirely.

## Chosen approach: provider-owned freshness (issue's Option 1)

`LineAuthProvider` gets a private instance field:

```ts
private readonly freshness = new Map<string, AuthData>();
```

replacing the module-global `latestAuthData` export in `credential-store.ts`.
`credential-store.ts` and `FileCredentialStore` become purely disk-backed — no
memory cache, no side effects on read. Two `LineAuthProvider` instances (two
data roots) now have two independent maps, closing the cross-root bleed for a
shared MID.

**Why provider-owned over store-owned (issue's Option 2):** the e2e
test-bypass path (`authenticate()`'s `testOverrides`, keyed by bearer token) is
inherently a provider/authentication concern — it primes a freshness snapshot
that was never persisted to disk and must never touch the filesystem. Keeping
freshness on the provider makes that a same-object write. Moving freshness
onto `CredentialStore` instead would force a choice between leaking a
test-bypass concern into the store's disk-backed interface, or keeping a
second, separate map on the provider anyway for just that case — undermining
the single-owner goal the issue is asking for. Option 3 (keying the existing
global map by store identity) is explicitly a stopgap in the issue and is not
pursued: the acceptance criteria require no module-level mutable map at all.

**Consolidation found along the way:** the oauth-router's post-login write to
the freshness map (today, `latestAuthData.set(...)` right after
`credentialStore.saveAtomic()` succeeds) turns out to be a pure optimization,
not a correctness requirement — the credential is already durably persisted by
that point. So rather than adding a second, differently-named callback to
`OAuthRouterDeps` for this case, the router reuses the provider's existing
`recordRefreshedAuth(authData)` method for both "mid-request LINE token
rotation" and "login just completed." This costs one redundant (harmless,
atomic) disk rewrite on login only, and keeps "the freshest known credential
for a MID" a single concept with a single name.

## Component changes

### `packages/line-mcp/src/auth/credential-store.ts`

- Delete the `latestAuthData` module-level map export entirely.
- `loadAuthFromDisk(mid, storeDir)` becomes a pure read: load →
  `authDataFromStoredRecord` → return. No more priming side effect.
- Delete the free function `recordRefreshedAuth(authData, storeDir)`. Its body
  (update-memory-then-swallow-persist-failure) moves to
  `LineAuthProvider.recordRefreshedAuth()`.
- `FileCredentialStore.load()` simplifies to call the now-pure
  `loadAuthFromDisk` with no priming comment needed.

### `packages/line-mcp/src/auth/line-auth-provider.ts`

- Add `private readonly freshness = new Map<string, AuthData>()`.
- Add a public method:

  ```ts
  recordRefreshedAuth(authData: AuthData): void {
    this.freshness.set(authData.mid, authData);
    try {
      persistAuthData(authData, undefined, this.options.authStoreDir);
    } catch {
      process.stderr.write(
        `[OAuth] Refreshed LINE auth for ${maskMid(authData.mid)} but could not persist it\n`,
      );
    }
  }
  ```

  (imports `persistAuthData` and `maskMid` from `./credential-store`, which
  already exposes both).

- `resolveCredentials()` and `issueFromRefresh()` currently duplicate the
  "check memory, else load from store" pattern against the module map. Fold
  this into one private helper both call — a small pre-existing duplication
  this move makes worth cleaning up:

  ```ts
  private async freshestCredential(mid: string): Promise<Readonly<AuthData> | null> {
    const cached = this.freshness.get(mid);
    if (cached) return cached;
    const loaded = await this.options.credentialStore.load(mid);
    if (loaded) this.freshness.set(mid, loaded);
    return loaded;
  }
  ```

- `authenticate()`'s e2e bypass and `issueTokens()` prime `this.freshness`
  directly instead of the module map, with the same "only if absent" guard
  they use today.

### `packages/line-mcp/src/auth/oauth-router.ts`

- `OAuthRouterDeps` gains `recordRefreshedAuth(authData: AuthData): void`,
  wired from `LineAuthProvider.mountRoutes()` as
  `(authData) => this.recordRefreshedAuth(authData)`.
- The `latestAuthData.set(authData.mid, authData)` call in `monitorLogin`
  becomes `deps.recordRefreshedAuth(authData)`.
- Drop the `latestAuthData` import.

### `packages/line-mcp/src/index.ts`

- Drop `latestAuthData` and `recordRefreshedAuth` from the re-export list
  (neither exists anymore). `loadAuthFromDisk` stays exported — it's still a
  real, now-pure function.

### Call sites: `standalone.ts`, `packages/server/src/server.ts` + `request-client.ts`

Both currently build `onAuthRefreshed: (fresh) => recordRefreshedAuth(fresh, authStoreDir)`.
Both switch to `onAuthRefreshed: (fresh) => authProvider.recordRefreshedAuth(fresh)`.

`packages/server/src/request-client.ts`'s `ServerRequestClientOptions.authStoreDir`
option is replaced with an `onAuthRefreshed` passthrough option (the wrapper
becomes a thin passthrough to `@raidenyn/line-mcp`'s `createRequestClientFactory`).
This file is **kept**, not deleted — deleting it would also require touching
its `index.ts` re-export and `test-support.ts`'s type import, which is scope
beyond this issue.

## Testing

### New test: cross-root isolation (unit level)

In `token-transition.test.ts` (which already has a `makeProvider(dir)`
helper): construct two `LineAuthProvider` instances with the same MID but
different `authStoreDir`s, call `recordRefreshedAuth` on one, and assert
`resolveCredentials` on the other does not see it. This directly proves the
issue's acceptance criterion.

### New test: cross-root isolation (smoke level)

`tests/smoke/auth-cross-root-isolation.test.ts` — constructs **two
`createServer` instances (from `@raidenyn/server`) in the same test process**
(this in-process condition is what triggers the bug; two separate CLI
subprocesses would not, since each process gets its own module-global map
regardless of the fix). Each server gets its own temp `dataRoot` and both
point at one shared mock LINE server. Both are seeded via `testAuth` with the
**same MID but different `accessToken`s** (`access-A` / `access-B`) — no real
login/OAuth flow needed. Each server is driven through a real MCP connection
using its own bearer test token, calling `list_chats` (which forces an
outbound LINE API call carrying the `x-line-access` header). The mock LINE
server records which access token arrived per request; the test asserts
server A's calls always carry `access-A` and server B's always carry
`access-B`.

This test is written and confirmed to **fail against current `main`** first
(proving it reproduces the bug as a user would hit it), then confirmed to pass
once the fix lands — both states captured in the same PR. It runs under the
existing `npm run test:smoke` gate; no new script needed.

### Existing test updates (the four files the issue names)

- **`credential-store.test.ts`**: drop the `recordRefreshedAuth` describe
  block (behavior moved out of this module). The "strips selector metadata"
  test for `loadAuthFromDisk` keeps checking the stripped shape but drops the
  `latestAuthData` assertion. The "does not populate latestAuthData during
  enumeration" test is removed — nothing in this module populates any cache
  now.
- **`line-auth-provider.test.ts`**: remove `latestAuthData.clear()` from
  `beforeEach`/`afterEach` (a fresh provider per test already has an empty
  `freshness` map). "Prefers the in-memory freshest snapshot over disk"
  switches from `latestAuthData.set(...)` to `provider.recordRefreshedAuth(fresher)`
  before asserting via `resolveCredentials`.
- **`oauth-router.test.ts`**: drop the `latestAuthData` import and clears.
  "Does not issue a code or update memory when durable persistence fails"
  asserts through the injected `recordRefreshedAuth` spy (a `vi.fn()` in this
  file's `OAuthRouterDeps` test harness) never being called, instead of
  inspecting a shared map.
- **`token-transition.test.ts`**: each `recordRefreshedAuth(data, dir)`
  free-function call becomes `provider.recordRefreshedAuth(data)` on a
  constructed provider; assertions move from reading the map directly to
  calling `provider.resolveCredentials(...)` and checking the returned
  `AuthData`. Also the home for the new unit-level isolation test above.

### Unaffected

`sync.ts` and the `CredentialStore` interface are untouched — `sync.ts` only
calls `credentialStore.list()`, never the freshness path.

## Acceptance criteria (from the issue, unchanged)

- Two `LineAuthProvider` instances in one process with the same MID but
  different `dataRoot`s never resolve each other's `AuthData`.
- No module-level mutable map; freshness state is owned by the provider.
- All four affected test files updated; no test reads/writes a
  process-global `latestAuthData` map.
- `npm run test:unit`, `npm run build`, `npm run lint` clean, plus
  `npm run test:smoke` clean (new isolation smoke test included).

## Pre-PR gate

`npm run lint && npm run build && npm run test:unit && npm run test:smoke`.
No `Dockerfile`/`docker-compose.yml` or line-client packaging changes here, so
the Docker and artifact-pack smoke suites are not required.
