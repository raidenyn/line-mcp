// Generated from src/hook-runtime/lib/supervisor.mts by scripts/build.mts. Do not edit.
// The supervisor (design D3): each handler runs in worker_threads Workers (a pool of up to 4 per
// handler). The supervisor owns everything that outlives JavaScript: it spawns processes in their own
// groups and holds gate locks on a worker's behalf, and when a worker generation ends it kills that
// generation's groups (SIGTERM, then SIGKILL, until empty) and only then releases its locks.
import { spawn as spawnChild } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { acquireGateLock, staleGroups, updateGateLock } from './state.mjs';

const ENTRY = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url));
export const POOL_SIZE = 4;
export const KILL_AFTER_MS = 5000;
export const REAP_MAX_AGE_MS = 86_400_000;
const POLL_MS = 25;
const CONFIRM_MS = 5000;

let genCounter = 0;
let idCounter = 0;
const generations = new Map();

const errText = (err) => (err instanceof Error ? err.message : String(err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function signalGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
  } catch {}
}

// SIGTERM, then SIGKILL after min(5 s, cleanupDeadline - now - 1 s); resolves once every group is
// empty, independent of the leaders' exits. With confirmUntil the wait ends at that time and
// SIGKILL is always sent before returning, because the caller cannot wait for the confirmation
// window (the reap at lock acquisition).
export async function killGroups(pgids, { cleanupDeadline, confirmUntil } = {}) {
  let live = pgids.filter(groupAlive);
  if (!live.length) return;
  for (const p of live) signalGroup(p, 'SIGTERM');
  const room = Number.isFinite(cleanupDeadline) ? cleanupDeadline - Date.now() - 1000 : KILL_AFTER_MS;
  const killAt = Date.now() + Math.max(0, Math.min(KILL_AFTER_MS, room));
  const confirm = Number.isFinite(confirmUntil) ? confirmUntil : undefined;
  const end = confirm ?? killAt + CONFIRM_MS;
  let killed = false;
  while (live.length && Date.now() < end) {
    await sleep(POLL_MS);
    if (!killed && Date.now() >= killAt) {
      for (const p of live) signalGroup(p, 'SIGKILL');
      killed = true;
    }
    live = live.filter(groupAlive);
  }
  if (confirm !== undefined && !killed) {
    live = live.filter(groupAlive);
    for (const p of live) signalGroup(p, 'SIGKILL');
  }
}

// Resolves with the promise, or rejects once `signal` aborts. Checks `aborted` before listening,
// because a listener added to an already aborted signal never fires.
function untilAborted(promise, signal, message) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(message));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function contextData(ctx) {
  const { repoRoot, host, sessionId, agentId, deadline, stateDir, config } = ctx;
  return { repoRoot, host, sessionId, agentId, deadline, stateDir, config };
}

class WorkerRecord {
  constructor(pool, budgetMs) {
    this.pool = pool;
    this.gen = ++genCounter;
    this.loaded = false;
    this.dead = false;
    this.busy = null; // requestId of the running event, 'reserved', or null
    this.pending = new Map(); // key -> {requestId, kind, ctx, resolve, reject}
    this.groups = new Map(); // pgid -> requestId
    this.locks = new Map(); // lockId -> {handle, requestId, pgids}
    this.children = new Map(); // callId -> pgid
    generations.set(this.gen, this);
    this.worker = new Worker(ENTRY, {
      workerData: { handlerPath: join(pool.toolDir, 'handler.mjs'), workerGen: this.gen },
      stdout: true,
      stderr: true,
    });
    // Handler output must never reach the host's stdout (Claude Code reads hook JSON there).
    const toStderr = (d) => {
      try {
        process.stderr.write(d);
      } catch {}
    };
    this.worker.stdout.on('data', toStderr);
    this.worker.stderr.on('data', toStderr);
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => {
          reject(new Error(`still loading after ${budgetMs} ms`));
          this.retire('load timeout');
        },
        Math.max(0, budgetMs),
      );
      this.onLoad = (err, meta) => {
        clearTimeout(t);
        this.onLoad = null;
        if (err) {
          reject(err);
          this.retire('load failed');
        } else {
          this.loaded = true;
          resolve(meta);
        }
      };
    });
    this.ready.catch(() => {});
    this.worker.on('message', (msg) => this.onMessage(msg));
    this.worker.on('error', (err) => this.crash(err));
    this.worker.on('exit', (code) => this.crash(new Error(`worker exited (code ${code})`)));
  }

  post(msg) {
    if (this.dead) return;
    try {
      this.worker.postMessage({ workerGen: this.gen, ...msg });
    } catch {}
  }

  refresh() {
    if (this.dead) return;
    if (this.pending.size || this.busy !== null || !this.loaded) this.worker.ref();
    else this.worker.unref();
  }

  isActive(requestId) {
    if (this.dead) return false;
    for (const p of this.pending.values()) if (p.requestId === requestId) return true;
    return false;
  }

  request(kind, requestId, ctx, msg) {
    return new Promise((resolve, reject) => {
      this.pending.set(`${kind}:${requestId}`, { requestId, kind, ctx, resolve, reject });
      this.refresh();
      if (this.dead) return;
      try {
        this.worker.postMessage({ workerGen: this.gen, ...msg, requestId });
      } catch (err) {
        this.pending.delete(`${kind}:${requestId}`);
        this.refresh();
        reject(new Error(`could not be sent to the worker (${errText(err)})`));
      }
    });
  }

  finish(kind, requestId) {
    const key = `${kind}:${requestId}`;
    const p = this.pending.get(key);
    this.pending.delete(key);
    const owns =
      [...this.locks.values()].some((l) => l.requestId === requestId) || [...this.groups.values()].includes(requestId);
    if (!this.isActive(requestId) && owns) {
      this.cleanup({ requestId }).catch(() => {});
    }
    return p;
  }

  onMessage(msg) {
    if (!msg || msg.workerGen !== this.gen || this.dead) return; // foreign or late
    const { type, requestId, callId } = msg;
    switch (type) {
      case 'loaded':
        return this.onLoad?.(null, msg.meta);
      case 'load-error':
        return this.onLoad?.(new Error(msg.error));
      case 'result': {
        if (this.busy !== requestId) return;
        const p = this.finish('event', requestId);
        this.busy = null;
        this.refresh();
        this.pool.wake();
        if (!p) return;
        if (!msg.ok) return p.reject(new Error(msg.error));
        const result = msg.result;
        if (result && typeof result === 'object') {
          if (msg.hasAck) result.ack = () => this.blockCallback('ack', requestId);
          if (msg.hasRelease) result.release = () => this.blockCallback('release', requestId);
        }
        return p.resolve(result);
      }
      case 'proof.result':
      case 'acked':
      case 'released': {
        const kind = type === 'proof.result' ? 'proof' : type === 'acked' ? 'ack' : 'release';
        const p = this.finish(kind, requestId);
        this.refresh();
        if (!p) return;
        return msg.ok ? p.resolve(msg.value ?? null) : p.reject(new Error(msg.error));
      }
      case 'trace': {
        const p = this.pending.get(`event:${requestId}`);
        if (p && this.busy === requestId) p.ctx.trace?.(msg.outcome);
        return;
      }
      case 'proof.request':
        return this.onProofRequest(msg);
      case 'spawn':
        return this.onSpawn(msg);
      case 'spawn.kill': {
        const pgid = this.children.get(callId);
        if (pgid) killGroups([pgid]).catch(() => {});
        return;
      }
      case 'lock.acquire':
        return this.onLockAcquire(msg);
      case 'lock.release':
        return this.onLockRelease(msg);
      default:
    }
  }

  onProofRequest({ requestId, callId, name }) {
    const reply = (value) => this.post({ type: 'proof.response', requestId, callId, value });
    const p = [...this.pending.values()].find((x) => x.requestId === requestId && x.ctx?.proof);
    if (!p) return reply(`proof ${name} was requested after its event ended`);
    Promise.resolve()
      .then(() => p.ctx.proof(name))
      .then(
        (v) => reply(v ?? null),
        (err) => reply(`proof ${name} failed: ${errText(err)}`),
      );
  }

  onSpawn({ requestId, callId, argv, cwd, env, timeoutMs }) {
    const reply = (m) => this.post({ type: 'spawn.exit', requestId, callId, ...m });
    if (!this.isActive(requestId)) return reply({ error: 'the event has ended' });
    let child;
    try {
      child = spawnChild(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reply({ error: errText(err) });
    }
    let done = false;
    const end = (m) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      this.children.delete(callId);
      if (pgid && !groupAlive(pgid)) this.groups.delete(pgid);
      reply(m);
    };
    const pgid = child.pid;
    let timedOut = false;
    let timeout;
    if (pgid) {
      this.groups.set(pgid, requestId);
      this.children.set(callId, pgid);
      for (const lock of this.locks.values()) {
        lock.pgids.push(pgid);
        try {
          updateGateLock(lock.handle, { pgids: lock.pgids });
        } catch {}
      }
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          killGroups([pgid]).catch(() => {});
        }, timeoutMs);
      }
    }
    child.stdout.on('data', (chunk) =>
      this.post({ type: 'spawn.data', requestId, callId, stream: 'stdout', chunk: new Uint8Array(chunk) }),
    );
    child.stderr.on('data', (chunk) =>
      this.post({ type: 'spawn.data', requestId, callId, stream: 'stderr', chunk: new Uint8Array(chunk) }),
    );
    child.on('error', (err) => end({ error: errText(err), pgid }));
    child.on('close', (code, signal) => end({ code, signal, pgid, timedOut }));
  }

  // Reap the groups a dead holder recorded before taking the gate lock (design D3): SIGTERM, then
  // SIGKILL by this event's deadline. The reply is asynchronous, so an ended event is checked again
  // after the reap; every throw is replied, because onMessage does not catch this promise.
  async onLockAcquire({ requestId, callId, dir }) {
    const reply = (m) => this.post({ type: 'lock.response', requestId, callId, ...m });
    try {
      if (!this.isActive(requestId)) return reply({ error: 'the event has ended' });
      const stale = staleGroups(dir, { maxAgeMs: REAP_MAX_AGE_MS }).filter((pgid) => {
        try {
          process.kill(-pgid, 0);
          return true;
        } catch {
          return false; // gone (ESRCH) or not ours (EPERM)
        }
      });
      if (stale.length) {
        const holder = [...this.pending.values()].find((p) => p.requestId === requestId && p.ctx);
        const deadline = holder?.ctx?.deadline;
        const cleanupDeadline = Number.isFinite(deadline) ? deadline : Date.now() + 2000;
        await killGroups(stale, { cleanupDeadline, confirmUntil: cleanupDeadline });
        if (this.dead || !this.isActive(requestId)) return reply({ error: 'the event has ended' });
        if (stale.some(groupAlive)) return reply({ lockId: null });
      }
      let handle;
      try {
        handle = acquireGateLock(dir);
      } catch (err) {
        return reply({ error: errText(err) });
      }
      if (!handle) return reply({ lockId: null });
      const lockId = ++idCounter;
      this.locks.set(lockId, { handle, requestId, pgids: [] });
      return reply({ lockId });
    } catch (err) {
      return reply({ error: errText(err) });
    }
  }

  onLockRelease({ requestId, callId, lockId }) {
    const lock = this.locks.get(lockId);
    this.locks.delete(lockId);
    let error;
    try {
      lock?.handle.release();
    } catch (err) {
      error = errText(err);
    }
    this.post({ type: 'lock.released', requestId, callId, error });
  }

  blockCallback(kind, requestId) {
    if (this.dead) return Promise.resolve(false);
    return this.request(kind, requestId, null, { type: kind }).then(
      () => true,
      () => false,
    );
  }

  // Kill the groups this generation started (optionally one request's), then release its locks.
  async cleanup({ requestId, cleanupDeadline } = {}) {
    const mine = (r) => requestId === undefined || r === requestId;
    const pgids = [...this.groups].filter(([, r]) => mine(r)).map(([p]) => p);
    await killGroups(pgids, { cleanupDeadline });
    const survivors = new Set(pgids.filter(groupAlive));
    for (const p of pgids) if (!survivors.has(p)) this.groups.delete(p);
    for (const [id, lock] of this.locks) {
      if (!mine(lock.requestId)) continue;
      // A group that survived SIGKILL (a process stuck in the kernel) keeps its lock held: the lock
      // is never released before its groups are gone (design D3).
      if (lock.pgids.some((p) => survivors.has(p))) continue;
      this.locks.delete(id);
      try {
        lock.handle.release();
      } catch {}
    }
  }

  // End this generation: terminate, kill its groups, release its locks, fail what is pending.
  retire(reason, { cleanupDeadline } = {}) {
    if (this.retiring) return this.retiring;
    this.dead = true;
    this.pool.remove(this);
    this.retiring = (async () => {
      try {
        await this.worker.terminate();
      } catch {}
      await this.cleanup({ cleanupDeadline });
      generations.delete(this.gen);
      for (const p of this.pending.values()) p.reject(new Error(`worker ended: ${reason}`));
      this.pending.clear();
      this.onLoad?.(new Error(`worker ended: ${reason}`));
      this.pool.wake();
    })();
    return this.retiring;
  }

  crash(err) {
    if (!this.dead) this.retire(errText(err)).then(() => this.pool.replenish());
  }
}

export function terminateWorker(gen, opts) {
  const rec = generations.get(gen);
  return rec ? rec.retire('terminated', opts) : Promise.resolve();
}

class HandlerPool {
  constructor(toolDir, tool, loadBudgetMs) {
    this.toolDir = toolDir;
    this.tool = tool;
    this.loadBudgetMs = loadBudgetMs;
    this.workers = [];
    this.waiters = [];
    this.closed = false;
  }

  spawnWorker(budgetMs = this.loadBudgetMs) {
    const rec = new WorkerRecord(this, budgetMs);
    this.workers.push(rec);
    return rec;
  }

  remove(rec) {
    this.workers = this.workers.filter((w) => w !== rec);
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  replenish() {
    if (this.closed || this.workers.length) return;
    const rec = this.spawnWorker();
    rec.ready.then(
      () => rec.refresh(),
      () => {},
    );
  }

  async acquire(ctx) {
    for (;;) {
      if (this.closed) throw new Error('the handler was closed');
      if (ctx.signal?.aborted) throw new Error('no worker was free before the deadline');
      const free =
        this.workers.find((w) => !w.dead && w.busy === null && w.loaded) ??
        this.workers.find((w) => !w.dead && w.busy === null);
      const rec =
        free ??
        (this.workers.length < POOL_SIZE
          ? this.spawnWorker(Math.min(this.loadBudgetMs, (ctx.deadline ?? Infinity) - Date.now()))
          : null);
      if (rec) {
        rec.busy = 'reserved';
        rec.refresh();
        try {
          await untilAborted(rec.ready, ctx.signal, 'no worker was ready before the deadline');
        } catch (err) {
          this.unreserve(rec);
          if (ctx.signal?.aborted) throw err;
          throw new Error(`the handler did not load: ${errText(err)}`);
        }
        return rec;
      }
      await untilAborted(
        new Promise((resolve) => this.waiters.push(resolve)),
        ctx.signal,
        'no worker was free before the deadline',
      );
    }
  }

  unreserve(rec) {
    if (rec.busy !== 'reserved') return;
    rec.busy = null;
    rec.refresh();
    this.wake();
  }

  async handle(event, ctx, { cleanupDeadline } = {}) {
    const rec = await this.acquire(ctx);
    if (ctx.signal?.aborted) {
      this.unreserve(rec);
      throw new Error('no worker was ready before the deadline');
    }
    const requestId = ++idCounter;
    rec.busy = requestId;
    const onAbort = () => rec.retire('deadline', { cleanupDeadline }).then(() => this.replenish());
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await rec.request('event', requestId, ctx, { type: 'event', event, context: contextData(ctx) });
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (rec.dead) await rec.retiring;
    }
  }

  async runProof(name, ctx) {
    let rec =
      this.workers.find((w) => !w.dead && w.loaded && w.busy === null) ?? this.workers.find((w) => !w.dead && w.loaded);
    if (!rec) {
      rec = this.workers.length < POOL_SIZE ? this.spawnWorker() : this.workers[0];
      await untilAborted(rec.ready, ctx.signal, 'timed out');
    }
    if (ctx.signal?.aborted) throw new Error('timed out');
    const requestId = ++idCounter;
    const onAbort = () => {
      const p = rec.finish('proof', requestId);
      if (!p) return;
      p.reject(new Error('timed out'));
      if (rec.busy === null && !rec.pending.size) rec.retire('proof deadline').then(() => this.replenish());
      else rec.cleanup({ requestId }).catch(() => {});
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await rec.request('proof', requestId, ctx, { type: 'proof', name, context: contextData(ctx) });
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  }

  async close({ cleanupDeadline } = {}) {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.retire('closed', { cleanupDeadline })));
  }
}

// Start the first worker of a handler pool and return its proxy Handler once the worker reports
// `loaded`. Rejects when the handler is still loading after loadBudgetMs, or fails to load.
export async function startWorker(toolDir, { loadBudgetMs = 2000, tool = basename(toolDir) } = {}) {
  const pool = new HandlerPool(toolDir, tool, loadBudgetMs);
  const rec = pool.spawnWorker();
  rec.busy = 'reserved';
  let meta;
  try {
    meta = await rec.ready;
  } catch (err) {
    await rec.retire('load');
    throw err;
  }
  rec.busy = null;
  rec.refresh();
  const proofs = {};
  for (const name of meta.proofs) proofs[name] = (ctx) => pool.runProof(name, ctx);
  return {
    name: meta.name,
    tool,
    events: meta.events,
    timeouts: meta.timeouts,
    manual: meta.manual,
    proofs,
    handle: (event, ctx, internal) => pool.handle(event, ctx, internal),
    close: (opts) => pool.close(opts),
    workerGens: () => pool.workers.map((w) => w.gen),
  };
}
