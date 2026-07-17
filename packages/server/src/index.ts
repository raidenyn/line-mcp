// Public entry point for @raidenyn/server — the composition root.
//
// Importing this module has no side effects: no filesystem reads, no
// database connections, no timers, no sockets, no listeners. Everything is
// deferred to `createServer(options).start()`, which only `cli.ts` calls.

export {
  createServer,
  type ServerOptions,
  type StartResult,
  type ComposedServer,
} from './server';

export {
  bootstrapPersistence,
  resolveGenerationPaths,
  recoverQuarantinedMessages,
  validateMigrationCounts,
  type ActivePersistence,
  type FailPoint,
  type MigrationCounts,
  type MigrationReport,
  type RecoveryMapping,
  type RecoveryResult,
} from './persistence-migration';

export {
  dataDir,
  secretPath,
  authDir,
  templatesDir,
  cacheDbPath,
  generationsDir,
  pointerPath,
  guideDir,
  resolveDataLayout,
  type DataLayout,
} from './data-layout';

export {
  createServerRequestClientFactory,
  type ServerRequestClientOptions,
  type RequestLineClient,
} from './request-client';

export {
  buildRegistrations,
  registerComposedOverview,
  type ComposedDeps,
} from './registrations';
