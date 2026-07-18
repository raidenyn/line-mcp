import {
  createRequestClientFactory,
  recordRefreshedAuth,
  type RequestLineClient,
  type LinePrincipal,
} from '@raidenyn/line-mcp';
import type { AuthData, MessageCache } from '@raidenyn/line-client';

/**
 * The composed server's request-client seam. It reuses `@raidenyn/line-mcp`'s
 * already-tested `createRequestClientFactory` verbatim — the ONLY thing this
 * wrapper adds is capturing the executable-owned `authStoreDir` into the
 * refresh-persistence callback, so a LINE token rotated mid-request is written
 * back to the right auth store. No client-construction, credential-resolution,
 * or cache-wrapping logic is reimplemented here.
 *
 * The returned factory, for a given principal:
 *   - loads that account's credentials by MID (via `resolveCredentials`);
 *   - builds a fresh, UNCACHED LINE API client from them;
 *   - binds the shared owner-scoped message cache to the SAME MID, exposing it
 *     as `messages` (`{ api, messages }`);
 *   - persists any refreshed credential snapshot exactly as received.
 */
export interface ServerRequestClientOptions {
  cache: MessageCache;
  /** Resolves the freshest LINE credential for a principal; `null` ⇒ reauthorize. */
  resolveCredentials(principal: LinePrincipal): Promise<Readonly<AuthData> | null>;
  /** Directory refreshed LINE credential snapshots are persisted into. */
  authStoreDir: string;
  lineApiBaseUrl?: string;
}

/** Builds the `(principal) => Promise<RequestLineClient>` factory the composed server wires everywhere. */
export function createServerRequestClientFactory(
  options: ServerRequestClientOptions,
): (principal: LinePrincipal) => Promise<RequestLineClient> {
  return createRequestClientFactory({
    cache: options.cache,
    resolveCredentials: options.resolveCredentials,
    onAuthRefreshed: (fresh) => recordRefreshedAuth(fresh, options.authStoreDir),
    lineApiBaseUrl: options.lineApiBaseUrl,
  });
}

export type { RequestLineClient };
