import * as path from 'path';

/**
 * The executable data layout for the composed server: every persistent path is
 * derived from ONE configured data root. Nothing here reads a database or opens
 * SQLite — this module only computes paths. The per-generation active line/bank/
 * quarantine database paths are computed by `resolveGenerationPaths` in
 * `persistence-migration.ts` (which the migration owns), from the same data
 * root; everything else (secret, auth, templates, the legacy source, the
 * generations tree, the pointer, and the packaged guide docs) is here.
 */

/**
 * Resolves the process-wide default data root. This is the ONE place the
 * default (`DATA_DIR` env or `<cwd>/data`) is read; every other helper takes an
 * explicit root so callers that already hold a resolved root (the migration,
 * the composed server started against an explicit `dataRoot`) never touch the
 * environment or the process working directory.
 */
export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

export const secretPath   = (root: string = dataDir()): string => path.join(root, 'secret');
export const authDir      = (root: string = dataDir()): string => path.join(root, 'auth');
export const templatesDir = (root: string = dataDir()): string => path.join(root, 'templates');

/**
 * The legacy combined `cache/messages.db` — read-only source the one-time
 * persistence migration copies out of. Never opened by the running server.
 */
export const cacheDbPath = (root: string = dataDir()): string => path.join(root, 'cache', 'messages.db');

/** The per-data-root tree holding every migration generation. */
export const generationsDir = (root: string = dataDir()): string => path.join(root, 'persistence-generations');

/** The single cutover pointer naming the active generation. */
export const pointerPath = (root: string = dataDir()): string => path.join(root, 'persistence-current.json');

/**
 * The packaged `docs/guide` directory shipped inside `@raidenyn/server`, holding
 * the composed ten-tool `overview.md`. Sits alongside `dist/` as a sibling of
 * `package.json`, so `__dirname` resolves it identically under ts-node (from
 * `src/`) and compiled (`dist/`).
 */
export const guideDir = (): string => path.join(__dirname, '..', 'docs', 'guide');

export interface DataLayout {
  dataRoot: string;
  secretPath: string;
  authDir: string;
  templatesDir: string;
  cacheDbPath: string;
  generationsDir: string;
  pointerPath: string;
  guideDir: string;
}

/** Bundles every data-root-relative path for a single configured root. */
export function resolveDataLayout(dataRoot: string): DataLayout {
  return {
    dataRoot,
    secretPath: secretPath(dataRoot),
    authDir: authDir(dataRoot),
    templatesDir: templatesDir(dataRoot),
    cacheDbPath: cacheDbPath(dataRoot),
    generationsDir: generationsDir(dataRoot),
    pointerPath: pointerPath(dataRoot),
    guideDir: guideDir(),
  };
}
