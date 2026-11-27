// Generated from src/shared/lib/install.mts by scripts/build.mts. Do not edit.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { readHarnessConfig } from './config.mjs';

export const DEFAULT_CLAUDE_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.agents/harness/hook-runtime/claude.mjs"';
export const DEFAULT_OPENCODE_PLUGIN = './.agents/harness/hook-runtime/opencode';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RESTORE =
  'Restore the file with `git checkout -- .agents/harness/<tool>/<file>`, or delete the tool folder and its lock entry to reinstall.';
const NO_LOCK =
  'Delete the folder to reinstall, or restore the lock entry (`git checkout -- .agents/harness/lock.json`).';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function listToolFiles(toolDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  if (existsSync(toolDir)) walk(toolDir, '');
  return out.sort();
}

const lockPath = (repoRoot) => join(repoRoot, '.agents', 'harness', 'lock.json');

export function readLock(repoRoot) {
  let text;
  try {
    text = readFileSync(lockPath(repoRoot), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, tools: {} };
    throw new Error(`cannot read ${lockPath(repoRoot)}: ${err.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${lockPath(repoRoot)} is not valid JSON: ${err.message}`);
  }
  if (!isObject(value) || !isObject(value.tools)) throw new Error(`${lockPath(repoRoot)} is not a valid lock file`);
  return { version: 1, ...value, tools: value.tools };
}

const sortKeys = (o) =>
  Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );

function lockText(lock) {
  const tools = {};
  for (const name of Object.keys(lock.tools).sort()) {
    const t = lock.tools[name];
    tools[name] = { version: t.version, files: sortKeys(t.files) };
  }
  return `${JSON.stringify({ version: lock.version ?? 1, tools }, null, 2)}\n`;
}

function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeLock(repoRoot, lock) {
  writeFileAtomic(lockPath(repoRoot), lockText(lock));
}

export function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22 ? null : `Node 22 or newer is required (found ${process.versions.node})`;
}

function planTool({ sourceDir, repoRoot, mode }) {
  const meta = JSON.parse(readFileSync(join(sourceDir, 'tool.json'), 'utf8'));
  const { name, version } = meta;
  const dest = join(repoRoot, '.agents', 'harness', name);
  const refuse = (...messages) => ({ code: 1, messages, changed: false, apply() {} });
  let lock;
  try {
    lock = readLock(repoRoot);
  } catch (err) {
    return refuse(err.message);
  }
  const entry = lock.tools[name];
  const sourceFiles = listToolFiles(sourceDir);
  const sourceHashes = Object.fromEntries(sourceFiles.map((f) => [f, sha256File(join(sourceDir, f))]));
  const present = listToolFiles(dest);
  if (!entry) {
    if (present.length) {
      return refuse(`${name}: ${posix.join('.agents/harness', name)} exists but has no lock entry. ${NO_LOCK}`);
    }
  } else {
    const problems = checkAgainst(dest, entry.files, present);
    if (problems.length) {
      return refuse(...problems.map((p) => `${name}: ${p}`), RESTORE.replace('<tool>', name));
    }
    if (entry.version !== version && mode !== 'update') {
      return refuse(`${name} ${entry.version} is installed; use update to install ${version}.`);
    }
    const same =
      entry.version === version && JSON.stringify(sortKeys(entry.files)) === JSON.stringify(sortKeys(sourceHashes));
    if (same) return { code: 0, messages: [`${name} ${version} is up to date.`], changed: false, apply() {} };
  }
  return {
    code: 0,
    messages: [`${name} ${version} ${entry ? 'updated' : 'installed'}.`],
    changed: true,
    apply() {
      for (const f of sourceFiles) writeFileAtomic(join(dest, f), readFileSync(join(sourceDir, f)));
      for (const f of present) if (!(f in sourceHashes)) rmSync(join(dest, f), { force: true });
      lock.tools[name] = { version, files: sourceHashes };
      writeLock(repoRoot, lock);
    },
  };
}

function checkAgainst(dest, lockFiles, present) {
  const problems = [];
  for (const [rel, hash] of Object.entries(lockFiles)) {
    const file = join(dest, rel);
    if (!existsSync(file)) problems.push(`missing file ${rel}`);
    else if (sha256File(file) !== hash) problems.push(`${rel} differs from the lock (edited copy)`);
  }
  for (const rel of present) if (!(rel in lockFiles)) problems.push(`extra file ${rel} is not in the lock`);
  return problems;
}

export function installTool({ sourceDir, repoRoot, mode = 'install' }) {
  const plan = planTool({ sourceDir, repoRoot, mode });
  if (plan.code === 0) plan.apply();
  return { code: plan.code, messages: plan.messages, changed: plan.changed };
}

export function checkTool({ toolDir, repoRoot }) {
  const meta = JSON.parse(readFileSync(join(toolDir, 'tool.json'), 'utf8'));
  let lock;
  try {
    lock = readLock(repoRoot);
  } catch (err) {
    return [err.message];
  }
  const entry = lock.tools[meta.name];
  if (!entry) return [`no lock entry for ${meta.name}`];
  return checkAgainst(toolDir, entry.files, listToolFiles(toolDir));
}

function sectionPlan(repoRoot, tool, stub) {
  const config = readHarnessConfig(repoRoot);
  if (config[tool] !== undefined) return null;
  return () =>
    writeFileAtomic(
      join(repoRoot, '.agents', 'harness.json'),
      `${JSON.stringify({ ...config, [tool]: stub }, null, 2)}\n`,
    );
}

export function ensureSection(repoRoot, tool, stub) {
  const write = sectionPlan(repoRoot, tool, stub);
  if (!write) return false;
  write();
  return true;
}

function readJsonFile(file) {
  if (!existsSync(file)) return { exists: false, value: null };
  const text = readFileSync(file, 'utf8');
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch (err) {
    return { exists: true, error: err.message };
  }
}

function planClaude(repoRoot, command, events) {
  const file = join(repoRoot, '.claude', 'settings.json');
  const entryFor = (timeout) => ({ hooks: [{ type: 'command', command, timeout }] });
  const byHand = () =>
    Object.entries(events)
      .map(([ev, t]) => `  ${ev}: ${JSON.stringify(entryFor(t))}`)
      .join('\n');
  const refuse = (why) => ({
    code: 1,
    messages: [`${file}: ${why}. Add these entries under "hooks" by hand:\n${byHand()}`],
    write: null,
  });
  const read = readJsonFile(file);
  if (read.error) return refuse(`not plain JSON (comments would be lost): ${read.error}`);
  const settings = read.exists ? read.value : {};
  if (!isObject(settings)) return refuse('must contain a JSON object');
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return refuse('"hooks" is not an object');
  const hooks = settings.hooks ?? {};
  const added = [];
  for (const [event, timeout] of Object.entries(events)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return refuse(`"hooks.${event}" is not an array`);
    const list = hooks[event] ?? [];
    const has = list.some(
      (e) => isObject(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isObject(h) && h.command === command),
    );
    if (!has) added.push([event, [...list, entryFor(timeout)]]);
  }
  if (!added.length) return { code: 0, messages: [], write: null };
  const next = { ...settings, hooks: { ...hooks, ...Object.fromEntries(added) } };
  return {
    code: 0,
    messages: [`added ${added.length} hook entries to ${file}`],
    write: () => writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`),
  };
}

function planOpencode(repoRoot, pluginPath) {
  const file = join(repoRoot, 'opencode.json');
  const refuse = (why) => ({
    code: 1,
    messages: [`${file}: ${why}. Add ${JSON.stringify(pluginPath)} to "plugins" by hand.`],
    write: null,
  });
  const read = readJsonFile(file);
  if (read.error) return refuse(`not plain JSON (comments would be lost): ${read.error}`);
  const config = read.exists ? read.value : {};
  if (!isObject(config)) return refuse('must contain a JSON object');
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) return refuse('"plugins" is not an array');
  const plugins = config.plugins ?? [];
  if (plugins.includes(pluginPath)) return { code: 0, messages: [], write: null };
  const next = { ...config, plugins: [...plugins, pluginPath] };
  return {
    code: 0,
    messages: [`added ${pluginPath} to ${file}`],
    write: () => writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`),
  };
}

export function mergeClaudeSettings(repoRoot, command, events) {
  const plan = planClaude(repoRoot, command, events);
  if (plan.code === 0 && plan.write) plan.write();
  return { code: plan.code, messages: plan.messages };
}

export function mergeOpencodeConfig(repoRoot, pluginPath) {
  const plan = planOpencode(repoRoot, pluginPath);
  if (plan.code === 0 && plan.write) plan.write();
  return { code: plan.code, messages: plan.messages };
}

export function installHookRuntime({
  sourceDir,
  repoRoot,
  mode = 'install',
  events,
  command = DEFAULT_CLAUDE_COMMAND,
  pluginPath = DEFAULT_OPENCODE_PLUGIN,
}) {
  const tool = planTool({ sourceDir, repoRoot, mode });
  const claude = planClaude(repoRoot, command, events ?? {});
  const opencode = planOpencode(repoRoot, pluginPath);
  const messages = [];
  let configError = null;
  try {
    readHarnessConfig(repoRoot);
  } catch (err) {
    configError = err.message;
  }
  const plans = [tool, claude, opencode];
  if (configError || plans.some((p) => p.code !== 0)) {
    for (const p of plans) if (p.code !== 0) messages.push(...p.messages);
    if (configError) messages.push(configError);
    return { code: 1, messages, changed: false };
  }
  // Host configs first, then copies, with the lock written last by tool.apply().
  if (claude.write) claude.write();
  if (opencode.write) opencode.write();
  tool.apply();
  for (const p of plans) messages.push(...p.messages);
  return { code: 0, messages, changed: tool.changed || Boolean(claude.write || opencode.write) };
}
