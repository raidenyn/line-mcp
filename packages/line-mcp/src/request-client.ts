import {
  createLineClient,
  withMessageCache,
  type AuthData,
  type LineApiClient,
  type MessageCache,
  type MessageReader,
} from '@raidenyn/line-client';
import type { LinePrincipal } from './auth/line-auth-provider';

/**
 * The per-request LINE client surface handed to messenger tool handlers and
 * the sync loop alike. `api` is the raw LINE API surface (listChats,
 * getImageBuffer, ...); `messages` is the same surface wrapped with the
 * shared message cache so get_messages/get_messages_in_range only fetch what
 * isn't already cached.
 */
export interface RequestLineClient {
  api: LineApiClient;
  messages: MessageReader;
}

export interface RequestClientFactoryOptions {
  cache: MessageCache;
  /**
   * Resolves the freshest LINE credential for a principal. Returning `null`
   * means the account must reauthorize; the factory throws in that case
   * rather than returning a half-built client.
   */
  resolveCredentials(principal: LinePrincipal): Promise<Readonly<AuthData> | null>;
  /** Fired synchronously by the underlying LineClient when a token is refreshed mid-request. */
  onAuthRefreshed?: (authData: Readonly<AuthData>) => void;
  lineApiBaseUrl?: string;
}

/**
 * Builds a `(principal) => Promise<RequestLineClient>` factory — the single
 * seam both `registerLineTools` (via `LineToolDeps.createRequestClient`) and
 * the sync loop use to construct a LINE client for a given account. Kept as
 * one function so both call sites share identical credential-resolution and
 * cache-wrapping behavior.
 */
export function createRequestClientFactory(
  options: RequestClientFactoryOptions,
): (principal: LinePrincipal) => Promise<RequestLineClient> {
  return async (principal: LinePrincipal): Promise<RequestLineClient> => {
    const authData = await options.resolveCredentials(principal);
    if (!authData) {
      throw new Error(`No LINE credentials available for ${principal.mid}`);
    }
    const api = createLineClient(authData, {
      onAuthRefreshed: options.onAuthRefreshed,
      lineApiBaseUrl: options.lineApiBaseUrl,
    });
    const messages = withMessageCache(api, options.cache, principal.mid);
    return { api, messages };
  };
}
