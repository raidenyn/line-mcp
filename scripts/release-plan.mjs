/* global console, process -- Node globals are not declared for this script */
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The plan only computes the next release. A dry run never creates a tag, a
 * GitHub release, or a commit, so running it again is always safe.
 */
const releaseOptions = { branches: ['main'], dryRun: true };

/**
 * Write the dry-run result as GitHub Actions step outputs and notes.
 *
 * @param {{
 *   run: (options: object) => Promise<false | { nextRelease: { version: string; gitTag: string; gitHead: string; notes: string } }>,
 *   writeOutput: (key: string, value: string) => void,
 *   writeNotes: (notes: string) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function plan({ run, writeOutput, writeNotes }) {
  const result = await run(releaseOptions);
  if (!result) {
    writeOutput('released', 'false');
    return;
  }

  const { nextRelease } = result;
  writeOutput('released', 'true');
  writeOutput('version', nextRelease.version);
  writeOutput('tag', nextRelease.gitTag);
  writeOutput('sha', nextRelease.gitHead);
  writeNotes(nextRelease.notes);
}

function writeGithubOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    // Running outside Actions: show the same key=value lines on stdout.
    console.log(`${key}=${value}`);
    return;
  }
  appendFileSync(file, `${key}=${value}\n`);
}

function writeReleaseNotes(notes) {
  writeFileSync(process.env.RELEASE_NOTES_FILE ?? 'release-notes.md', notes);
}

async function main() {
  // Imported lazily so importing this module never loads semantic-release or
  // touches git state and the network.
  const { default: semanticRelease } = await import('semantic-release');
  await plan({
    run: (options) => semanticRelease(options),
    writeNotes: writeReleaseNotes,
    writeOutput: writeGithubOutput,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
