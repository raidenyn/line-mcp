// Generated from src/verify-gate/lib/gate.mts by scripts/build.mts. Do not edit.
// One gate run (design D5 "Every run", "Full-run pass", "Gate lock", "Contended triggers", "Proof",
// "Bounded block", "Failure identity"). Used by the handler (with the supervisor's `spawn` and
// `lock`) and by `cli.mjs run` (with the local ones below).
import { spawn as spawnChild } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand as defaultRunCommand } from './run.mjs';
import { acquireGateLock, writeJsonAtomic } from './state.mjs';
import { changedFiles as defaultChangedFiles, contentKey as defaultContentKey } from './tree.mjs';

export const CONFIG_KEYS = Object.freeze(['command', 'base', 'taskFiles', 'editFiles', 'timeoutSeconds', 'maxBlocks']);
export const REQUIRED_KEYS = Object.freeze(['command']);
export const DEFAULTS = Object.freeze({
  base: 'origin/main',
  taskFiles: Object.freeze(['openspec/changes/*/tasks.md']),
  timeoutSeconds: 900,
  maxBlocks: 3,
});
export const BLOCK_CAP = 3; // per failure key and session, whatever maxBlocks says
export const SESSION_BLOCKS = 10; // backstop per session
export const POLL_MS = 250;
export const PROOF_WAIT_MS = 2000;
export const MANUAL = 'Run node .agents/harness/verify-gate/cli.mjs run by hand.';
export const CONTENDED = 'verify: verification already running; nothing was checked.';
export const PROOF = Object.freeze({
  none: 'verify-pass: no full pass yet',
  content: 'verify-pass: the content changed since the last pass',
  config: 'verify-pass: the verify-gate config changed since the last pass',
  running: 'verify-pass: verification is running',
});
const UNSET = 'set verify-gate.command in .agents/harness.json to the verify argv (a non-empty list of strings)';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

// ---- config -------------------------------------------------------------------------------------

// The section with defaults; never throws (used for hashing and the proof).
export function normalizeConfig(section) {
  const s = isObject(section) ? section : {};
  const max = Number.isInteger(s.maxBlocks) && s.maxBlocks >= 1 ? Math.min(s.maxBlocks, BLOCK_CAP) : DEFAULTS.maxBlocks;
  return {
    command: Array.isArray(s.command) ? s.command.map(String) : [],
    base: typeof s.base === 'string' && s.base ? s.base : DEFAULTS.base,
    taskFiles: strings(s.taskFiles) ? [...s.taskFiles] : [...DEFAULTS.taskFiles],
    editFiles: strings(s.editFiles) ? [...s.editFiles] : null,
    timeoutSeconds:
      typeof s.timeoutSeconds === 'number' && s.timeoutSeconds > 0 ? s.timeoutSeconds : DEFAULTS.timeoutSeconds,
    maxBlocks: max,
  };
}

// Normalized config with a usable command, else throws "set verify-gate.command ...".
export function resolveConfig(section) {
  const cfg = normalizeConfig(section);
  if (!strings(isObject(section) ? section.command : undefined)) throw new Error(UNSET);
  return cfg;
}

// Problems in the section for `check` and install (unknown keys, the command, value ranges).
export function configErrors(section) {
  if (section === undefined) return [`missing "verify-gate" section; ${UNSET}`];
  if (!isObject(section)) return ['"verify-gate" must be an object'];
  const errors = [];
  for (const k of Object.keys(section)) {
    if (!CONFIG_KEYS.includes(k))
      errors.push(`unknown key "${k}" in "verify-gate" (allowed: ${CONFIG_KEYS.join(', ')})`);
  }
  if (!strings(section.command)) errors.push(UNSET);
  if (section.base !== undefined && (typeof section.base !== 'string' || !section.base))
    errors.push('"verify-gate.base" must be a non-empty string');
  if (section.taskFiles !== undefined && !strings(section.taskFiles))
    errors.push('"verify-gate.taskFiles" must be a non-empty list of glob strings');
  if (section.editFiles !== undefined && !strings(section.editFiles))
    errors.push('"verify-gate.editFiles" must be a non-empty list of glob strings');
  if (
    section.timeoutSeconds !== undefined &&
    !(
      typeof section.timeoutSeconds === 'number' &&
      Number.isFinite(section.timeoutSeconds) &&
      section.timeoutSeconds > 0
    )
  ) {
    errors.push('"verify-gate.timeoutSeconds" must be a positive number');
  }
  if (
    section.maxBlocks !== undefined &&
    !(Number.isInteger(section.maxBlocks) && section.maxBlocks >= 1 && section.maxBlocks <= 3)
  ) {
    errors.push('"verify-gate.maxBlocks" must be an integer from 1 to 3');
  }
  return errors;
}

export function configHash(cfg) {
  const c = normalizeConfig(cfg);
  const parts = [c.command, c.base, c.taskFiles, c.timeoutSeconds, c.maxBlocks];
  if (c.editFiles) parts.push(c.editFiles);
  return sha256(JSON.stringify(parts));
}

// ---- files --------------------------------------------------------------------------------------

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// changed.txt is a newline list, not JSON; written the same way (temp file plus rename).
function writeTextAtomic(path, text) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`);
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// ---- local spawn and lock (cli.mjs run, and handlers run in process) ----------------------------

export function localSpawn(argv, { cwd, env, timeoutMs, signal, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnChild(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    let truncated = false;
    const keep = (k) => (chunk) => {
      out[k].push(chunk);
      size[k] += chunk.length;
      while (size[k] > maxBytes) {
        truncated = true;
        const first = out[k][0];
        const excess = size[k] - maxBytes;
        if (first.length <= excess) {
          out[k].shift();
          size[k] -= first.length;
        } else {
          out[k][0] = first.subarray(excess);
          size[k] -= excess;
        }
      }
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    const pgid = child.pid;
    let timedOut = false;
    const term = () => {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {}
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            term();
          }, timeoutMs)
        : null;
    if (signal?.aborted) term();
    else signal?.addEventListener('abort', term, { once: true });
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', term);
    };
    child.on('error', (err) => {
      if (!done) {
        finish();
        reject(err);
      }
    });
    child.on('close', (code, sig) => {
      if (done) return;
      finish();
      resolve({
        code,
        signal: sig,
        pgid,
        timedOut,
        truncated,
        stdout: Buffer.concat(out.stdout).toString('utf8'),
        stderr: Buffer.concat(out.stderr).toString('utf8'),
      });
    });
  });
}

export const localLock = Object.freeze({
  async acquire(dir) {
    const h = acquireGateLock(dir);
    return h && { release: async () => h.release() };
  },
});

// Polls the lock every `pollMs` until `until`; null if it never came free.
export async function waitLock(lock, dir, until, { pollMs = POLL_MS, signal } = {}) {
  mkdirSync(dir, { recursive: true });
  for (;;) {
    const held = await lock.acquire(dir);
    if (held) return held;
    const left = until - Date.now();
    if (left <= 0 || signal?.aborted) return null;
    await sleep(Math.min(pollMs, left));
  }
}

// ---- failure identity ---------------------------------------------------------------------------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function pathVariants(p) {
  const out = new Set();
  if (typeof p === 'string' && p) out.add(p.replace(/\/+$/, ''));
  try {
    out.add(realpathSync(p));
  } catch {}
  return [...out].filter((v) => v && v !== '/').sort((a, b) => b.length - a.length);
}

export function normalizeTail(tail, repoRoot) {
  let t = String(tail ?? '');
  for (const r of pathVariants(repoRoot)) t = t.split(r).join('<root>');
  t = t.replace(/\b\w*(duration|time)\w*[:=]?\s*\d+(\.\d+)?/gi, '<dur>');
  for (const d of pathVariants(tmpdir()))
    t = t.replace(new RegExp(`${esc(d)}(?:/[^\\s'"\`,;)\\]]*)?(?![\\w.-])`, 'g'), '<tmp>');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>');
  t = t.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>');
  t = t.replace(/\b\d+(\.\d+)?\s?(ms|s|sec|m)\b/g, '<dur>');
  t = t.replace(/\b0x[0-9a-f]+\b/gi, '<hex>');
  t = t.replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>');
  return t;
}

export function failureKey({ argv, exitKind, code, signal, tail }, repoRoot) {
  return sha256(
    [
      (argv ?? []).map(String).join('\0'),
      String(exitKind ?? ''),
      String(code ?? ''),
      String(signal ?? ''),
      normalizeTail(tail, repoRoot),
    ].join('\0\0'),
  );
}

function how(run, cfg) {
  switch (run.exitKind) {
    case 'spawn-error':
      return run.spawnError;
    case 'timeout':
      return `timed out after ${cfg.timeoutSeconds} s or the hook deadline`;
    case 'signal':
      return `killed by ${run.signal}`;
    case 'aborted':
      return 'aborted at the hook deadline';
    default:
      return `exit code ${run.code}`;
  }
}

// ---- the charge ledger (blocks.json in the session folder under the git common dir) -------------
// Decided under the gate lock. The ledger has its own short lock, so `ack` and `release` never wait
// for a long run.

const LEDGER_POLL_MS = 20;
const LEDGER_WAIT_MS = 2000;
const readLedger = (dir) => {
  const v = readJson(join(dir, 'blocks.json'));
  return v && Array.isArray(v.charges) ? { version: 1, charges: v.charges } : { version: 1, charges: [] };
};

async function withLedger(lock, dir, fn, until = Date.now() + LEDGER_WAIT_MS) {
  const held = await waitLock(lock, join(dir, 'ledger'), until, { pollMs: LEDGER_POLL_MS });
  if (!held) return undefined;
  try {
    const ledger = readLedger(dir);
    const r = fn(ledger);
    if (r?.write) writeJsonAtomic(join(dir, 'blocks.json'), ledger);
    return r?.value;
  } finally {
    await held.release();
  }
}

// -> {charged: true, n, id} | {charged: false, limit}
export async function chargeBlock({ lock, sessionDir, key, max }) {
  const r = await withLedger(lock, sessionDir, (ledger) => {
    const n = ledger.charges.filter((c) => c.key === key).length;
    if (n >= max) return { value: { charged: false, limit: max } };
    if (ledger.charges.length >= SESSION_BLOCKS) return { value: { charged: false, limit: SESSION_BLOCKS } };
    const id = randomUUID();
    ledger.charges.push({ id, key, confirmed: false });
    return { write: true, value: { charged: true, n: n + 1, id } };
  });
  return r ?? { charged: false, limit: max, busy: true };
}

export const confirmCharge = ({ lock, sessionDir, id }) =>
  withLedger(lock, sessionDir, (ledger) => {
    const c = ledger.charges.find((x) => x.id === id);
    if (!c || c.confirmed) return null;
    c.confirmed = true;
    return { write: true };
  });

export const refundCharge = ({ lock, sessionDir, id }) =>
  withLedger(lock, sessionDir, (ledger) => {
    const i = ledger.charges.findIndex((x) => x.id === id);
    if (i < 0) return null;
    ledger.charges.splice(i, 1);
    return { write: true };
  });

// ---- the run ------------------------------------------------------------------------------------

const keysEqual = (a, b) => a && b && a.tree === b.tree && a.stat === b.stat;

// -> {status: 'skipped'|'passed'|'failed'|'contended', text, detail?, tail?, failure?, ...onFailure()}
// `tail` is set on a pass too: the captured output of the run, which may be ''.
// `stateDir` is the tool's state folder (lock, private index, records). `onFailure(failure)` runs
// under the gate lock, so its decision is serialized with every other run.
export async function runGate({
  repoRoot,
  trigger,
  file,
  config,
  stateDir,
  signal,
  deadline,
  spawn = localSpawn,
  lock = localLock,
  cleanupDeadline,
  onFailure,
  contentKey = defaultContentKey,
  changedFiles = defaultChangedFiles,
  runCommand = defaultRunCommand,
}) {
  const cfg = resolveConfig(config);
  const until = Number.isFinite(deadline) ? deadline : Infinity;
  const held = await waitLock(lock, stateDir, until, { signal });
  if (!held) return { status: 'contended', text: CONTENDED };
  const cmd = cfg.command.join(' ');
  try {
    const key = await contentKey({ repoRoot, stateDir, spawn, signal });
    const hash = configHash(cfg);
    const passFile = join(stateDir, 'pass.json');
    const pass = readJson(passFile);
    if (pass && keysEqual(pass, key) && pass.config === hash) return { status: 'skipped', text: '' };

    const lastStat = readJson(join(stateDir, 'pass-stat.json'));
    const changed = await changedFiles({
      repoRoot,
      baseRef: cfg.base,
      stateDir,
      statMap: key.statMap,
      lastStatMap: lastStat?.stats ?? null,
      spawn,
      signal,
    });
    const changedPath = join(stateDir, 'changed.txt');
    writeTextAtomic(changedPath, changed.files.map((f) => `${f}\n`).join(''));
    const env = {
      VERIFY_TRIGGER: trigger,
      VERIFY_BASE: changed.base,
      VERIFY_CHANGED_FILES: changedPath,
      VERIFY_FILE: trigger === 'edit' ? file : undefined, // undefined unsets an inherited value
    };
    const run = await runCommand({
      spawn,
      argv: cfg.command,
      cwd: repoRoot,
      env,
      timeoutMs: cfg.timeoutSeconds * 1000,
      signal,
      deadline,
      cleanupDeadline,
    });
    // An aborted run (the handler's deadline) touches no record; its result is discarded anyway.
    if (signal?.aborted || run.exitKind === 'aborted')
      return { status: 'failed', aborted: true, text: `verify: ${cmd} was aborted.` };
    const full = trigger !== 'edit';
    if (run.exitKind === 'exit' && run.code === 0) {
      if (full) {
        const afterKey = await contentKey({ repoRoot, stateDir, spawn, signal });
        if (!signal?.aborted && keysEqual(afterKey, key)) {
          writeJsonAtomic(join(stateDir, 'pass-stat.json'), { version: 1, stats: Object.fromEntries(key.statMap) });
          writeJsonAtomic(passFile, { version: 1, tree: key.tree, stat: key.stat, config: hash, trigger });
        }
      }
      return { status: 'passed', text: '', tail: run.tail };
    }
    if (full) rmSync(passFile, { force: true });
    const tail = run.tail || run.spawnError || '';
    const failure = { argv: cfg.command, exitKind: run.exitKind, code: run.code, signal: run.signal, tail };
    const detail = how(run, cfg);
    const extra = onFailure ? await onFailure(failure) : {};
    return {
      status: 'failed',
      text: `verify: ${cmd} failed (${detail}).${tail ? `\n\n${tail}` : ''}`,
      detail,
      tail,
      failure,
      ...extra,
    };
  } finally {
    await held.release();
  }
}

// ---- the verify-pass proof ----------------------------------------------------------------------

export async function verifyPass({
  repoRoot,
  config,
  stateDir,
  spawn = localSpawn,
  lock = localLock,
  signal,
  deadline,
  contentKey = defaultContentKey,
}) {
  const until = Math.min(Date.now() + PROOF_WAIT_MS, Number.isFinite(deadline) ? deadline - 500 : Infinity);
  const held = await waitLock(lock, stateDir, until, { signal });
  if (!held) return PROOF.running;
  try {
    const pass = readJson(join(stateDir, 'pass.json'));
    if (!pass) return PROOF.none;
    if (pass.config !== configHash(config)) return PROOF.config;
    const key = await contentKey({ repoRoot, stateDir, spawn, signal });
    return keysEqual(pass, key) ? null : PROOF.content;
  } finally {
    await held.release();
  }
}
