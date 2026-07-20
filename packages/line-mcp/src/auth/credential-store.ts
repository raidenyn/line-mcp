import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AuthData } from '@raidenyn/line-client';

// ─── Default auth directory ─────────────────────────────────────────────────
//
// This package is self-contained: it never imports the executable's data-dir
// helpers and, critically, never reads or creates `data/secret` on import. The
// signing secret is injected into `LineAuthProvider` by whatever executable
// constructs it. This default mirrors the executable's historical
// `authDir()` (`<DATA_DIR|cwd/data>/auth`) purely so the standalone
// persistence helpers keep working for callers (sync, migration, tests) that
// have always relied on it. It is resolved lazily at call time — importing this
// module performs no filesystem access.
function defaultAuthDir(): string {
  return path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'auth');
}

// ─── Path / structural validation ───────────────────────────────────────────

function isSafeMid(mid: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(mid);
}

export function maskMid(mid: string): string {
  return isSafeMid(mid) && mid.length >= 8 ? `${mid.slice(0, 4)}...${mid.slice(-4)}` : 'unknown';
}

export interface StoredAuthRecord extends AuthData {
  displayName?: string;
}

export function authDataFromStoredRecord(record: StoredAuthRecord): AuthData {
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    certificate: record.certificate,
    mid: record.mid,
    wrappedNonce: record.wrappedNonce,
    kdfParameter1: record.kdfParameter1,
    kdfParameter2: record.kdfParameter2,
  };
}

const AUTH_FIELDS: ReadonlyArray<keyof AuthData> = [
  'accessToken',
  'refreshToken',
  'certificate',
  'mid',
  'wrappedNonce',
  'kdfParameter1',
  'kdfParameter2',
];

// Structural-only outcome: callers may surface `reason` to operators, so it
// must never echo field values (credentials, certificates, nonces, ...).
type StoredAuthRecordParseResult =
  | { ok: true; record: StoredAuthRecord }
  | { ok: false; reason: string };

function parseStoredAuthRecordDetailed(value: unknown, expectedMid: string): StoredAuthRecordParseResult {
  if (!isSafeMid(expectedMid)) return { ok: false, reason: 'file name is not a safe LINE mid' };
  if (!value || typeof value !== 'object') return { ok: false, reason: 'content is not a JSON object' };
  const candidate = value as Record<string, unknown>;
  if (candidate.mid !== expectedMid) return { ok: false, reason: '"mid" field does not match the file name' };
  const badFields = AUTH_FIELDS.filter(
    field => typeof candidate[field] !== 'string' || candidate[field] === '',
  );
  if (badFields.length > 0) {
    return { ok: false, reason: `missing or invalid field(s): ${badFields.join(', ')}` };
  }
  if ('displayName' in candidate &&
      (typeof candidate.displayName !== 'string' || candidate.displayName.trim() === '')) {
    return { ok: false, reason: '"displayName" is present but empty or not a string' };
  }
  return { ok: true, record: candidate as unknown as StoredAuthRecord };
}

function parseStoredAuthRecord(value: unknown, expectedMid: string): StoredAuthRecord | null {
  const result = parseStoredAuthRecordDetailed(value, expectedMid);
  return result.ok ? result.record : null;
}

export function loadStoredAuthRecord(
  mid: string,
  storeDir = defaultAuthDir(),
): StoredAuthRecord | null {
  if (!isSafeMid(mid)) return null;
  try {
    const file = path.resolve(storeDir, `${mid}.json`);
    if (!file.startsWith(path.resolve(storeDir) + path.sep)) return null;
    return parseStoredAuthRecord(JSON.parse(fs.readFileSync(file, 'utf8')), mid);
  } catch {
    return null;
  }
}

export function listStoredAuthRecords(storeDir = defaultAuthDir()): StoredAuthRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: StoredAuthRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const mid = entry.name.slice(0, -5);
    const record = loadStoredAuthRecord(mid, storeDir);
    if (record) records.push(record);
    else process.stderr.write(`[OAuth] Ignoring invalid auth record for ${maskMid(mid)}\n`);
  }
  return records;
}

export interface AuthRecordInventory {
  valid: Array<{ mid: string; path: string }>;
  invalid: Array<{ path: string; reason: string }>;
}

// Unlike listStoredAuthRecords (which silently drops anything it can't parse,
// for use by the normal login/account-selector flow), this reports every file
// so a migration decision can tell "no candidates" apart from "candidates
// that could not be trusted" — both cases must block automatic attribution,
// but only the latter needs a caller-visible reason. `reason` is always a
// structural description (e.g. "missing field: accessToken") and must never
// include field values, since those are LINE credentials.
export function inventoryStoredAuthRecords(storeDir: string): AuthRecordInventory {
  const valid: AuthRecordInventory['valid'] = [];
  const invalid: AuthRecordInventory['invalid'] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return { valid, invalid };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const mid = entry.name.slice(0, -5);
    const file = path.join(storeDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      invalid.push({ path: file, reason: 'file is not valid JSON' });
      continue;
    }
    const result = parseStoredAuthRecordDetailed(parsed, mid);
    if (result.ok) valid.push({ mid: result.record.mid, path: file });
    else invalid.push({ path: file, reason: result.reason });
  }
  return { valid, invalid };
}

export function persistAuthData(
  authData: AuthData,
  displayName?: string,
  storeDir = defaultAuthDir(),
): void {
  if (!isSafeMid(authData.mid) || !parseStoredAuthRecord(authData, authData.mid)) {
    throw new Error('Refusing to persist invalid LINE authentication data');
  }
  const existingName = loadStoredAuthRecord(authData.mid, storeDir)?.displayName;
  const name = displayName?.trim() || existingName;
  const record: StoredAuthRecord = { ...authData, ...(name ? { displayName: name } : {}) };
  const dir = path.resolve(storeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const destination = path.resolve(dir, `${authData.mid}.json`);
  if (!destination.startsWith(dir + path.sep)) throw new Error('Unsafe auth record path');
  const temporary = path.join(
    dir,
    `.${authData.mid}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
}

export function loadAuthFromDisk(mid: string, storeDir = defaultAuthDir()): AuthData | null {
  const record = loadStoredAuthRecord(mid, storeDir);
  return record ? authDataFromStoredRecord(record) : null;
}

// ─── Async credential store (the auth provider's persistence port) ──────────
//
// The typed provider talks to persistence only through this narrow async
// interface. `list()` returns the same valid-only records the login/account
// selector needs; the separate `inventoryStoredAuthRecords` export (valid +
// invalid with reasons) exists for migration/audit and is intentionally NOT
// folded in here.
export interface CredentialStore {
  load(mid: string): Promise<Readonly<AuthData> | null>;
  list(): Promise<readonly StoredAuthRecord[]>;
  saveAtomic(snapshot: Readonly<AuthData>, displayName?: string): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly authStoreDir: string) {}

  async load(mid: string): Promise<Readonly<AuthData> | null> {
    return loadAuthFromDisk(mid, this.authStoreDir);
  }

  async list(): Promise<readonly StoredAuthRecord[]> {
    return listStoredAuthRecords(this.authStoreDir);
  }

  async saveAtomic(snapshot: Readonly<AuthData>, displayName?: string): Promise<void> {
    persistAuthData(snapshot, displayName, this.authStoreDir);
  }
}
