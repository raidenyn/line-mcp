// Generated from src/verify-gate/lib/run.mts by scripts/build.mts. Do not edit.
// Runs the verify command (design D5 "Every run", D3 "Cleanup"). The process is started through the
// injected `spawn` (the supervisor's `context.spawn` in a worker), which puts it in its own process
// group and sends the group SIGTERM when its `signal` aborts. runCommand owns the schedule after
// that: SIGKILL to the group after min(5 s, cleanupDeadline - now - 1 s), counted from the SIGTERM
// and not cancelled when the leader exits, and it resolves only once the group is empty.

const KILL_AFTER_MS = 5000;
const CONFIRM_MS = 1000;
const POLL_MS = 50;
const MAX_TIMER_MS = 2 ** 31 - 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => (err instanceof Error ? err.message : String(err));

function groupAlive(pgid) {
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

// Waits until the group is empty. `killStart` is when SIGTERM went out (null after a normal exit,
// in which case leftover members get SIGTERM now). The wait is bounded by the cleanup deadline, or
// by 1 s after SIGKILL when that is later, so a member the kernel cannot reap never hangs the gate.
async function settleGroup(pgid, killStart, cleanupDeadline) {
  if (!groupAlive(pgid)) return;
  if (killStart === null) {
    killStart = Date.now();
    signalGroup(pgid, 'SIGTERM');
  }
  const room = Number.isFinite(cleanupDeadline) ? cleanupDeadline - killStart - CONFIRM_MS : KILL_AFTER_MS;
  const killAt = killStart + Math.max(0, Math.min(KILL_AFTER_MS, room));
  const giveUpAt = Math.max(
    killAt + CONFIRM_MS,
    Number.isFinite(cleanupDeadline) ? cleanupDeadline : killAt + KILL_AFTER_MS,
  );
  let killed = false;
  while (groupAlive(pgid) && Date.now() < giveUpAt) {
    if (!killed && Date.now() >= killAt) {
      signalGroup(pgid, 'SIGKILL');
      killed = true;
      continue;
    }
    await sleep(Math.max(1, Math.min(POLL_MS, killed ? POLL_MS : killAt - Date.now())));
  }
}

// The last `maxBytes` of the output, then its last `tailLines` lines. stdout comes before stderr,
// because the supervisor's spawn keeps the two streams apart.
function tailOf(stdout, stderr, maxBytes, tailLines) {
  let text = stdout && stderr && !stdout.endsWith('\n') ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > maxBytes) text = buf.subarray(buf.length - maxBytes).toString('utf8');
  const lines = text.split('\n');
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  const kept = lines.slice(-tailLines).join('\n');
  return endsWithNewline && kept ? `${kept}\n` : kept;
}

export async function runCommand({
  spawn,
  argv,
  cwd,
  env,
  timeoutMs,
  signal,
  deadline,
  cleanupDeadline,
  maxBytes = 1048576,
  tailLines = 60,
}) {
  const ctl = new AbortController();
  let reason = null;
  let killStart = null;
  const stop = (why) => {
    if (reason) return;
    reason = why;
    killStart = Date.now();
    ctl.abort(new Error(why));
  };
  const limit = Math.min(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Infinity,
    Number.isFinite(deadline) ? deadline - Date.now() : Infinity,
  );
  const timer = Number.isFinite(limit)
    ? setTimeout(() => stop('timeout'), Math.min(MAX_TIMER_MS, Math.max(0, limit)))
    : null;
  const onAbort = () => stop('aborted');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let res = null;
  let spawnError = null;
  try {
    res = await spawn(argv, {
      cwd,
      env,
      signal: ctl.signal,
      maxBytes,
      timeoutMs: Number.isFinite(limit) ? Math.max(1, Math.ceil(limit)) : undefined,
    });
  } catch (err) {
    spawnError = `could not start ${argv?.[0]}: ${errText(err)}`;
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  if (res?.timedOut && !reason) {
    reason = 'timeout';
    killStart = Date.now();
  }
  if (res?.pgid) await settleGroup(res.pgid, killStart, cleanupDeadline);

  let exitKind;
  if (spawnError !== null) exitKind = 'spawn-error';
  else if (reason === 'aborted') exitKind = 'aborted';
  else if (reason === 'timeout') exitKind = 'timeout';
  else if (res.signal) exitKind = 'signal';
  else exitKind = 'exit';
  return {
    code: res?.code ?? null,
    exitKind,
    signal: res?.signal ?? null,
    timedOut: exitKind === 'timeout',
    spawnError,
    tail: res ? tailOf(res.stdout ?? '', res.stderr ?? '', maxBytes, tailLines) : '',
  };
}
