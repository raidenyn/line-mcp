import type { MessageCache } from '@raidenyn/line-client';
import type { CredentialStore } from './auth/credential-store';
import { maskMid } from './auth/credential-store';
import type { LinePrincipal } from './auth/line-auth-provider';
import type { RequestLineClient } from './request-client';

export interface SyncOptions {
  credentialStore: CredentialStore;
  cache: MessageCache;
  /** The SAME request-client factory registerLineTools' deps use (see request-client.ts). */
  createRequestClient(principal: LinePrincipal): Promise<RequestLineClient>;
}

function toPrincipal(mid: string): LinePrincipal {
  return { provider: 'line', subject: mid, mid, scopes: [] };
}

/**
 * Syncs every stored LINE account's previously-accessed chats. Principals are
 * enumerated from `credentialStore.list()` (never a raw filesystem scan owned
 * by this module), and freshness of refreshed credentials is left entirely to
 * `createRequestClient`'s own `onAuthRefreshed` wiring — this function never
 * writes to any OAuth-owned freshness map directly.
 */
export async function syncAll(options: SyncOptions): Promise<void> {
  const { credentialStore, cache, createRequestClient } = options;
  const records = await credentialStore.list();
  if (records.length === 0) return;

  for (const record of records) {
    const mid = record.mid;
    const chatMids = cache.getDistinctChatMids(mid);
    if (chatMids.length === 0) continue;

    let client: RequestLineClient;
    try {
      client = await createRequestClient(toPrincipal(mid));
    } catch {
      process.stderr.write(`[sync] Could not build a client for ${maskMid(mid)}\n`);
      continue;
    }

    let synced = 0;
    let errors = 0;
    for (const chatMid of chatMids) {
      try {
        await client.messages.getMessagesInRange(chatMid, 0);
        synced++;
      } catch {
        process.stderr.write(`[sync] Error syncing ${maskMid(chatMid)} for ${maskMid(mid)}\n`);
        errors++;
      }
    }

    process.stderr.write(`[sync] mid=${maskMid(mid)}: ${synced} chats synced, ${errors} errors\n`);
  }
}

/**
 * Starts a periodic sync loop. A process-local single-flight guard ensures
 * that if a run is still in flight when the next interval fires, the overlap
 * shares the SAME in-flight promise rather than starting a second concurrent
 * pass over the same accounts.
 */
export function startSyncLoop(
  options: SyncOptions,
  intervalMs = 24 * 60 * 60 * 1000,
): ReturnType<typeof setInterval> {
  process.stderr.write(`[sync] Starting daily sync loop (interval: ${Math.round(intervalMs / 3_600_000)}h)\n`);
  let inFlight: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (inFlight) return inFlight; // single-flight: share the run already in progress
    const started: Promise<void> = syncAll(options).catch(() => {
      process.stderr.write('[sync] Unexpected sync error\n');
    });
    inFlight = started.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  void run();
  return setInterval(() => void run(), intervalMs);
}
