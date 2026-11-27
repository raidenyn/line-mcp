import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import type { BankToolDeps } from './deps';
import { runTool } from './envelope';

const DESCRIPTION =
  'Report the expense ledger status for the signed-in owner: the base currency and owner timezone, and every source (chat) ' +
  'with its label, effective timezone, review start and revision. ' +
  'Before any source exists the answer is the structured error setup_required with an action that names manage_accounts add_source, ' +
  'a base_currency and an owner_timezone. This tool takes no arguments.';

export function registerLedgerStatus<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool('ledger_status', { description: DESCRIPTION }, async () => {
    const owner = context.principal.subject;
    return runTool(() => {
      const { settings, sources } = deps.ledger.listSources(owner);
      return { settings, sources };
    });
  });
}
