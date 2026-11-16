import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type StepResult = {
  output: Record<string, string>;
  status: number;
  stderr: string;
  stdout: string;
};

/**
 * Run one workflow `run:` script the way GitHub does — `bash -euo pipefail` —
 * with fake executables first on `PATH`, then read back the step outputs.
 *
 * `fakes` maps an executable name to its script; every fake is written to a
 * fresh temp directory and made executable. `GITHUB_OUTPUT` is always a fresh
 * file, so a step that writes no output yields an empty map.
 */
export function runStep(
  run: string,
  { env, fakes }: { env: Record<string, string>; fakes: Record<string, string> },
): StepResult {
  const dir = mkdtempSync(join(tmpdir(), 'run-step-'));
  for (const [name, script] of Object.entries(fakes)) {
    const binary = join(dir, name);
    writeFileSync(binary, script);
    chmodSync(binary, 0o755);
  }

  const outputPath = join(dir, 'github-output');
  writeFileSync(outputPath, '');

  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GITHUB_OUTPUT: outputPath,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    },
  });

  const output: Record<string, string> = {};
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    output[line.slice(0, separator)] = line.slice(separator + 1);
  }

  return {
    output,
    status: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}
