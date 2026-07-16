import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import { summarize, TransactionFilterSchema, type TransactionFilter } from '../transaction-parser';
import type { BankToolDeps } from './deps';
import { fetchParsedTransactions } from './fetch-transactions';

export function registerSummarizeTransactions<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'summarize_transactions',
    {
      description:
        'Fetch transactions from a LINE chat and aggregate them into totals and per-group breakdowns. ' +
        'Uses saved templates (set up via manage_templates). ' +
        'When transactions span multiple currencies the totals are labelled "mixed".',
      inputSchema: {
        chatMid: z.string().describe('Chat MID from list_chats'),
        group_by: z.enum(['month', 'merchant', 'category']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name; "category" groups by assigned spending category'),
        since: z.string().optional().describe('ISO date — exclude transactions before this date'),
        until: z.string().optional().describe('ISO date — exclude transactions after this date'),
        ...TransactionFilterSchema.shape,
      },
    },
    async ({ chatMid, group_by, since, until, categories, original_currencies, merchants, amount_min, amount_max }) => {
      const filters: TransactionFilter = { categories, original_currencies, merchants, amount_min, amount_max };
      try {
        const fetched = await fetchParsedTransactions(deps, context.principal, chatMid, since, until, filters);
        if ('error' in fetched) {
          return { content: [{ type: 'text' as const, text: fetched.error }], isError: true };
        }
        const { transactions, warnings, rangeNote } = fetched;
        const result = summarize(transactions, group_by, since, until);
        const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) + warningBlock + rangeNote }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to summarize: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
