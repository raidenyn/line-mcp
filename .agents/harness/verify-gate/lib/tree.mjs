// Generated from src/verify-gate/lib/tree.mts by scripts/build.mts. Do not edit.
// Working-tree content key and changed-file list (design D4, D5 "Every run"). Every git command
// goes through the injected `spawn` (the supervisor's `context.spawn` in a worker). Call these only
// while holding the gate lock: git refuses a second writer of the private index, and a leftover
// `index.lock` is therefore stale and deleted.
//
// The private index lives at `<stateDir>/index` and is built once with `git read-tree HEAD` (empty
// without HEAD), never copied from the real index, so it carries no assume-unchanged or
// skip-worktree flags. The real index is only read.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHUNK = 500;
// Keep git's own refresh strict whatever the repo sets, so the tree id cannot miss a same-size edit.
const STRICT = ['-c', 'core.trustctime=true', '-c', 'core.checkStat=default'];
const CORRUPT =
  /index file corrupt|bad index file|bad signature|index file smaller than expected|unknown index entry format|index uses .* extension/i;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const splitZ = (s) => s.split('\0').filter(Boolean);

class GitError extends Error {
  constructor(args, res) {
    const msg = (res.stderr || res.stdout || '').trim() || `exit ${res.code ?? res.signal}`;
    super(`git ${args.join(' ')} failed: ${msg}`);
    this.corrupt = CORRUPT.test(res.stderr ?? '');
  }
}

function gitRunner({ repoRoot, stateDir, spawn, signal }) {
  const privateIndex = join(stateDir, 'index');
  let realIndex = null;
  const run = async (args, env) => {
    const res = await spawn(['git', ...args], { cwd: repoRoot, env: { GIT_OPTIONAL_LOCKS: '0', ...env }, signal });
    return { ...res, args };
  };
  const ok = (res) => {
    if (res.code !== 0) throw new GitError(res.args, res);
    return res.stdout;
  };
  const real = async (args) => {
    if (realIndex === null) {
      const p = ok(await run(['rev-parse', '--git-path', 'index'])).trim();
      realIndex = resolve(repoRoot, p);
    }
    return run(args, { GIT_INDEX_FILE: realIndex });
  };
  const priv = (args) => run([...STRICT, ...args], { GIT_INDEX_FILE: privateIndex });
  const head = async () => {
    const res = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    return res.code === 0 ? res.stdout.trim() : '';
  };
  return { privateIndex, run, ok, real, priv, head };
}

async function inChunks(paths, fn) {
  for (let i = 0; i < paths.length; i += CHUNK) await fn(paths.slice(i, i + CHUNK));
}

function exists(repoRoot, rel) {
  try {
    lstatSync(join(repoRoot, rel));
    return true;
  } catch {
    return false;
  }
}

function statLine(repoRoot, rel) {
  try {
    const s = lstatSync(join(repoRoot, rel), { bigint: true });
    return `${s.mode} ${s.size} ${s.ino} ${s.mtimeNs} ${s.ctimeNs}`;
  } catch (err) {
    return `missing ${err.code ?? ''}`;
  }
}

async function computeKey(repoRoot, g) {
  const { ok, real, priv, head } = g;
  if (!existsSync(g.privateIndex)) {
    if (await head()) ok(await priv(['read-tree', 'HEAD']));
    else ok(await priv(['read-tree', '--empty']));
  }
  // Membership: tracked-but-ignored paths follow the real index (force-tracked files count,
  // `git rm --cached` drops them). `add -A` keeps tracked paths current but never adds ignored ones.
  const realIgnored = new Set(splitZ(ok(await real(['ls-files', '-z', '-ci', '--exclude-standard']))));
  const privIgnored = new Set(splitZ(ok(await priv(['ls-files', '-z', '-ci', '--exclude-standard']))));
  const toAdd = [...realIgnored].filter((p) => !privIgnored.has(p) && exists(repoRoot, p));
  const toDrop = [...privIgnored].filter((p) => !realIgnored.has(p));
  await inChunks(toAdd, async (paths) => ok(await priv(['--literal-pathspecs', 'add', '-f', '--', ...paths])));
  await inChunks(toDrop, async (paths) => ok(await priv(['update-index', '--force-remove', '--', ...paths])));

  ok(await priv(['add', '-A']));
  const tree = ok(await priv(['write-tree'])).trim();
  const paths = splitZ(ok(await priv(['ls-files', '-z']))).sort();
  const statMap = new Map();
  const lines = [];
  for (const p of paths) {
    const line = statLine(repoRoot, p);
    statMap.set(p, sha256(line));
    lines.push(`${p}\0${line}`);
  }
  return { tree, stat: sha256(lines.join('\n')), statMap };
}

export async function contentKey({ repoRoot, stateDir, spawn, signal }) {
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(stateDir, 'index.lock'), { force: true });
  const g = gitRunner({ repoRoot, stateDir, spawn, signal });
  try {
    return await computeKey(repoRoot, g);
  } catch (err) {
    if (!err.corrupt) throw err;
    rmSync(g.privateIndex, { force: true });
    rmSync(join(stateDir, 'index.lock'), { force: true });
    return computeKey(repoRoot, g);
  }
}

const entriesOf = (m) => (m instanceof Map ? m : new Map(Object.entries(m ?? {})));

// Call after contentKey, under the same gate lock, so the private index is current.
export async function changedFiles({ repoRoot, baseRef, stateDir, statMap, lastStatMap, spawn, signal }) {
  const g = gitRunner({ repoRoot, stateDir, spawn, signal });
  const { ok, run, real, priv } = g;
  let base = '';
  if (baseRef) {
    const mb = await run(['merge-base', 'HEAD', baseRef]);
    if (mb.code === 0) base = mb.stdout.trim();
  }
  if (!base) base = await g.head();

  const files = new Set();
  const tracked = base
    ? ok(await priv(['diff', '--cached', '--name-only', '--no-renames', '-z', base, '--']))
    : ok(await priv(['ls-files', '-z']));
  for (const p of splitZ(tracked)) files.add(p);
  for (const p of splitZ(ok(await real(['ls-files', '-z', '-o', '--exclude-standard'])))) files.add(p);
  if (lastStatMap && statMap) {
    const now = entriesOf(statMap);
    const last = entriesOf(lastStatMap);
    for (const [p, h] of now) if (last.get(p) !== h) files.add(p);
    for (const p of last.keys()) if (!now.has(p)) files.add(p);
  }
  return { base, files: [...files].sort() };
}
