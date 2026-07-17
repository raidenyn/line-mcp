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
    raw = fs.readFileSync(pointerPath(dataRoot), 'utf8');
  } catch {
    return null;
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
  ].filter((p) => !fs.existsSync(p));
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
  return active;
}

// Called only when readPointer() found nothing authoritative, so every
// directory here is by definition unreferenced by any committed pointer —
// safe to discard and rebuild fresh, per the plan's restart-authority rule.
//
// ONE exception: a generation carrying the publication marker (see
// publishPointer) was committed by a past bootstrap — its pointer may have
// been removed/readPointer may now return null, but the generation itself
// is NOT disposable staging. Discarding it would recursively delete the
// surviving line/bank DBs (which readPointer's missing-artifact throw is
// actively trying to protect). A marked generation is left on disk for
// forensic recovery; bootstrap builds a fresh generation elsewhere and
// publishes a new pointer to it. The orphaned marked generation can be
// removed manually once the operator has salvaged what they need.
function discardUnpublishedGenerations(dataRoot: string): void {
  const root = generationsRoot(dataRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const generationDir = path.join(root, name);
    if (fs.existsSync(path.join(generationDir, PUBLICATION_MARKER))) {
      // This generation was published once; even without a live pointer we
      // refuse to discard it. See the comment above and readPointer()'s
      // missing-artifact throw for the rationale.
      process.stderr.write(
        `[persistence] Skipping published generation ${name} during discard ` +
          '(no live pointer, but publication marker present — preserving for forensic recovery).\n',
      );
      continue;
    }
    fs.rmSync(generationDir, { recursive: true, force: true });
  }
}

// Sentinel file written inside a generation directory at publication time
// (after the pointer rename succeeds). Its presence is the durable signal
// that this generation was once authoritative — see discardUnpublishedGenerations
// for why a published generation is never silently discarded even if its
// pointer is later removed or damaged.
const PUBLICATION_MARKER = '.published';

function publishPointer(dataRoot: string, generation: string, failAt?: FailPoint): void {
  const file = pointerPath(dataRoot);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: PointerManifest = { generation, publishedAt: new Date().toISOString() };
  const tmp = path.join(dir, `.persistence-current.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);

  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (failAt === 'before-pointer-rename') {
    throw new Error('Simulated crash: before-pointer-rename');
  }

  fs.renameSync(tmp, file);

  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }

  // Write the publication marker AFTER the pointer rename has succeeded, so
  // a crash at 'before-pointer-rename' leaves no marker (the generation is
  // genuinely unreferenced staging and discard will correctly remove it),
  // but a crash at 'after-pointer-rename' (the pointer IS now committed)
  // also leaves no marker — the pointer itself is the commit signal in
  // that case, so the marker is only the durable defense for the case
  // where the pointer is later removed/damaged after publication. The
  // marker is best-effort: a crash between the rename and this write leaves
  // a committed generation without marker protection, but readPointer()
  // still finds it via the pointer; the marker only matters once the
  // pointer is gone.
  const generationDir = safeJoin(dataRoot, 'persistence-generations', generation);
  fs.writeFileSync(path.join(generationDir, PUBLICATION_MARKER), new Date().toISOString());

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

  // No committed pointer: any staging generation left behind by a prior
  // interrupted run is unreferenced by definition, so it's safe to discard
  // and rebuild from scratch.
  discardUnpublishedGenerations(dataRoot);

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
