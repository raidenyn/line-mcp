import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { AuthData, LineClient } from './line-client';
import { MessageCache } from './message-cache';
import { CachingLineClient } from './caching-line-client';
import { latestAuthData, persistAuthData } from './oauth';

type SyncClient = { getMessagesInRange(chatMid: string, sinceMs: number): Promise<unknown> };
type MakeClient = (authData: AuthData, cache: MessageCache) => SyncClient;

const defaultMakeClient: MakeClient = (authData, cache) =>
  new CachingLineClient(
    new LineClient(authData, globalThis.fetch, () => {
      latestAuthData.set(authData.mid, authData);
      persistAuthData(authData);
    }),
    cache,
  );

export interface SyncOptions {
  authDir?: string;
  makeClient?: MakeClient;
}

export async function syncAll(cache: MessageCache, options: SyncOptions = {}): Promise<void> {
  const authDir = resolve(options.authDir ?? join(process.env.DATA_DIR ?? process.cwd(), 'auth'));
  const makeClient = options.makeClient ?? defaultMakeClient;

  let files: string[];
  try {
    files = readdirSync(authDir).filter(f => f.endsWith('.json'));
  } catch {
    process.stderr.write('[sync] auth dir not found or unreadable, skipping\n');
    return;
  }

  const chatMids = cache.getDistinctChatMids();
  if (chatMids.length === 0) return;

  for (const file of files) {
    const mid = file.slice(0, -5);
    if (!/^[A-Za-z0-9_-]+$/.test(mid)) continue;

    let authData: AuthData;
    try {
      authData = JSON.parse(readFileSync(join(authDir, file), 'utf8')) as AuthData;
    } catch {
      process.stderr.write(`[sync] Failed to load auth for ${mid}, skipping\n`);
      continue;
    }

    if (!authData.mid || authData.mid !== mid || !authData.accessToken) {
      process.stderr.write(`[sync] Invalid or incomplete auth for ${mid}, skipping\n`);
      continue;
    }
    latestAuthData.set(mid, authData);

    const client = makeClient(authData, cache);
    let synced = 0;
    let errors = 0;

    for (const chatMid of chatMids) {
      try {
        await client.getMessagesInRange(chatMid, 0);
        synced++;
      } catch (err) {
        process.stderr.write(`[sync] Error syncing ${chatMid} for ${mid}: ${(err as Error).message}\n`);
        errors++;
      }
    }

    process.stderr.write(`[sync] mid=${mid}: ${synced} chats synced, ${errors} errors\n`);
  }
}

export function startSyncLoop(
  cache: MessageCache,
  intervalMs = 24 * 60 * 60 * 1000,
  options: SyncOptions = {},
): ReturnType<typeof setInterval> {
  process.stderr.write(`[sync] Starting daily sync loop (interval: ${Math.round(intervalMs / 3_600_000)}h)\n`);
  const run = () => syncAll(cache, options).catch(err =>
    process.stderr.write(`[sync] Unexpected error: ${(err as Error).message}\n`),
  );
  run();
  return setInterval(run, intervalMs);
}
