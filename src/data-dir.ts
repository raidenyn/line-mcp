import * as path from 'path';

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

// Every helper below accepts an explicit data-root override so callers that
// already hold a resolved root (e.g. the persistence migration, which is
// handed `dataRoot` as an option rather than reading `DATA_DIR` itself) can
// derive paths without going through the process-wide default. Omitting the
// argument preserves the original process-wide behavior for existing callers.
export const secretPath   = (root: string = dataDir()): string => path.join(root, 'secret');
export const authDir      = (root: string = dataDir()): string => path.join(root, 'auth');
export const templatesDir = (root: string = dataDir()): string => path.join(root, 'templates');
export const cacheDbPath  = (root: string = dataDir()): string => path.join(root, 'cache', 'messages.db');
