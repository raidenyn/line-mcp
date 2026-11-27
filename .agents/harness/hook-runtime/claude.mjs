// Generated from src/hook-runtime/claude.mts by scripts/build.mts. Do not edit.
// Claude Code entry: one command for every hook event (design D3). It reads the hook payload from
// stdin, dispatches it to the installed handlers and prints the host's hook JSON. It exits 0 on
// every path: a hook never blocks the host on its own failure.
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilityNotice, HOST_CAPABILITIES } from './lib/capabilities.mjs';
import { CLAUDE_EVENTS, HOST, toEvent, toOutput } from './lib/claude-adapter.mjs';
import { createRuntime, failureNotice, loadHandlers, OUTPUT_MS, writeTrace } from './lib/runtime.mjs';

const HOST_MARGIN_MS = 7000; // work deadline = host deadline - 7 s (cleanup 6 s + output 1 s)
const GIT_TIMEOUT_MS = 2000;
const errText = (err) => (err instanceof Error ? err.message : String(err));

// Every runtime main() created, kept until the process exits: a signal listener may still need its
// workers for the ack or release that follows the stdout write.
const runtimes = new Set();
// The entry of another worktree of the same repository, when main() delegates to it (design D2).
let delegate = null;
let signalled = false;
// The result main() returned but runAsScript has not finished writing yet. stdout writes are
// synchronous on Linux, so it is pending until the write returns, and a signal can still arrive
// after the bytes are written; the listener releases it because delivery cannot be confirmed.
let pending = null;

// Close every runtime this process created, and the delegated copy's runtimes too. One failure does
// not skip the others; the caller only needs them settled.
export async function closeAll(opts = {}) {
  const calls = [...runtimes].map((rt) =>
    Promise.resolve()
      .then(() => rt.close(opts))
      .catch(() => {}),
  );
  if (typeof delegate?.closeAll === 'function') {
    const theirs = delegate.closeAll;
    calls.push(
      Promise.resolve()
        .then(() => theirs.call(delegate, opts))
        .catch(() => {}),
    );
  }
  await Promise.allSettled(calls);
}

// Delivers nothing more when the host signals the hook: release a result that was not written yet
// (bounded at 1 s), then close the runtimes with a 4.5 s cleanup deadline and exit 0.
export async function onSignal({ pending: undelivered, closeAll: close, exit }) {
  const release = undelivered?.release;
  if (release) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      Promise.resolve()
        .then(release)
        .catch(() => {})
        .finally(() => {
          clearTimeout(t);
          resolve();
        });
    });
  }
  await close({ cleanupDeadline: Date.now() + 4500 });
  exit(0);
}

// spawn(argv, {cwd, env, timeoutMs}) -> Promise<{code, signal, stdout, stderr, pgid}>
export function defaultSpawn(argv, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(argv[0], argv.slice(1), {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const t = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (t) clearTimeout(t);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (t) clearTimeout(t);
      resolve({ code, signal, stdout, stderr, pgid: child.pid });
    });
  });
}

// Without CLAUDE_PROJECT_DIR: the top level of the git checkout around payload.cwd, else that folder.
async function findRepoRoot(payload, { cwd, spawn }) {
  const start = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : cwd;
  try {
    const r = await spawn(['git', 'rev-parse', '--show-toplevel'], { cwd: start, timeoutMs: GIT_TIMEOUT_MS });
    const top = r.code === 0 ? r.stdout.trim() : '';
    if (top) return top;
  } catch {}
  return start;
}

// `git rev-parse --show-toplevel --git-common-dir` in dir, as real paths. No --path-format: older git
// echoes an unknown option and exits 0. The common dir prints relative in a main checkout.
async function gitDirs(dir, spawn) {
  let r;
  try {
    r = await spawn(['git', 'rev-parse', '--show-toplevel', '--git-common-dir'], {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  } catch {
    return { ok: false, exited: false };
  }
  if (r.signal || r.code === null) return { ok: false, exited: false };
  if (r.code !== 0) return { ok: false, exited: true };
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  if (lines.length !== 2) return { ok: false, exited: false };
  try {
    return {
      ok: true,
      top: realpathSync(resolve(dir, lines[0])),
      common: realpathSync(resolve(dir, lines[1])),
    };
  } catch {
    return { ok: false, exited: false };
  }
}

// The checkout this event belongs to (design D1): CLAUDE_PROJECT_DIR as given while the agent is in
// that checkout, the top level of payload.cwd when it is another worktree of the same repository,
// and `skip` when cwd is outside any checkout or in another repository. Whenever git cannot answer,
// CLAUDE_PROJECT_DIR is kept. Both git calls run in parallel, each bounded at GIT_TIMEOUT_MS.
async function resolveCheckout(payload, { cwd, env, spawn }) {
  const project = env.CLAUDE_PROJECT_DIR;
  if (!project) return { root: await findRepoRoot(payload, { cwd, spawn }) };
  const at = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : '';
  if (!at || at === project) return { root: project };
  const [here, home] = await Promise.all([gitDirs(at, spawn), gitDirs(project, spawn)]);
  if (!home.ok) return { root: project };
  if (!here.ok) return here.exited ? { skip: true } : { root: project };
  if (here.common !== home.common) return { skip: true };
  return here.top === home.top ? { root: project } : { root: spelledAs(at, here.top) };
}

// The ancestor of `at` whose real path is `top`, so a worktree reached through a symlink keeps the
// agent's spelling (edit paths are made repo-relative by string); `top` when none matches.
function spelledAs(at, top) {
  for (let dir = resolve(at); ; dir = dirname(dir)) {
    try {
      if (realpathSync(dir) === top) return dir;
    } catch {}
    if (dirname(dir) === dir) return top;
  }
}

// Resolves once fn() settles or the deadline passes, whichever is first; never rejects.
function bounded(fn, until) {
  return () =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(0, until - Date.now()));
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          clearTimeout(t);
          resolve();
        });
    });
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// main({stdin, cwd, env, spawn, now, capabilities}) -> {text, ack, release, cleanupDeadline}. `ack`
// is called once `text` was written, `release` when it could not be; both are bounded by
// cleanupDeadline.
export async function main({
  stdin,
  cwd = process.cwd(),
  env = process.env,
  spawn = defaultSpawn,
  now = Date.now,
  capabilities = HOST_CAPABILITIES,
  resolved = false,
} = {}) {
  // Keep this the first now() call: a delegating entry passes a clock whose first reading is the
  // moment it received the event.
  const start = now();
  const empty = { text: '', ack: null, release: null, cleanupDeadline: start };
  const payload = parse(String(stdin ?? ''));
  const name = payload?.hook_event_name;
  if (!Object.hasOwn(CLAUDE_EVENTS, name ?? '')) return empty;
  const hostDeadline = start + CLAUDE_EVENTS[name] * 1000;
  const cleanupDeadline = hostDeadline - OUTPUT_MS;
  let merged;
  let type = 'event';
  try {
    const found =
      resolved && env.CLAUDE_PROJECT_DIR
        ? { root: env.CLAUDE_PROJECT_DIR }
        : await resolveCheckout(payload, { cwd, env, spawn });
    if ('skip' in found) return empty;
    const repoRoot = found.root;
    const mapped = toEvent(payload, repoRoot);
    if (!mapped) return empty;
    type = mapped.event.type;
    if (env.CLAUDE_PROJECT_DIR && repoRoot !== env.CLAUDE_PROJECT_DIR) {
      // Another worktree of the same repository: its own copy handles the event (design D2).
      const entry = join(repoRoot, '.agents', 'harness', 'hook-runtime', 'claude.mjs');
      if (!existsSync(entry)) return empty;
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod.main !== 'function') throw new Error(`${entry} exports no main`);
      // The listener reaches this copy's closeAll through the module-level delegate (design D4).
      delegate = mod;
      let first = true;
      const startClock = () => {
        if (!first) return now();
        first = false;
        return start;
      };
      return await mod.main({
        stdin,
        cwd,
        env: { ...env, CLAUDE_PROJECT_DIR: repoRoot },
        spawn,
        now: startClock,
        resolved: true,
      });
    }
    const { handlers, problems } = await loadHandlers(repoRoot);
    const handlersLoadedAt = now();
    const runtime = createRuntime({ repoRoot, host: HOST, handlers, problems, now });
    runtimes.add(runtime);
    merged = await runtime.dispatch(mapped.event, {
      sessionId: mapped.sessionId,
      agentId: mapped.agentId,
      hostDeadline,
      workDeadline: hostDeadline - HOST_MARGIN_MS,
    });
    writeTrace(
      repoRoot,
      {
        event: type,
        processStart: performance.timeOrigin,
        receivedAt: start,
        handlersLoadedAt,
        settledAt: now(),
        outcomes: merged.outcomes ?? {},
      },
      env,
    );
    // The capability check runs at session.start and adds a context line when something is missing.
    const missing = type === 'session.start' ? capabilityNotice(HOST, handlers, capabilities) : null;
    if (missing) merged = { ...merged, notices: [...(merged.notices ?? []), missing] };
    const out = toOutput(name, merged);
    const text = out ? JSON.stringify(out) : '';
    const written = out && typeof out.reason === 'string' && out.decision === 'block';
    if (!written && merged.release) await bounded(merged.release, cleanupDeadline)();
    return {
      text,
      ack: written && merged.ack ? bounded(merged.ack, cleanupDeadline) : null,
      release: written && merged.release ? bounded(merged.release, cleanupDeadline) : null,
      cleanupDeadline,
    };
  } catch (err) {
    if (merged?.release) await bounded(merged.release, cleanupDeadline)();
    const out = toOutput(name, { notices: [failureNotice('hook-runtime', type, errText(err))] });
    return { ...empty, text: out ? JSON.stringify(out) : '', cleanupDeadline };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function runAsScript() {
  // Installed before stdin is read, so a host that signals a stuck hook still cleans up. Only the
  // script installs them: main() in process stays listener-free.
  const onSignalEvent = () => {
    if (signalled) {
      process.exit(0);
      return;
    }
    signalled = true;
    const undelivered = pending;
    pending = null;
    setTimeout(() => process.exit(0), 5000);
    onSignal({ pending: undelivered, closeAll, exit: (code) => process.exit(code) }).catch(() => process.exit(0));
  };
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, onSignalEvent);

  let result = { text: '', ack: null, release: null };
  try {
    result = await main({ stdin: await readStdin() });
  } catch {}
  // The listener released the undelivered result and owns the exit (design D4).
  if (signalled) return;
  pending = { release: result.release };
  const finish = async (err) => {
    const undelivered = pending;
    pending = null;
    if (signalled) return;
    try {
      if (err) await undelivered?.release?.();
      else await result.ack?.();
    } catch {}
    // A signal arrived while the ack ran: the listener's closeAll still has to finish.
    if (signalled) return;
    process.exit(0);
  };
  if (!result.text) return finish();
  try {
    process.stdout.write(result.text, (err) => {
      finish(err);
    });
  } catch (err) {
    finish(err);
  }
}

const isScript = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isScript) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  runAsScript();
}
