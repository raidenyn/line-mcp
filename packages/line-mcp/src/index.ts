// Public entry point for @raidenyn/line-mcp.
//
// Importing this module has no side effects: no filesystem reads, no timers,
// no sockets, and — critically — it never reads or creates `data/secret`. The
// HMAC signing secret is injected into `LineAuthProvider` by the executable
// that constructs it.

export {
  // Persisted-credential helpers (sync) — used by the sync loop, the
  // persistence migration, and audit tooling. `inventoryStoredAuthRecords`
  // (valid + invalid with reasons) is deliberately kept separate from the
  // async `CredentialStore` contract.
  type StoredAuthRecord,
  type AuthRecordInventory,
  maskMid,
  authDataFromStoredRecord,
  loadStoredAuthRecord,
  listStoredAuthRecords,
  inventoryStoredAuthRecords,
  persistAuthData,
  loadAuthFromDisk,
  // Async credential-store port for the auth provider.
  type CredentialStore,
  FileCredentialStore,
} from './auth/credential-store';

export {
  type PublicEndpointConfig,
  type LinePrincipal,
  type LineAuthProviderOptions,
  LineAuthProvider,
  publicEndpointConfig,
} from './auth/line-auth-provider';

// ─── Messenger tools, resources, import service, sync, standalone (Task 9) ──

export {
  type RequestLineClient,
  type RequestClientFactoryOptions,
  createRequestClientFactory,
} from './request-client';

export {
  type ImportServiceOptions,
  type CompleteImportOutcome,
  ImportService,
} from './import-service';

export { type LineToolDeps, registerLineTools } from './tools';
export { type RegisterLineResourcesOptions, registerLineResources } from './resources';

export { type SyncOptions, syncAll, startSyncLoop } from './sync';

export {
  type StandaloneOptions,
  type StandaloneServer,
  createStandaloneServer,
} from './standalone';
