import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { cacheDbPath, authDir } from './data-layout';
import { inventoryStoredAuthRecords, type AuthRecordInventory } from '@raidenyn/line-mcp';
import {
  stageLineDb,
  stageQuarantineDb,
  recoverQuarantinedMessagesSql,
  readLegacyMessages,
  type LegacyMessageRow,
} from '@raidenyn/line-client-sqlite';
import {
  readLegacyCategories,
  stageBankCategories,
  type LegacyCategoryRow,
} from '@raidenyn/bank-mcp';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ActivePersistence {
  generation: string;
  lineDbPath: string;
  bankDbPath: string;
  quarantineDbPath: string;
  reportPath: string;
}

export type FailPoint =
  | 'after-line'
  | 'after-bank'
  | 'after-quarantine'
  | 'after-validation'
  | 'before-marker-write'
  | 'after-marker-write'
  | 'after-marker-fsync'
  | 'after-generation-dir-fsync'
  | 'before-pointer-rename'
  | 'after-pointer-rename';

export interface MigrationCounts {
  sourceMessages: number;
  attributedMessages: number;
  quarantinedMessages: number;
  sourceCategories: number;
  copiedCategories: number;
}

export interface RecoveryReportEntry {
  recoveredTotal: number;
  conflictsTotal: number;
  lastRunAt: string;
}

export interface MigrationReport {
  generation: string;
  createdAt: string;
  legacySourcePresent: boolean;
  ownerMid: string | null;
  quarantineReason: string | null;
  authCandidates: {
    validCount: number;
    invalidCount: number;
    invalidReasons: string[];
  };
  counts: MigrationCounts;
  // Populated only after recoverQuarantinedMessages() has run at least once
  // against this generation; absent on a freshly-published generation.
  recovery?: RecoveryReportEntry;
}

// ─── Quarantine recovery (explicit operator MID mapping only) ───────────────

export interface RecoveryMapping {
  // Keyed by the same audit-stable `chatMid/messageId` source_key stageQuarantineDb
  // writes; value is the owner mid an operator has determined the message
  // actually belongs to. Never inferred automatically — recovery only ever
  // acts on mappings the caller supplies explicitly.
  messages: Record<string, string>;
}

export interface RecoveryResult {
  recovered: number;
  unresolved: number;
  conflicts: number;
}

// ActivePersistence never carries dataRoot directly (it's re-derived here
// rather than added as a field) so the interface stays what bootstrapPersistence
// has always returned; every generation path is a fixed descendant of dataRoot
// (see resolveGenerationPaths), so walking back up from reportPath is exact.
function deriveDataRoot(active: ActivePersistence): string {
  return path.dirname(path.dirname(path.dirname(active.reportPath)));
}

function updateReportWithRecovery(
  reportPath: string,
  delta: { recovered: number; conflicts: number },
): void {
  let report: MigrationReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as MigrationReport;
  } catch {
    return; // no report to update against — should not happen in practice
  }
  const prev = report.recovery ?? { recoveredTotal: 0, conflictsTotal: 0, lastRunAt: '' };
  report.recovery = {
    recoveredTotal: prev.recoveredTotal + delta.recovered,
    conflictsTotal: prev.conflictsTotal + delta.conflicts,
    lastRunAt: new Date().toISOString(),
  };
  // Atomic visibility: write to a sibling temp file then rename. A plain
  // writeFileSync here would leave a truncated/corrupt report on a mid-write
  // crash, and readPointer() still treats the (intact) pointer as
  // authoritative while the audit artifact behind it is garbage. Mirrors the
  // crash-safety the pointer itself gets via publishPointer().
  const dir = path.dirname(reportPath);
  const tmp = path.join(
    dir,
    `.migration-report.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let writeErr: unknown;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(report, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, reportPath);
  } catch (err) {
    writeErr = err;
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
  if (writeErr !== undefined) throw writeErr;
}

// Explicit-mapping recovery for rows quarantined by bootstrapPersistence.
// Never infers ownership — a row is only recovered when the caller's mapping
// names its exact source_key and the named owner mid has a valid stored auth
// record (validated fresh on every call, since accounts can be added between
// runs). Rows whose target would collide with an existing row already
// present in the active line DB are left exactly as they were and counted as
// `conflicts`, never overwritten. Resolved rows are updated in place
// (resolution_owner_mid/resolved_at set) and retained in legacy_messages for
// audit — nothing is ever deleted.
export function recoverQuarantinedMessages(
  active: ActivePersistence,
  mapping: RecoveryMapping,
): RecoveryResult {
  const dataRoot = deriveDataRoot(active);
  const validMids = new Set(
    inventoryStoredAuthRecords(authDir(dataRoot)).valid.map(v => v.mid),
  );

  // Direct SQLite recovery over the quarantine/line databases lives in
  // @raidenyn/line-client-sqlite (issue #75, Task 6) — this function keeps
  // only the orchestration: resolving which mids are currently valid, and
  // folding the result into the persisted migration report.
  const { recovered, conflicts, total } = recoverQuarantinedMessagesSql(
    active.quarantineDbPath,
    active.lineDbPath,
    mapping.messages,
    validMids,
  );

  const unresolved = total - recovered - conflicts;
  updateReportWithRecovery(active.reportPath, { recovered, conflicts });

  return { recovered, unresolved, conflicts };
}

// ─── Path layout ──────────────────────────────────────────────────────────────

// Generation ids are internally generated (see makeGenerationId) and never
// taken verbatim from user input, but a tampered/corrupt persistence-current.json
// could still name something unsafe — so every resolved path is re-validated
// against dataRoot regardless of where the generation string came from.
const GENERATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Refusing to resolve a persistence path outside the data root');
  }
  return resolved;
}

export function resolveGenerationPaths(dataRoot: string, generation: string): ActivePersistence {
  if (!GENERATION_ID_PATTERN.test(generation)) {
    throw new Error('Invalid generation id: must match ^[A-Za-z0-9_-]+$');
  }
  const base = safeJoin(dataRoot, 'persistence-generations', generation);
  return {
    generation,
    lineDbPath: safeJoin(base, 'line', 'messages.db'),
    bankDbPath: safeJoin(base, 'bank', 'bank.db'),
    quarantineDbPath: safeJoin(base, 'quarantine', 'messages.db'),
    reportPath: safeJoin(base, 'migration-report.json'),
  };
}

function generationsRoot(dataRoot: string): string {
  return safeJoin(dataRoot, 'persistence-generations');
}

function pointerPath(dataRoot: string): string {
  return safeJoin(dataRoot, 'persistence-current.json');
}

function makeGenerationId(): string {
  return `gen-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

// ─── Pointer (the one cutover commit point) ──────────────────────────────────

interface PointerManifest {
  generation: string;
  publishedAt: string;
}

// ─── Durable publication marker helpers ──────────────────────────────────────

// Test-injectable filesystem operations seam. Production uses the real fs
// functions; tests can replace these to record call order and inject
// failures (e.g. EIO on fsync). Each function MUST be called by production
// code instead of the corresponding fs.* function for durability operations,
// so the tests can observe and inject through this single chokepoint.
interface FsOps {
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  statSync(path: string): fs.Stats;
  lstatSync(path: string): fs.Stats;
  readFileSync(path: string, encoding: BufferEncoding): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(path: string, data: string, mode?: number): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

const realFsOps: FsOps = {
  openSync: (p, f, m) => (m !== undefined ? fs.openSync(p, f, m) : fs.openSync(p, f)),
  writeSync: (fd, d) => fs.writeSync(fd, d),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (o, n) => fs.renameSync(o, n),
  statSync: (p) => fs.statSync(p),
  lstatSync: (p) => fs.lstatSync(p),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  readdirSync: (p) => fs.readdirSync(p),
  existsSync: (p) => fs.existsSync(p),
  rmSync: (p, o) => fs.rmSync(p, o),
  writeFileSync: (p, d, m) => (m !== undefined ? fs.writeFileSync(p, d, { mode: m }) : fs.writeFileSync(p, d)),
  mkdirSync: (p, o) => (o !== undefined ? fs.mkdirSync(p, o) : fs.mkdirSync(p)),
};

let fsOps: FsOps = realFsOps;

// Exported setter so tests can install/clear a recording/injecting wrapper
// without relying on live-binding semantics. Pass null to restore the real
// fs operations. The fsOps variable itself stays module-private.
export function __setFsOps(ops: Partial<FsOps> | null): void {
  fsOps = ops ? { ...realFsOps, ...ops } : realFsOps;
}

// Sentinel file written inside a generation directory at publication time
// (BEFORE the pointer rename — see publishPointer for the ordering
// rationale). Its presence is the durable signal that this generation was
// once authoritative — see discardUnpublishedGenerations for the two ways
// this assumption is enforced (no silent discard, no divergent
// re-bootstrap via the preserved list it returns).
const PUBLICATION_MARKER = '.published';

// fsyncs a directory so directory-entry updates (marker creation, rename)
// are durable before the pointer commit.
function fsyncDirectory(directory: string): void {
  const fd = fsOps.openSync(directory, 'r');
  try {
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
}

// Ensures the `.published` marker inside a generation directory exists and
// is durably persisted (file fsync + directory fsync). Used in TWO places:
//
// 1. publishPointer: BEFORE the pointer rename, so a committed pointer never
//    exists without a durably-persisted marker. A marker write/fsync failure
//    here aborts before the rename, leaving genuinely uncommitted staging
//    (no pointer → safe to discard on next run).
// 2. readPointer: AFTER validating all required artifacts, before returning
//    `active`. This is the self-repair path — a valid pointer with complete
//    artifacts but a missing marker (e.g. partial power loss that preserved
//    the pointer but not the marker's directory entry) durably recreates the
//    marker rather than accepting an unmarked committed generation (which
//    later pointer loss would let discard silently delete).
//
// When the marker already exists, it is opened and fsynced in place (no
// content rewrite) — this covers the "marker exists but wasn't fsynced"
// case from an older code path. When the marker is absent, it is created
// with mode 0600, the current timestamp is written, and both the marker
// file and its parent directory are fsynced.
function ensureDurablePublicationMarker(generationDir: string): void {
  const markerPath = path.join(generationDir, PUBLICATION_MARKER);
  const markerExists = safeMarkerExists(markerPath);
  const fd = fsOps.openSync(markerPath, markerExists ? 'r' : 'wx', 0o600);
  try {
    if (!markerExists) {
      fsOps.writeSync(fd, new Date().toISOString());
    }
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }
  // fsync the generation directory so the marker's directory entry is
  // durable before the pointer is committed (publishPointer path) or
  // before the generation is returned as authoritative (readPointer path).
  fsyncDirectory(generationDir);
}

// Checks whether the marker file exists as a regular file. Returns false
// only for ENOENT; any other stat error is propagated (fail closed — see
// Task 2 for the strict error-classification rationale). Uses lstatSync so
// symlinks (including dangling ones) and directories are NOT classified as
// "absent" — classifying a damaged marker (a replaced directory, a symlink
// to nowhere) as absent would let discardUnpublishedGenerations delete the
// committed generation and bootstrap publish a divergent one, losing data.
// lstatSync on a dangling symlink does NOT throw; it returns a symlink
// stat, so the isFile() check converts it to a throw rather than false.
function safeMarkerExists(markerPath: string): boolean {
  try {
    const stat = fsOps.lstatSync(markerPath);
    if (!stat.isFile()) {
      throw new Error(
        `Persistence marker ${markerPath} exists but is not a regular file (possibly a directory, symlink, or special file). ` +
        'Refusing to classify as absent — a non-file marker is a damaged data root that requires operator inspection.',
      );
    }
    return true;
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return false;
    throw err;
  }
}

// Type-narrowing helper for NodeJS.ErrnoException codes.
function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === code;
}

// ─── Pointer (the one cutover commit point) ──────────────────────────────────

// A pointer is only authoritative when it parses, names a syntactically safe
// generation, AND every required artifact of that committed generation still
// exists on disk: the migration report plus the line, bank, and quarantine
// databases. A pointer to a generation that has been partially deleted or
// damaged after publication is NOT silently adopted — the constructors the
// composed server passes these paths to (`SqliteMessageCache`,
// `CategoryStore`) would otherwise fabricate brand-new empty DBs inside the
// missing slots and silently hide persisted messages/categories. Surfacing the
// damage by throwing is preferable to fabricating: a truly fresh data root has
// no pointer at all (handled by the `readFileSync` catch below), so a pointer
// that points at an incomplete generation is by definition a damaged root.
//
// Syntactically invalid or unsafe generation ids are still treated as "no
// pointer yet" (return null) so `bootstrapPersistence` can safely discard any
// orphaned staging and rebuild — those never reached publication in the first
// place and so carry no real data of their own.
function readPointer(dataRoot: string): ActivePersistence | null {
  let raw: string;
  try {
    raw = fsOps.readFileSync(pointerPath(dataRoot), 'utf8');
  } catch (err) {
    // Only ENOENT means "no pointer yet" — every other read error (EACCES,
    // EIO, ENOTDIR, etc.) is a filesystem-level problem that must fail
    // closed rather than be silently treated as "no pointer" (which would
    // publish a divergent active generation alongside any committed data).
    if (isErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  const generation = (manifest as Partial<PointerManifest> | null)?.generation;
  if (typeof generation !== 'string') return null;
  let active: ActivePersistence;
  try {
    active = resolveGenerationPaths(dataRoot, generation);
  } catch {
    return null;
  }
  const missing = [
    active.reportPath,
    active.lineDbPath,
    active.bankDbPath,
    active.quarantineDbPath,
  ].filter((p) => !fsOps.existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `Persistence pointer names generation ${generation} but required artifact(s) are missing:\n` +
        missing.map((p) => `  - ${p}`).join('\n') +
        '\nThe data root appears to have been damaged after migration publication. ' +
        'Refusing to fabricate empty DBs inside the committed generation — restore the ' +
        'missing file(s) from backup. Do NOT delete the pointer file as a "recovery": ' +
        'that routes the next bootstrap through discardUnpublishedGenerations, which ' +
        'would recursively delete the surviving committed generation (including any ' +
        'persisted messages in the line DB that is still intact), destroying the very ' +
        'data this throw is protecting. The publication marker inside the committed ' +
        'generation also guards against accidental discard — see publishPointer().',
    );
  }
  // Self-repair: a valid pointer with complete artifacts but a missing (or
  // non-durable) marker durably recreates it before returning. This closes
  // the "committed pointer survived power loss but marker didn't" gap: the
  // generation is re-authorized AND re-protected in one atomic step.
  ensureDurablePublicationMarker(path.dirname(active.reportPath));
  return active;
}

// Called only when readPointer() found nothing authoritative, so every
// directory here is by definition unreferenced by any committed pointer.
// Returns the list of any still-published generations (those carrying the
// publication marker) so bootstrapPersistence can decide to refuse rather
// than publish a divergent active dataset that would silently hide the
// persisted messages in the orphaned committed generation(s).
//
// A generation carrying the publication marker was committed by a past
// bootstrap — its pointer may have been removed/readPointer may now
// return null, but the generation itself is NOT disposable staging.
// Discarding it would recursively delete the surviving line/bank DBs
// (which readPointer's missing-artifact throw is actively trying to
// protect). A marked generation is skipped here and left on disk for
// forensic recovery.
function discardUnpublishedGenerations(dataRoot: string): string[] {
  const root = generationsRoot(dataRoot);
  let entries: string[];
  try {
    entries = fsOps.readdirSync(root);
  } catch (err) {
    // Only ENOENT means "no generations tree yet" (fresh root) — every other
    // readdir error (EACCES, EIO, etc.) must fail closed rather than be
    // silently treated as "empty" (which would bypass the fail-closed
    // check and publish a divergent active generation).
    if (isErrnoCode(err, 'ENOENT')) return [];
    throw err;
  }
  const preserved: string[] = [];
  for (const name of entries) {
    const generationDir = path.join(root, name);
    if (safeMarkerExists(path.join(generationDir, PUBLICATION_MARKER))) {
      // This generation was published once; even without a live pointer we
      // refuse to discard it. See PUBLICATION_MARKER above for the
      // rationale and the bootstrap-fail-closed invariant that depends on
      // this list being returned to the caller.
      process.stderr.write(
        `[persistence] Skipping published generation ${name} during discard ` +
          '(no live pointer, but publication marker present — preserving for forensic recovery).\n',
      );
      preserved.push(name);
      continue;
    }
    fsOps.rmSync(generationDir, { recursive: true, force: true });
  }
  return preserved;
}

function publishPointer(dataRoot: string, generation: string, failAt?: FailPoint): void {
  const file = pointerPath(dataRoot);
  const dir = path.dirname(file);
  fsOps.mkdirSync(dir, { recursive: true });
  const manifest: PointerManifest = { generation, publishedAt: new Date().toISOString() };
  const tmp = path.join(dir, `.persistence-current.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);

  const fd = fsOps.openSync(tmp, 'wx', 0o600);
  try {
    fsOps.writeSync(fd, JSON.stringify(manifest, null, 2));
    fsOps.fsyncSync(fd);
  } finally {
    fsOps.closeSync(fd);
  }

  // Write the publication marker BEFORE the pointer rename. The marker is
  // the generation's durable "this was once committed, never silently
  // discard it" flag (see discardUnpublishedGenerations). Writing it
  // before the rename — with both the marker file AND the generation
  // directory fsynced — is what makes that guarantee airtight:
  //
  //   - crash at 'before-pointer-rename': the generation is durably marked
  //     but NO pointer exists. discard will refuse it (marker present) AND
  //     the fail-closed check in bootstrapPersistence will refuse to
  //     bootstrap fresh alongside it. The orphaned marked generation stays
  //     on disk for forensic salvage.
  //   - crash at 'after-pointer-rename': the pointer is already committed
  //     AND the marker is already durably written; readPointer succeeds and
  //     the generation is authoritative, exactly as intended.
  //
  // The marker write is intentionally NOT fail-tolerant here: if it throws
  // (open, write, fsync, or directory fsync), we abort before publishing
  // the pointer, leaving the generation as unmarked staging (no marker, no
  // pointer → genuinely unreferenced → discard correctly removes it on the
  // next run). That is the safe state — the alternative (swallowing marker
  // failures to "commit anyway") reintroduces the gap.
  //
  // Fail points for testing the durability ordering:
  //   'before-marker-write'  — after the pointer tmp fsync, before marker open
  //   'after-marker-write'   — after marker write, before marker fsync
  //   'after-marker-fsync'   — after marker fsync, before generation-dir fsync
  //   'after-generation-dir-fsync' — after dir fsync, before pointer rename
  const generationDir = safeJoin(dataRoot, 'persistence-generations', generation);

  if (failAt === 'before-marker-write') {
    throw new Error('Simulated crash: before-marker-write');
  }
  const markerPath = path.join(generationDir, PUBLICATION_MARKER);
  const markerExisted = safeMarkerExists(markerPath);
  const markerFd = fsOps.openSync(markerPath, markerExisted ? 'r' : 'wx', 0o600);
  try {
    if (!markerExisted) {
      fsOps.writeSync(markerFd, new Date().toISOString());
    }
    if (failAt === 'after-marker-write') {
      throw new Error('Simulated crash: after-marker-write');
    }
    fsOps.fsyncSync(markerFd);
  } finally {
    fsOps.closeSync(markerFd);
  }
  if (failAt === 'after-marker-fsync') {
    throw new Error('Simulated crash: after-marker-fsync');
  }
  fsyncDirectory(generationDir);
  if (failAt === 'after-generation-dir-fsync') {
    throw new Error('Simulated crash: after-generation-dir-fsync');
  }

  if (failAt === 'before-pointer-rename') {
    throw new Error('Simulated crash: before-pointer-rename');
  }

  fsOps.renameSync(tmp, file);

  const dirFd = fsOps.openSync(dir, 'r');
  try {
    fsOps.fsyncSync(dirFd);
  } finally {
    fsOps.closeSync(dirFd);
  }

  if (failAt === 'after-pointer-rename') {
    throw new Error('Simulated crash: after-pointer-rename');
  }
}

// ─── Legacy source (read-only; never modified) ───────────────────────────────
// The line/quarantine row shape (LegacyMessageRow) and its reader come from
// @raidenyn/line-client-sqlite; the bank/category row shape (LegacyCategoryRow),
// its reader, and its staging primitive come from @raidenyn/bank-mcp. This file
// no longer opens SQLite directly — it only orchestrates those two packages'
// primitives (issue #75, Task 10). Both readers throw with a "corrupt or
// unreadable; refusing migration" error rather than guessing, preserving the
// pre-extraction refuse-on-corrupt guarantee.

interface LegacySource {
  present: boolean;
  messages: LegacyMessageRow[];
  categories: LegacyCategoryRow[];
}

function readLegacySource(dataRoot: string): LegacySource {
  const file = cacheDbPath(dataRoot);
  if (!fs.existsSync(file)) {
    return { present: false, messages: [], categories: [] };
  }
  // readLegacyMessages runs first, so a corrupt legacy file is rejected before
  // any category read is attempted — exactly like the single-open reader it
  // replaces.
  const messages = readLegacyMessages(file);
  const categories = readLegacyCategories(file);
  return { present: true, messages, categories };
}

// ─── Ownership decision matrix ────────────────────────────────────────────────

interface OwnershipDecision {
  ownerMid: string | null;
  quarantineReason: string | null;
}

// Never infer ownership from chat_mid, message contents, record order, or the
// first saved account. Automatic attribution is permitted in exactly one
// case: one valid auth candidate and zero invalid ones. Any other shape
// (nothing valid, several valid, or an invalid file present alongside a valid
// one) is ambiguous and quarantines the entire source.
function decideOwnership(inventory: AuthRecordInventory): OwnershipDecision {
  if (inventory.invalid.length > 0) {
    return {
      ownerMid: null,
      quarantineReason:
        `ambiguous ownership: ${inventory.invalid.length} invalid auth record(s) present ` +
        `alongside ${inventory.valid.length} valid one(s)`,
    };
  }
  if (inventory.valid.length === 0) {
    return { ownerMid: null, quarantineReason: 'ambiguous ownership: no valid auth record found' };
  }
  if (inventory.valid.length > 1) {
    return {
      ownerMid: null,
      quarantineReason: `ambiguous ownership: ${inventory.valid.length} valid auth records found`,
    };
  }
  return { ownerMid: inventory.valid[0].mid, quarantineReason: null };
}

// ─── Staging destination databases ───────────────────────────────────────────
// Line/quarantine staging (stageLineDb/stageQuarantineDb) lives in
// @raidenyn/line-client-sqlite (issue #75, Task 6); bank/category staging
// (stageBankCategories) lives in @raidenyn/bank-mcp (Task 10). Both are
// imported above — this file owns only the orchestration below.

// ─── Count validation (refuses pointer publication on mismatch) ─────────────

export function validateMigrationCounts(counts: MigrationCounts): void {
  if (counts.attributedMessages + counts.quarantinedMessages !== counts.sourceMessages) {
    throw new Error(
      'Migration validation failed: attributedMessages + quarantinedMessages ' +
      `(${counts.attributedMessages} + ${counts.quarantinedMessages}) does not equal ` +
      `sourceMessages (${counts.sourceMessages}); refusing to publish the pointer`,
    );
  }
  if (counts.copiedCategories !== counts.sourceCategories) {
    throw new Error(
      'Migration validation failed: copiedCategories ' +
      `(${counts.copiedCategories}) does not equal sourceCategories (${counts.sourceCategories}); ` +
      'refusing to publish the pointer',
    );
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export function bootstrapPersistence(options: {
  dataRoot: string;
  failAt?: FailPoint;
}): ActivePersistence {
  const { dataRoot, failAt } = options;
  fs.mkdirSync(dataRoot, { recursive: true });

  // Steady state / restart-after-publish: a valid pointer is authoritative
  // and short-circuits everything else — the legacy source is never
  // re-read once a generation has been committed.
  const existing = readPointer(dataRoot);
  if (existing) return existing;

  // No valid pointer. Sweep the generations tree: anything that's a
  // genuine unreferenced staging generation (no publication marker, no
  // pointer naming it) is removed; anything carrying the marker was once
  // committed and stays on disk. The preserved list is returned so this
  // bootstrap can decide whether proceeding is safe at all.
  const preserved = discardUnpublishedGenerations(dataRoot);
  if (preserved.length > 0) {
    // FAIL CLOSED: at least one published generation exists on this data
    // root but readPointer() could not establish authority for ANY of
    // them (pointer missing/malformed, or pointer named a damaged
    // generation and readPointer threw). Proceeding would publish a fresh
    // generation from whatever legacy source (or empty) the disk happens
    // to have and make IT active, silently diverging from the persisted
    // messages in the orphaned committed generation(s) — the running
    // server would see an empty cache while real data sits unreachable in
    // the preserved generation's line DB. Refuse instead; the operator
    // must either restore a valid pointer (backup of
    // persistence-current.json naming one of the preserved generations,
    // or repair its artifacts so readPointer re-authorizes it) or
    // explicitly evacuate/delete the orphaned generation(s) before
    // re-bootstrap. There is no automatic recovery path because the
    // right recovery depends on operator intent.
    throw new Error(
      `Refusing to bootstrap: ${preserved.length} published generation(s) exist ` +
        `on this data root but no current pointer could establish authority ` +
        `(pointer missing, malformed, or names a generation with missing ` +
        `required artifacts).\n` +
        `Preserved generation(s): ${preserved.join(', ')}\n` +
        `Each still holds its committed line/bank/quarantine DBs on disk. ` +
        `To recover, restore a valid persistence-current.json pointing at ` +
        `one of them (and ensure all its required artifacts exist so ` +
        `readPointer re-authorizes it), or — if the data is genuinely ` +
        `disposable — manually remove the preserved generation directory ` +
        `(s) before restarting. There is no automatic path: a fresh ` +
        `bootstrap would publish a divergent active generation and ` +
        `silently hide the persisted messages in the preserved one(s).`,
    );
  }

  const legacy = readLegacySource(dataRoot);
  const inventory = inventoryStoredAuthRecords(authDir(dataRoot));
  const hasMessages = legacy.messages.length > 0;
  const decision = hasMessages
    ? decideOwnership(inventory)
    : { ownerMid: null, quarantineReason: null };

  // decision.quarantineReason is only ever null when decision.ownerMid is set
  // (see decideOwnership) or when there were no messages to begin with; the
  // fallback text is defensive and should never actually surface.
  const attributedRows = decision.ownerMid ? legacy.messages : [];
  const quarantinedRows = !decision.ownerMid && hasMessages ? legacy.messages : [];
  const quarantineReasonForRows = decision.quarantineReason ?? 'ambiguous ownership';

  const generation = makeGenerationId();
  const active = resolveGenerationPaths(dataRoot, generation);

  stageLineDb(active.lineDbPath, attributedRows, decision.ownerMid ?? '');
  if (failAt === 'after-line') throw new Error('Simulated crash: after-line');

  const bankStaging = stageBankCategories(active.bankDbPath, legacy.categories);
  if (failAt === 'after-bank') throw new Error('Simulated crash: after-bank');

  stageQuarantineDb(active.quarantineDbPath, quarantinedRows, quarantineReasonForRows);
  if (failAt === 'after-quarantine') throw new Error('Simulated crash: after-quarantine');

  const counts: MigrationCounts = {
    sourceMessages: legacy.messages.length,
    attributedMessages: attributedRows.length,
    quarantinedMessages: quarantinedRows.length,
    sourceCategories: bankStaging.sourceCategories,
    copiedCategories: bankStaging.copiedCategories,
  };
  validateMigrationCounts(counts);

  const report: MigrationReport = {
    generation,
    createdAt: new Date().toISOString(),
    legacySourcePresent: legacy.present,
    ownerMid: decision.ownerMid,
    quarantineReason: decision.quarantineReason,
    authCandidates: {
      validCount: inventory.valid.length,
      invalidCount: inventory.invalid.length,
      invalidReasons: inventory.invalid.map(i => i.reason),
    },
    counts,
  };
  fs.writeFileSync(active.reportPath, JSON.stringify(report, null, 2));
  if (failAt === 'after-validation') throw new Error('Simulated crash: after-validation');

  publishPointer(dataRoot, generation, failAt);

  return active;
}
