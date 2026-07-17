#!/usr/bin/env node
// Runs as this package's "prepack" hook (npm invokes prepack for both
// `npm pack` and `npm publish`, always with cwd = this package directory).
//
// package.json declares happy-dom as a bundledDependencies entry so a
// standalone consumer never needs registry access to satisfy it (see
// packages/line-client/package.json and issue #75 Task 5). npm's
// bundledDependencies packing step only looks inside *this package's own*
// node_modules — under the workspace's hoisting, happy-dom and its own
// transitive runtime dependencies (entities, ws, whatwg-mimetype,
// buffer-image-size, its @types/* deps, ...) normally only exist in the
// repo root's node_modules, so without this step `npm pack` would silently
// omit them (bundled: [] instead of a real, runnable vendored copy).
//
// This walks happy-dom's own "dependencies" graph (via Node's own module
// resolution, so it finds whatever hoisted copy already satisfies each one)
// and vendors a real directory copy of every package in that closure into
// this package's own node_modules. Deliberately does NOT shell out to a
// nested `npm install` — this repo's sandboxed npm config restricts nested/
// project-scoped installs from running lifecycle scripts, and none of these
// packages need their own install scripts to run correctly here; a plain
// directory copy is sufficient and avoids that restriction entirely.
//
// Idempotent and safe to re-run; node_modules is gitignored, so nothing
// checked in ever changes.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const targetModulesDir = path.join(pkgRoot, 'node_modules');

// Walks up node_modules directories the same way Node's own module
// resolution would, but without going through require.resolve() — several
// packages in this closure (e.g. entities) declare an "exports" map that
// does not expose "./package.json", so require.resolve(`${name}/package.json`)
// throws ERR_PACKAGE_PATH_NOT_EXPORTED for them.
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`vendor-happy-dom: cannot resolve package "${name}" from ${fromDir}`);
    dir = parent;
  }
}

function vendor(name, fromDir, seen) {
  if (seen.has(name)) return;
  seen.add(name);

  const srcDir = resolvePkgDir(name, fromDir);
  const destDir = path.join(targetModulesDir, ...name.split('/'));

  if (path.resolve(srcDir) !== path.resolve(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true, dereference: true });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    vendor(dep, srcDir, seen);
  }
}

vendor('happy-dom', pkgRoot, new Set());
