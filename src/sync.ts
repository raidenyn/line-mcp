import { AuthData, LineClient } from './line-client';
import { resolve } from 'path';
import { MessageCache } from './message-cache';
import { CachingLineClient } from './caching-line-client';
import {
  authDataFromStoredRecord,
  latestAuthData,
  listStoredAuthRecords,
  maskMid,
  recordRefreshedAuth,
} from './oauth';
import { authDir as getAuthDir } from './data-dir';

type SyncClient = { getMessagesInRange(chatMid: string, sinceMs: number): Promise<unknown> };
type MakeClient = (authData: AuthData, cache: MessageCache) => SyncClient;

const defaultMakeClient: MakeClient = (authData, cache) =>
  new CachingLineClient(
    new LineClient(authData, globalThis.fetch, () => recordRefreshedAuth(authData)),
    cache,
  );

export interface SyncOptions {
  authDir?: string;
  makeClient?: MakeClient;
}

export async function syncAll(cache: MessageCache, options: SyncOptions = {}): Promise<void> {
  const makeClient = options.makeClient ?? defaultMakeClient;
  const chatMids = cache.getDistinctChatMids();
  if (chatMids.length === 0) return;

  const records = listStoredAuthRecords(resolve(options.authDir ?? getAuthDir()));
  if (records.length === 0) return;

  for (const record of records) {
    const authData = authDataFromStoredRecord(record);
    const mid = authData.mid;
    latestAuthData.set(mid, authData);
    const client = makeClient(authData, cache);
    let synced = 0;
    let errors = 0;

    for (const chatMid of chatMids) {
      try {
        await client.getMessagesInRange(chatMid, 0);
        synced++;
      } catch {
        process.stderr.write(`[sync] Error syncing ${maskMid(chatMid)} for ${maskMid(mid)}\n`);
        errors++;
      }
    }

    process.stderr.write(`[sync] mid=${maskMid(mid)}: ${synced} chats synced, ${errors} errors\n`);
  }
}

export function startSyncLoop(
  cache: MessageCache,
  intervalMs = 24 * 60 * 60 * 1000,
  options: SyncOptions = {},
): ReturnType<typeof setInterval> {
  process.stderr.write(`[sync] Starting daily sync loop (interval: ${Math.round(intervalMs / 3_600_000)}h)\n`);
  const run = () => syncAll(cache, options).catch(() =>
    process.stderr.write('[sync] Unexpected sync error\n'),
  );
  run();
  return setInterval(run, intervalMs);
}
