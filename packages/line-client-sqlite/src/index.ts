// Public entry point for @raidenyn/line-client-sqlite.
//
// SQLite-backed adapter for @raidenyn/line-client's MessageCache interface,
// plus the direct-SQLite line/quarantine migration primitives used by the
// server's persistence-migration orchestration (issue #75, Task 6).

export { SqliteMessageCache } from './sqlite-message-cache';

export {
  stageLineDb,
  stageQuarantineDb,
  recoverQuarantinedMessagesSql,
  checkIntegrity,
  type LegacyMessageRow,
  type QuarantineRecoverySqlResult,
} from './migration';
