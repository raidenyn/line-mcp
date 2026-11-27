// Generated from src/hook-runtime/lib/runtime.mts by scripts/build.mts. Do not edit.
// Dispatch, deadlines, fail-open, result merging, handler loading and proofs (design D2, D3).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHarnessConfig } from './config.mjs';
import { checkTool, readLock } from './install.mjs';
import { sessionStateDir, toolStateDir } from './state.mjs';
import { startWorker } from './supervisor.mjs';

export const EVENTS = Object.freeze(['tool.before', 'tool.after', 'prompt', 'turn.end', 'compact', 'session.start']);
export const RESULT_KINDS = Object.freeze({
  'tool.before': ['deny'],
  'tool.after': ['context'],
  prompt: ['context'],
  'session.start': ['context'],
  compact: [],
  'turn.end': ['block', 'context'],
});
export const DEFAULT_DEADLINE_MS = 5000;
export const CLEANUP_MS = 6000;
export const OUTPUT_MS = 1000;
export const LOAD_BUDGET_MS = 2000;

const KINDS = ['deny', 'block', 'context'];
const TOOL_KINDS = ['shell', 'edit', 'read', 'other'];
const JOIN = '\n\n';
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once above this
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMER_MS) : undefined);

// With AGENT_HARNESS_TRACE=1, one JSON line per dispatched event in
// <hook-runtime state>/trace.jsonl (design D7): {event, processStart, hostCreatedAt?, receivedAt,
// handlersLoadedAt, settledAt, outcomes}. A skipped call has skipped? instead of handlersLoadedAt.
// Never throws.
export function writeTrace(repoRoot, record, env = process.env) {
  if (env.AGENT_HARNESS_TRACE !== '1') return;
  try {
    const dir = toolStateDir(repoRoot, 'hook-runtime');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'trace.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {}
}

export function failureNotice(name, event, reason, manual) {
  const r = String(reason ?? 'unknown error').replace(/[.\s]+$/, '');
  return `hook ${name} failed on ${event}: ${r}.${manual ? ` ${manual}` : ' Do this step by hand.'}`;
}

// A referenced timer (never unref): a handler whose promise never settles cannot let Node exit early.
function timer(ms) {
  let id;
  const p = new Promise((resolve) => {
    id = setTimeout(resolve, Math.max(0, ms));
  });
  return { p, clear: () => clearTimeout(id) };
}

const TIMED_OUT = Symbol('timed out');

// Resolves to the promise's value, or TIMED_OUT once `until` passes.
async function within(promise, until, now) {
  if (!Number.isFinite(until)) return promise;
  const t = timer(until - now());
  try {
    return await Promise.race([promise, t.p.then(() => TIMED_OUT)]);
  } finally {
    t.clear();
  }
}

function validate(result, type) {
  if (result === null || result === undefined) return { kind: null };
  if (!isObject(result)) return { error: 'returned an invalid result' };
  const kinds = KINDS.filter((k) => result[k] !== undefined);
  if (kinds.length !== 1)
    return { error: `returned an invalid result (${kinds.length ? kinds.join(' and ') : 'no result kind'})` };
  const [kind] = kinds;
  if (!RESULT_KINDS[type].includes(kind)) return { error: `returned ${kind}, which ${type} does not accept` };
  if (typeof result[kind] !== 'string') return { error: `returned a ${kind} that is not text` };
  const out = { kind, text: result[kind] };
  if (kind === 'block' || kind === 'context') {
    if (typeof result.stale === 'string') out.stale = result.stale;
  }
  if (kind === 'block') {
    if (typeof result.ack === 'function') out.ack = result.ack;
    if (typeof result.release === 'function') out.release = result.release;
  }
  return out;
}

function callQuietly(fn) {
  try {
    return Promise.resolve(fn()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

const toolOf = (h) => h.tool ?? h.name;

// The tool kinds a handler tool declared in its tool.json `tools` key, or null for every kind.
// Anything malformed (missing, not an array, empty, an unknown kind) means every kind.
export function declaredKinds(meta) {
  if (!isObject(meta)) return null;
  const tools = meta.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const kinds = [];
  for (const kind of tools) {
    if (!TOOL_KINDS.includes(kind)) return null;
    kinds.push(kind);
  }
  return kinds;
}

// Whether any installed handler tool could want a tool call of this kind (design D2). A missing or
// unreadable lock, tool.json or `tools` list means every kind, so the caller loads handlers instead
// of skipping. Returns false only when every handler tool provably excludes the kind.
export function anyHandlerWants(repoRoot, kind) {
  let lock;
  try {
    lock = readLock(repoRoot);
  } catch {
    return true;
  }
  for (const name of Object.keys(lock.tools)) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(repoRoot, '.agents', 'harness', name, 'tool.json'), 'utf8'));
    } catch {
      return true;
    }
    if (!isObject(meta) || meta.handler !== true) continue;
    const kinds = declaredKinds(meta);
    if (!kinds || kinds.includes(kind)) return true;
  }
  return false;
}

export function createRuntime({ repoRoot, host, handlers = [], problems = [], now = Date.now, budgetMs } = {}) {
  const sorted = [...handlers].sort(byName);

  function stateDirFor(handler, { sessionId, agentId }) {
    return sessionStateDir({ repoRoot, tool: toolOf(handler), host, sessionId, agentId });
  }

  async function proof(name, ctx = {}) {
    const owner = sorted.find(
      (h) => isObject(h.proofs) && Object.hasOwn(h.proofs, name) && typeof h.proofs[name] === 'function',
    );
    if (!owner) return `proof ${name} is not registered`;
    const deadline = ctx.deadline ?? now() + DEFAULT_DEADLINE_MS;
    let config = {};
    try {
      config = readHarnessConfig(repoRoot)[toolOf(owner)] ?? {};
    } catch {}
    // The proof's own signal aborts at its deadline, also when the caller passed none.
    const controller = new AbortController();
    const forward = () => controller.abort(ctx.signal.reason);
    if (ctx.signal?.aborted) forward();
    else ctx.signal?.addEventListener('abort', forward, { once: true });
    const ownerCtx = {
      ...ctx,
      repoRoot,
      host,
      deadline,
      config,
      signal: controller.signal,
      trace() {},
    };
    ownerCtx.proof = (n) => proof(n, ownerCtx);
    try {
      ownerCtx.stateDir = stateDirFor(owner, ctx);
      const value = await within(Promise.resolve(owner.proofs[name](ownerCtx)), deadline, now);
      if (value === TIMED_OUT) {
        controller.abort(new Error('deadline'));
        return `proof ${name} timed out`;
      }
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') return `proof ${name} returned an invalid value`;
      return value;
    } catch (err) {
      return `proof ${name} failed: ${errText(err)}`;
    } finally {
      ctx.signal?.removeEventListener('abort', forward);
    }
  }

  async function runHandler(handler, event, opts) {
    const { workDeadline, deadlines, config, hostDeadline } = opts;
    const type = event.type;
    const budget = positive(handler.timeouts?.[type]) ?? positive(deadlines?.[type]) ?? DEFAULT_DEADLINE_MS;
    const t0 = now();
    const deadline = Math.min(t0 + budget, workDeadline);
    const cleanupDeadline = hostDeadline !== undefined ? hostDeadline - OUTPUT_MS : deadline + CLEANUP_MS - OUTPUT_MS;
    const controller = new AbortController();
    let open = true;
    let traced;
    const ctx = {
      repoRoot,
      host,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      deadline,
      signal: controller.signal,
      stateDir: undefined,
      config: config[toolOf(handler)] ?? {},
      proof: (name) => proof(name, ctx),
      trace: (outcome) => {
        if (open) traced = String(outcome);
      },
    };
    const fail = (reason) => ({
      failure: failureNotice(handler.name, type, reason, handler.manual),
      outcome: 'failed',
    });

    let pending;
    try {
      ctx.stateDir = stateDirFor(handler, opts);
      pending = Promise.resolve(handler.handle(structuredClone(event), ctx, { cleanupDeadline }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    const settled = pending.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const t = timer(deadline - now());
    const first = await Promise.race([settled, t.p.then(() => null)]);
    t.clear();
    open = false;

    if (first === null || now() > deadline) {
      controller.abort(new Error('deadline'));
      // The cleanup the abort starts is awaited separately; a late block is released, never delivered.
      const cleanup = settled.then((r) => {
        if (r.ok && isObject(r.value) && r.value.block !== undefined && typeof r.value.release === 'function') {
          return callQuietly(r.value.release);
        }
        return undefined;
      });
      return {
        ...fail(`timed out after ${Math.max(0, Math.round(deadline - t0))} ms`),
        cleanup,
        cleanupDeadline,
        spent: deadline >= workDeadline,
      };
    }
    if (!first.ok) return fail(errText(first.error));
    const v = validate(first.value, type);
    if (v.error) {
      if (isObject(first.value) && typeof first.value.release === 'function') callQuietly(first.value.release);
      return fail(v.error);
    }
    return { result: v.kind ? v : null, outcome: traced ?? (v.kind ? 'result' : 'null') };
  }

  async function dispatch(event, { sessionId, agentId, hostDeadline, workDeadline: wd } = {}) {
    const type = event?.type;
    const notices = [...problems];
    const outcomes = {};
    if (!EVENTS.includes(type)) {
      notices.push(`hook-runtime: unknown event ${JSON.stringify(type)} was ignored.`);
      return { notices, outcomes };
    }
    const start = now();
    const workDeadline = Math.min(positive(budgetMs) !== undefined ? start + budgetMs : Infinity, wd ?? Infinity);
    let config = {};
    let configError;
    try {
      config = readHarnessConfig(repoRoot);
    } catch (err) {
      configError = errText(err);
    }
    const deadlines = isObject(config['hook-runtime']?.deadlines) ? config['hook-runtime'].deadlines : {};
    const texts = { deny: [], block: [], context: [] };
    const staleTexts = [];
    const acks = [];
    const releases = [];
    const cleanups = [];
    let cleanupUntil = -Infinity;
    let spent = false; // a timer can fire a little before Date.now() reaches its moment

    for (const handler of sorted.filter((h) => Array.isArray(h.events) && h.events.includes(type))) {
      // Only tool events read `tools` at all, so an unrelated dispatch never touches the key.
      if (type === 'tool.before' || type === 'tool.after') {
        // Validate on every tool dispatch so an in-process `tools: []` or an unknown kind means every kind.
        const kinds = declaredKinds(handler);
        if (kinds && !kinds.includes(event.tool?.kind ?? 'other')) continue;
      }
      if (configError || spent || now() >= workDeadline) {
        const reason = configError ?? "skipped, the event's time budget was used up";
        notices.push(failureNotice(handler.name, type, reason, handler.manual));
        outcomes[handler.name] = 'skipped';
        continue;
      }
      const r = await runHandler(handler, event, {
        workDeadline,
        deadlines,
        config,
        hostDeadline,
        sessionId,
        agentId,
      });
      outcomes[handler.name] = r.outcome;
      if (r.failure) notices.push(r.failure);
      if (r.spent) spent = true;
      if (r.cleanup) {
        cleanups.push(r.cleanup);
        cleanupUntil = Math.max(cleanupUntil, r.cleanupDeadline);
      }
      if (r.result) {
        texts[r.result.kind].push(r.result.text);
        if (r.result.stale !== undefined) staleTexts.push(r.result.stale);
        if (r.result.ack) acks.push(r.result.ack);
        if (r.result.release) releases.push(r.result.release);
      }
    }

    if (cleanups.length) await within(Promise.allSettled(cleanups), cleanupUntil, now);

    const out = { notices, outcomes };
    if (texts.deny.length) out.deny = texts.deny.join(JOIN);
    if (texts.block.length) out.block = texts.block.join(JOIN);
    if (texts.context.length && !out.deny) out.context = texts.context.join(JOIN);
    if (staleTexts.length) out.stale = staleTexts.join(JOIN);
    if (acks.length)
      out.ack = async () => {
        for (const fn of acks) await callQuietly(fn);
      };
    if (releases.length)
      out.release = async () => {
        for (const fn of releases) await callQuietly(fn);
      };
    return out;
  }

  // A failing close does not skip the others; the caller gets no error, because there is nothing
  // useful left to do once a handler's worker is gone.
  async function close(opts = {}) {
    const closers = sorted.filter((h) => typeof h.close === 'function').map((h) => callQuietly(() => h.close(opts)));
    await Promise.allSettled(closers);
  }

  return { dispatch, proof, close, handlers: sorted, problems };
}

export async function loadHandlers(repoRoot, { loadBudgetMs = LOAD_BUDGET_MS } = {}) {
  const notLoaded = (name, reason) =>
    `hook ${name} was not loaded: ${String(reason).replace(/[.\s]+$/, '')}. Do this step by hand.`;
  let lock;
  try {
    lock = readLock(repoRoot);
  } catch (err) {
    return { handlers: [], problems: [notLoaded('hook-runtime', errText(err))] };
  }
  const results = await Promise.all(
    Object.keys(lock.tools)
      .sort()
      .map(async (name) => {
        const toolDir = join(repoRoot, '.agents', 'harness', name);
        let meta;
        try {
          meta = JSON.parse(readFileSync(join(toolDir, 'tool.json'), 'utf8'));
        } catch (err) {
          return { problem: notLoaded(name, `cannot read tool.json (${errText(err)})`) };
        }
        if (meta?.handler !== true) return null;
        const issues = checkTool({ toolDir, repoRoot });
        if (issues.length) return { problem: notLoaded(name, `its copy differs from the lock: ${issues.join('; ')}`) };
        try {
          const handler = await startWorker(toolDir, { loadBudgetMs, tool: name });
          // tool.json is the only source of `tools`; a `tools` export in handler.mjs is ignored.
          const kinds = declaredKinds(meta);
          if (kinds) handler.tools = kinds;
          return { handler };
        } catch (err) {
          return { problem: notLoaded(name, errText(err)) };
        }
      }),
  );
  return {
    handlers: results.filter((r) => r?.handler).map((r) => r.handler),
    problems: results.filter((r) => r?.problem).map((r) => r.problem),
  };
}
