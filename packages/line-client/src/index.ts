// Public entry point for @raidenyn/line-client.
//
// Importing this module must have no side effects: no happy-dom import, no
// filesystem reads, no timers, no sockets. Everything WASM/sandbox-related
// (in ./signer) is lazy and only initializes on the first real signing call.

export { LineClient } from './client';
export type { AuthData, Chat, Message } from './client';

export { parseExportFile, parseExportHeader } from './export-parser';

export { signForAccount } from './signer';
export type { StorageKeyMaterial, HmacInput } from './signer';

export { withMessageCache } from './cached-message-reader';
export type { MessageReader, MessageCache, ImportMessagesResult } from './cached-message-reader';

import { LineClient, type AuthData, type Message } from './client';
import type { MessageReader } from './cached-message-reader';

/**
 * The public surface a caller gets back from createLineClient(). A narrower,
 * stable contract than the LineClient class itself: getMessagesInRange() here
 * always resolves sender names (matching every real call site in this
 * codebase) and takes no `resolveNames` parameter, so this interface is
 * assignable wherever a generic MessageReader is expected (e.g. to
 * withMessageCache()).
 */
export interface LineApiClient extends MessageReader {
  isAuthenticated(): boolean;
  getCompletedAuth(): AuthData | null;
  getProfileDisplayName(): Promise<string>;
  waitForPin(): Promise<string | null>;
  waitForCompletion(): Promise<void>;
  login(certificate?: string): Promise<{ qrUrl: string }>;
  listChats(): ReturnType<LineClient['listChats']>;
  getMessages(chatMid: string, count?: number): Promise<Message[]>;
  getMessagesInRange(chatMid: string, sinceMs: number, pageSize?: number): Promise<Message[]>;
  getImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
}

export interface LineClientOptions {
  fetch?: typeof globalThis.fetch;
  onAuthRefreshed?: (snapshot: Readonly<AuthData>) => void | Promise<void>;
  lineApiBaseUrl?: string;
}

/**
 * Builds the public LineApiClient surface on top of a LineClient instance.
 * `auth` is cloned by LineClient itself (see client.ts), and refreshed
 * credentials are surfaced to `options.onAuthRefreshed` as an immutable
 * snapshot rather than by mutating the `auth` the caller passed in.
 */
export function createLineClient(auth: AuthData | null, options: LineClientOptions = {}): LineApiClient {
  const inner = new LineClient(
    auth,
    options.fetch ?? globalThis.fetch,
    options.onAuthRefreshed,
    options.lineApiBaseUrl,
  );

  return {
    isAuthenticated: () => inner.isAuthenticated(),
    getCompletedAuth: () => inner.getCompletedAuth(),
    getProfileDisplayName: () => inner.getProfileDisplayName(),
    waitForPin: () => inner.waitForPin(),
    waitForCompletion: () => inner.waitForCompletion(),
    login: (certificate?: string) => inner.login(certificate),
    listChats: () => inner.listChats(),
    getMessages: (chatMid: string, count?: number) => inner.getMessages(chatMid, count),
    // The richer LineClient method always resolves names when asked to; we
    // pin `resolveNames = true` here since every caller of the public
    // LineApiClient wants names resolved, and dropping the parameter is what
    // lets this interface satisfy the generic MessageReader shape.
    getMessagesInRange: (chatMid: string, sinceMs: number, pageSize?: number) =>
      inner.getMessagesInRange(chatMid, sinceMs, true, pageSize),
    getImageBuffer: (url: string) => inner.getImageBuffer(url),
  };
}
