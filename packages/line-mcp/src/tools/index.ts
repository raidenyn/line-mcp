import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import type { LinePrincipal } from '../auth/line-auth-provider';
import type { LineToolDeps } from './deps';
import { registerListChats } from './list-chats';
import { registerGetMessages } from './get-messages';
import { registerGetImage } from './get-image';
import { registerInitiateImport, registerCompleteImport } from './import-tools';

export type { LineToolDeps } from './deps';

/**
 * Registers all five messenger-only tools (list_chats, get_messages,
 * get_image, initiate_import, complete_import) against `server`.
 *
 * `context.principal`/`context.request` are read via property access inside
 * each handler body — never destructured here — so the exact same function
 * works both against a `RequestContext` whose fields are live getters backed
 * by AsyncLocalStorage (the composed server's current one-time-registration
 * model) and against `createMcpHost`'s fresh-context-per-request object.
 */
export function registerLineTools(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
  registerListChats(server, context, deps);
  registerGetMessages(server, context, deps);
  registerGetImage(server, context, deps);
  registerInitiateImport(server, context, deps);
  registerCompleteImport(server, context, deps);
}
