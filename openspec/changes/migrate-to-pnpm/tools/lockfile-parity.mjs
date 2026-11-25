// Throwaway lockfile parity check: package-lock.json (npm) vs pnpm-lock.yaml.
// Usage: node pnpm-parity.mjs <checkout-with-yaml-dep> <package-lock.json> <pnpm-lock.yaml>
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const [checkout, npmLockPath, pnpmLockPath] = process.argv.slice(2);
const YAML = createRequire(path.resolve(checkout, 'package.json'))('yaml');

const npmLock = JSON.parse(readFileSync(npmLockPath, 'utf8'));
const docs = YAML.parseAllDocuments(readFileSync(pnpmLockPath, 'utf8'));
const pnpmLock = docs[docs.length - 1].toJSON();

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SNAP_SECTIONS = ['dependencies', 'optionalDependencies'];
const stripPeers = (v) => String(v).replace(/\(.*$/, '');
const nameOf = (p) => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);

// ---- npm ----
const pkgs = npmLock.packages;
const npmInventory = new Set();
const npmBundled = new Set();
for (const [p, e] of Object.entries(pkgs)) {
  if (!p.includes('node_modules/') || e.link) continue;
  const id = `${nameOf(p)}@${e.version}`;
  (e.inBundle ? npmBundled : npmInventory).add(id);
}
function resolveNpm(from, name) {
  let base = from;
  for (;;) {
    const cand = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (pkgs[cand]) {
      const e = pkgs[cand];
      if (e.link) return `link:${e.resolved}`;
      return e.version;
    }
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i >= 0 ? base.slice(0, i) : '';
  }
}
const npmImporterEdges = new Map(); // "importer child" -> version
const npmPkgEdges = new Map(); // "parent@ver child" -> Set(version)
for (const [p, e] of Object.entries(pkgs)) {
  if (e.link || e.inBundle) continue;
  const isImporter = !p.includes('node_modules/');
  const deps = isImporter ? [...SECTIONS, 'peerDependencies'] : [...SNAP_SECTIONS, 'peerDependencies'];
  for (const sec of deps) {
    for (const child of Object.keys(e[sec] ?? {})) {
      const v = resolveNpm(p, child);
      if (v === null) { if (sec === 'optionalDependencies' || sec === 'peerDependencies') continue; }
      if (isImporter) npmImporterEdges.set(`${p || '.'} ${child}`, v);
      else {
        const k = `${nameOf(p)}@${e.version} ${child}`;
        if (!npmPkgEdges.has(k)) npmPkgEdges.set(k, new Set());
        npmPkgEdges.get(k).add(v);
      }
    }
  }
}

// ---- pnpm ----
const pnpmInventory = new Set(Object.keys(pnpmLock.packages ?? {}).map(stripPeers));
const pnpmImporterEdges = new Map();
for (const [imp, e] of Object.entries(pnpmLock.importers ?? {})) {
  for (const sec of SECTIONS) {
    for (const [child, d] of Object.entries(e[sec] ?? {})) {
      const v = String(d.version);
      const linked = v.startsWith('link:')
        ? `link:${path.posix.normalize(path.posix.join(imp === '.' ? '' : imp, v.slice('link:'.length)))}`
        : stripPeers(v);
      pnpmImporterEdges.set(`${imp} ${child}`, linked);
    }
  }
}
const pnpmPkgEdges = new Map();
for (const [key, e] of Object.entries(pnpmLock.snapshots ?? {})) {
  const parent = stripPeers(key);
  for (const sec of SNAP_SECTIONS) {
    for (const [child, v] of Object.entries(e[sec] ?? {})) {
      const k = `${parent} ${child}`;
      if (!pnpmPkgEdges.has(k)) pnpmPkgEdges.set(k, new Set());
      pnpmPkgEdges.get(k).add(stripPeers(v));
    }
  }
}

// ---- compare ----
const out = (t, xs) => { console.log(`## ${t} (${xs.length})`); for (const x of xs.sort()) console.log(`  ${x}`); };
out('inventory only-npm', [...npmInventory].filter((x) => !pnpmInventory.has(x)));
out('inventory only-pnpm', [...pnpmInventory].filter((x) => !npmInventory.has(x)));
out('bundled (npm only, informational)', [...npmBundled]);
const impDiff = [];
for (const k of new Set([...npmImporterEdges.keys(), ...pnpmImporterEdges.keys()])) {
  const a = npmImporterEdges.get(k), b = pnpmImporterEdges.get(k);
  if (a !== b) impDiff.push(`${k}: npm=${a ?? '-'} pnpm=${b ?? '-'}`);
}
out('importer edges differing', impDiff);
const pkgDiff = [];
const fmt = (s) => (s ? [...s].sort().join('|') : '-');
for (const k of new Set([...npmPkgEdges.keys(), ...pnpmPkgEdges.keys()])) {
  const a = fmt(npmPkgEdges.get(k)), b = fmt(pnpmPkgEdges.get(k));
  if (a !== b) pkgDiff.push(`${k}: npm=${a} pnpm=${b}`);
}
out('package edges differing', pkgDiff);
