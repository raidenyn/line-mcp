// Generated from src/verify-gate/cli.mts by scripts/build.mts. Do not edit.
// verify-gate CLI (design D6 install/update/check, spec "Manual run").
//   node <skill>/assets/verify-gate/cli.mjs install [--repo DIR]
//   node <skill>/assets/verify-gate/cli.mjs update [--repo DIR]
//   node .agents/harness/verify-gate/cli.mjs check [--repo DIR]
//   node .agents/harness/verify-gate/cli.mjs run [--repo DIR]     a plain full run
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readHarnessConfig } from './lib/config.mjs';
import { configErrors, normalizeConfig, runGate } from './lib/gate.mjs';
import { checkTool, ensureSection, installTool, readLock, requireNode22 } from './lib/install.mjs';
import { toolStateDir } from './lib/state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = 'verify-gate';
const USAGE = 'usage: node cli.mjs install|update|check|run [--repo DIR]\n';
const errText = (err) => (err instanceof Error ? err.message : String(err));

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function defaultRepo() {
  const harness = resolve(HERE, '..');
  if (basename(harness) === 'harness' && basename(resolve(harness, '..')) === '.agents')
    return resolve(harness, '..', '..');
  return git(['rev-parse', '--show-toplevel'], process.cwd()) || process.cwd();
}

const hasRuntime = (repoRoot) => Boolean(readLock(repoRoot).tools['hook-runtime']);
const NO_RUNTIME =
  'hook-runtime is not installed in this repo (no entry in .agents/harness/lock.json); install agent-harness-hook-runtime first.';

function install(repoRoot, mode, io) {
  const node = requireNode22();
  if (node) return io.fail([node]);
  if (git(['rev-parse', '--is-inside-work-tree'], repoRoot) !== 'true')
    return io.fail([`${repoRoot} is not a git work tree`]);
  let config;
  try {
    if (!hasRuntime(repoRoot)) return io.fail([NO_RUNTIME]);
    config = readHarnessConfig(repoRoot);
  } catch (err) {
    return io.fail([errText(err)]);
  }
  // Only key and type errors of an existing section refuse; an unset command is check's job.
  if (config[TOOL] !== undefined) {
    const errors = configErrors(config[TOOL]).filter((e) => !e.startsWith('set verify-gate.command'));
    if (errors.length) return io.fail(errors.map((e) => `.agents/harness.json: ${e}`));
  }
  const res = installTool({ sourceDir: HERE, repoRoot, mode });
  if (res.code !== 0) return io.fail(res.messages);
  const messages = [...res.messages];
  if (ensureSection(repoRoot, TOOL, { command: [] })) {
    messages.push(
      `added "${TOOL}": {"command": []} to .agents/harness.json; set verify-gate.command to the repo's verify argv.`,
    );
  }
  return io.ok(messages);
}

function check(repoRoot, io) {
  const issues = [];
  try {
    issues.push(...checkTool({ toolDir: HERE, repoRoot }));
    if (!hasRuntime(repoRoot)) issues.push(NO_RUNTIME);
  } catch (err) {
    issues.push(errText(err));
  }
  try {
    issues.push(...configErrors(readHarnessConfig(repoRoot)[TOOL]).map((e) => `.agents/harness.json: ${e}`));
  } catch (err) {
    issues.push(errText(err));
  }
  if (issues.length) return io.fail(issues.map((i) => `${TOOL}: ${i}`));
  return io.ok([`${TOOL}: ok`]);
}

async function run(repoRoot, io) {
  let section;
  try {
    section = readHarnessConfig(repoRoot)[TOOL];
  } catch (err) {
    return io.fail([errText(err)]);
  }
  const errors = configErrors(section);
  if (errors.length) return io.fail(errors.map((e) => `.agents/harness.json: ${e}`));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const start = Date.now();
  const deadline = start + normalizeConfig(section).timeoutSeconds * 1000 + 10000;
  try {
    const r = await runGate({
      repoRoot,
      trigger: 'turn-end',
      config: section,
      stateDir: toolStateDir(repoRoot, TOOL),
      signal: controller.signal,
      deadline,
      cleanupDeadline: deadline + 5000,
    });
    switch (r.status) {
      case 'skipped':
        return io.ok(['verify: no change since the last full pass.']);
      case 'passed':
        return io.ok([`verify: passed in ${Date.now() - start} ms.`]);
      case 'contended':
        return io.fail([r.text]);
      default:
        io.out(`${r.text}\n`);
        return 1;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

// main(argv, {out, err}) -> exit code
export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const io = {
    out,
    ok: (lines) => {
      for (const l of lines) out(`${l}\n`);
      return 0;
    },
    fail: (lines) => {
      for (const l of lines) err(`${l}\n`);
      return 1;
    },
  };
  const [command, ...rest] = argv;
  let repo;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--repo' && rest[i + 1] !== undefined) repo = resolve(rest[++i]);
    else return io.fail([`unknown argument ${rest[i]}`, USAGE.trim()]);
  }
  const repoRoot = repo ?? defaultRepo();
  switch (command) {
    case 'install':
    case 'update':
      return install(repoRoot, command, io);
    case 'check':
      return check(repoRoot, io);
    case 'run':
      return run(repoRoot, io);
    default:
      err(USAGE);
      return 2;
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
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${TOOL}: ${errText(e)}\n`);
      process.exitCode = 1;
    },
  );
}
