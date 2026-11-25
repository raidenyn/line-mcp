import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The prepack vendoring script under a miniature pnpm layout: happy-dom is a
 * symlink into a virtual store whose dependencies are siblings, as in
 * node_modules/.pnpm/<pkg>@<ver>/node_modules/.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'vendor-happy-dom.js');

let root: string | undefined;

afterEach(() => {
  if (root) {
    // Undo the simulated failure so the tree can be removed.
    const unreadable = path.join(root, 'store', 'node_modules', 'dep-b', 'index.js');
    if (fs.existsSync(unreadable)) fs.chmodSync(unreadable, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function writePackage(dir: string, name: string, dependencies: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(name)};\n`);
}

/** Builds pkg/{scripts,node_modules/happy-dom -> store} and returns the package dir. */
function pnpmLayout(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-happy-dom-'));
  const store = path.join(root, 'store', 'node_modules');
  writePackage(path.join(store, 'happy-dom'), 'happy-dom', { 'dep-a': '1', 'dep-b': '1' });
  writePackage(path.join(store, 'dep-a'), 'dep-a');
  writePackage(path.join(store, 'dep-b'), 'dep-b');

  const pkg = path.join(root, 'pkg');
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(pkg, 'scripts', 'vendor-happy-dom.js'));
  fs.mkdirSync(path.join(pkg, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(store, 'happy-dom'), path.join(pkg, 'node_modules', 'happy-dom'));
  return pkg;
}

function vendor(pkg: string) {
  return spawnSync(process.execPath, [path.join(pkg, 'scripts', 'vendor-happy-dom.js')], {
    cwd: pkg,
    encoding: 'utf8',
  });
}

describe('vendor-happy-dom under a pnpm layout', () => {
  it('vendors happy-dom and its store siblings as real directories', () => {
    const pkg = pnpmLayout();
    const result = vendor(pkg);
    expect(result.status, result.stderr).toBe(0);
    for (const name of ['happy-dom', 'dep-a', 'dep-b']) {
      const dir = path.join(pkg, 'node_modules', name);
      expect(fs.lstatSync(dir).isSymbolicLink(), name).toBe(false);
      expect(fs.existsSync(path.join(dir, 'package.json')), name).toBe(true);
    }
  });

  it('can be retried after a copy fails part-way', () => {
    const pkg = pnpmLayout();
    // dep-b resolves (its package.json is readable) but copying it fails.
    const depBFile = path.join(root!, 'store', 'node_modules', 'dep-b', 'index.js');
    fs.chmodSync(depBFile, 0o000);
    if (spawnSync('cat', [depBFile]).status === 0) return; // running as root: permissions cannot simulate the failure
    expect(vendor(pkg).status).not.toBe(0);
    expect(fs.lstatSync(path.join(pkg, 'node_modules', 'happy-dom')).isSymbolicLink()).toBe(true);

    fs.chmodSync(depBFile, 0o644);
    const retry = vendor(pkg);
    expect(retry.status, retry.stderr).toBe(0);
    expect(execFileSync(process.execPath, ['-e', "console.log(require('dep-b'))"], {
      cwd: pkg,
      encoding: 'utf8',
    }).trim()).toBe('dep-b');
  });
});
