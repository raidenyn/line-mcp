import * as path from 'path';

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

export const secretPath   = (): string => path.join(dataDir(), 'secret');
export const authDir      = (): string => path.join(dataDir(), 'auth');
export const templatesDir = (): string => path.join(dataDir(), 'templates');
export const cacheDbPath  = (): string => path.join(dataDir(), 'cache', 'messages.db');
