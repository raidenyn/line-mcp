/* global console, process -- Node globals are not declared for this script */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// CI peer-dependency gate. A frozen pnpm install skips peer diagnostics, so
// this checks the lockfile's peer resolution explicitly (it replaces the
// dependency-closure step the npm workspace ran).

/**
 * List the peer problems in `pnpm peers check --json` output. Keeping this
 * pure lets it be unit-tested without pnpm.
 *
 * @param {Record<string, { bad?: object, missing?: object, conflicts?: unknown[] }>} report
 * @returns {string[]} one `<importer>: <field> <detail>` line per problem
 */
export function findPeerProblems(report) {
  const problems = [];
  for (const [importer, result] of Object.entries(report)) {
    for (const field of ['bad', 'missing']) {
      for (const [name, detail] of Object.entries(result?.[field] ?? {})) {
        problems.push(`${importer}: ${field} ${name} ${JSON.stringify(detail)}`);
      }
    }
    for (const conflict of result?.conflicts ?? []) {
      problems.push(`${importer}: conflicts ${JSON.stringify(conflict)}`);
    }
  }
  return problems;
}

function main() {
  const result = spawnSync('pnpm', ['peers', 'check', '--lockfile-only', '--json'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error('check-peers: pnpm peers check failed');
    console.error(result.error?.message ?? result.stderr);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('check-peers: pnpm peers check printed invalid JSON');
    process.exit(2);
  }

  const problems = findPeerProblems(report);
  if (problems.length > 0) {
    console.error(`check-peers: ${problems.length} peer dependency problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log('peer dependencies OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
