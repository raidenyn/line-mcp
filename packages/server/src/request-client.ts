import {
  createRequestClientFactory,
  type RequestLineClient,
  type LinePrincipal,
} from '@raidenyn/line-mcp';
import type { AuthData, MessageCache } from '@raidenyn/line-client';

/**
 * The composed server's request-client seam. It reuses `@raidenyn/line-mcp`'s
 * already-tested `createRequestClientFactory` verbatim — this wrapper exists
 * purely as this package's own import surface (`@raidenyn/server` re-exports
 * `RequestLineClient` from here), not to add behavior; every option is passed
 * straight through.
 *
 * The returned factory, for a given principal:
 *   - loads that account's credentials by MID (via `resolveCredentials`);
 *   - builds a fresh, UNCACHED LINE API client from them;
 *   - binds the shared owner-scoped message cache to the SAME MID, exposing it
 *     as `messages` (`{ api, messages }`);
 *   - invokes `onAuthRefreshed` with any refreshed credential snapshot exactly
 *     as received.
 */
export interface ServerRequestClientOptions {
  cache: MessageCache;
  /** Resolves the freshest LINE credential for a principal; `null` ⇒ reauthorize. */
  resolveCredentials(principal: LinePrincipal): Promise<Readonly<AuthData> | null>;
  /** Fired synchronously by the underlying LineClient when a token is refreshed mid-request. */
  onAuthRefreshed(authData: Readonly<AuthData>): void;
  lineApiBaseUrl?: string;
}

/** Builds the `(principal) => Promise<RequestLineClient>` factory the composed server wires everywhere. */
export function createServerRequestClientFactory(
  options: ServerRequestClientOptions,
): (principal: LinePrincipal) => Promise<RequestLineClient> {
  return createRequestClientFactory({
    cache: options.cache,
    resolveCredentials: options.resolveCredentials,
    onAuthRefreshed: options.onAuthRefreshed,
    lineApiBaseUrl: options.lineApiBaseUrl,
  });
}

export type { RequestLineClient };