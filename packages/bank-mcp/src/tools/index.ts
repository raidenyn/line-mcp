import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import type { BankToolDeps } from './deps';
import { registerManageTemplates } from './manage-templates';
import { registerManageCategories } from './manage-categories';
import { registerSampleMessages } from './sample-messages';
import { registerGetTransactions } from './get-transactions';
import { registerSummarizeTransactions } from './summarize-transactions';

export type { BankToolDeps } from './deps';

/**
 * Registers all five bank tools (manage_templates, manage_categories,
 * sample_messages, get_transactions, summarize_transactions) against `server`.
 *
 * `context.principal`/`context.request` are read via property access inside
 * each handler body — never destructured here — so the exact same function
 * works both against a `RequestContext` whose fields are live getters backed
 * by AsyncLocalStorage (the composed server's current one-time-registration
 * model) and against `createMcpHost`'s fresh-context-per-request object.
 */
export function registerBankTools<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  registerManageTemplates(server, context, deps);
  registerManageCategories(server, context, deps);
  registerSampleMessages(server, context, deps);
  registerGetTransactions(server, context, deps);
  registerSummarizeTransactions(server, context, deps);
}
