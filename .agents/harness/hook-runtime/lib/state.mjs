// Generated from src/shared/lib/state.mts by scripts/build.mts. Do not edit.
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LOCK_RE = /^gate\.lock\.(\d+)$/;
const PRUNE_AGE_MS = 3600 * 1000;
let tmpCounter = 0;

export function gitDir(repoRoot) {
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// The git directory every worktree of the repository shares. No --path-format: older git echoes
// an unknown option and exits 0; the common dir prints relative in a main checkout.
export function gitCommonDir(repoRoot) {
  const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2000,
  }).trim();
  return realpathSync(resolve(repoRoot, out));
}

export function toolStateDir(repoRoot, tool) {
  return join(gitDir(repoRoot), 'agent-harness', tool);
}

const clean = (id) => {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' || /^\.+$/.test(s) ? `_${s}` : s;
};

export function rootSessionStateDir({ repoRoot, tool, host, sessionId }) {
  const dir = join(toolStateDir(repoRoot, tool), 'sessions', `${clean(host)}-${clean(sessionId)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// <git common dir>/agent-harness/<tool>/sessions/<host>-<session>: session state that follows the
// session across the repository's worktrees. In a main checkout it is rootSessionStateDir.
export function commonSessionDir({ repoRoot, tool, host, sessionId }) {
  const dir = join(gitCommonDir(repoRoot), 'agent-harness', tool, 'sessions', `${clean(host)}-${clean(sessionId)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionStateDir({ repoRoot, tool, host, sessionId, agentId }) {
  const dir = join(rootSessionStateDir({ repoRoot, tool, host, sessionId }), clean(agentId ?? 'main'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpName(dir) {
  return join(dir, `.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`);
}

export function writeJsonAtomic(path, value) {
  const tmp = tmpName(dirname(path));
  writeFileSync(tmp, JSON.stringify(value));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function listLocks(dir) {
  return readdirSync(dir)
    .map((f) => LOCK_RE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function readLock(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function isFree(path) {
  let body;
  try {
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' || err instanceof SyntaxError;
  }
  if (!body || typeof body !== 'object') return true;
  return body.released === true || !pidAlive(body.pid);
}

function prune(dir, own) {
  const now = Date.now();
  const all = listLocks(dir);
  const highest = all[all.length - 1];
  for (const n of all) {
    if (n >= own || n === highest) continue;
    const file = join(dir, `gate.lock.${n}`);
    try {
      if (now - statSync(file).mtimeMs > PRUNE_AGE_MS) unlinkSync(file);
    } catch {}
  }
}

// The process groups the newest lock's dead holder recorded, when that lock is recent enough to
// trust. Read-only and synchronous: the supervisor calls it before it takes the lock.
export function staleGroups(dir, { maxAgeMs }) {
  try {
    const all = listLocks(dir);
    const newest = all[all.length - 1];
    if (newest === undefined) return [];
    const lock = readLock(join(dir, `gate.lock.${newest}`));
    if (!lock || lock.released === true || pidAlive(lock.pid)) return [];
    const at = lock.at;
    if (typeof at !== 'number' || !Number.isFinite(at) || !(Date.now() - at < maxAgeMs)) return [];
    const pgids = lock.pgids;
    if (!Array.isArray(pgids)) return [];
    return pgids.filter((pgid) => Number.isInteger(pgid) && pgid > 0);
  } catch {
    return [];
  }
}

export function updateGateLock(handle, fields) {
  const current = readLock(handle.path) ?? {};
  writeJsonAtomic(handle.path, { ...current, ...fields });
}

export function acquireGateLock(dir, { beforeLink } = {}) {
  mkdirSync(dir, { recursive: true });
  const all = listLocks(dir);
  const h = all.length ? all[all.length - 1] : 0;
  if (h > 0 && !isFree(join(dir, `gate.lock.${h}`))) return null;
  if (beforeLink) beforeLink();

  const mine = h + 1;
  const path = join(dir, `gate.lock.${mine}`);
  const tmp = tmpName(dir);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), pgids: [] }));
  try {
    linkSync(tmp, path);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  const after = listLocks(dir);
  if (after[after.length - 1] !== mine) {
    updateGateLock({ path }, { released: true });
    return null;
  }
  prune(dir, mine);
  return {
    path,
    release() {
      updateGateLock({ path }, { released: true });
    },
    update(fields) {
      updateGateLock({ path }, fields);
    },
  };
}
