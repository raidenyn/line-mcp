import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import {
  parseTransaction,
  expandUntilBound,
  applyBalanceDiffs,
  categorize,
  validateFilters,
  filterTransactions,
  TransactionTemplateSchema,
  TransactionFilterSchema,
  type Transaction,
  type TransactionFilter,
} from '../transaction-parser';
import type { BankToolDeps } from './deps';
import { buildAmountWarnings, fetchParsedTransactions } from './fetch-transactions';

export function registerGetTransactions<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'get_transactions',
    {
      description:
        'Fetch messages from a LINE chat and parse them into structured transactions using regex templates. ' +
        'Non-matching messages (promotions, alerts) are silently dropped. Results are sorted oldest→newest. ' +
        'If templates is omitted, saved templates for this chat are loaded automatically from data/templates/<chatMid>.json ' +
        'and filtered per message by valid_from/valid_until, so bank format changes across time are handled transparently. ' +
        'Use manage_templates to save templates and sample_messages to inspect raw messages before writing patterns.',
      inputSchema: {
        chatMid: z.string().describe('Chat MID from list_chats'),
        templates: z.array(TransactionTemplateSchema).min(1).optional().describe(
          'Ordered list of patterns to try per message; first match wins. ' +
          'Omit to auto-load saved templates for this chat.'
        ),
        since: z.string().optional().describe('ISO date — exclude transactions before this date'),
        until: z.string().optional().describe('ISO date — exclude transactions after this date'),
        ...TransactionFilterSchema.shape,
      },
    },
    async ({ chatMid, templates: suppliedTemplates, since, until, categories, original_currencies, merchants, amount_min, amount_max }) => {
      const filters: TransactionFilter = { categories, original_currencies, merchants, amount_min, amount_max };
      try {
        if (suppliedTemplates) {
          // Inline-template path — unchanged from before
          if (since && !Number.isFinite(new Date(since).getTime())) {
            return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
          }
          if (until && !Number.isFinite(new Date(until).getTime())) {
            return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
          }
          const filterError = validateFilters(filters);
          if (filterError) {
            return { content: [{ type: 'text' as const, text: filterError }], isError: true };
          }
          const reader = await deps.createMessageReader(context.principal);
          const messages = since
            ? await reader.getMessagesInRange(chatMid, new Date(since).getTime())
            : await reader.getMessages(chatMid, 200);
          let transactions = messages
            .map((msg) => parseTransaction(msg, suppliedTemplates))
            .filter((tx): tx is Transaction => tx !== null);
          if (since) transactions = transactions.filter((tx) => tx.date >= since);
          if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
          transactions.sort((a, b) => a.date.localeCompare(b.date));
          await applyBalanceDiffs(transactions);
          categorize(transactions, deps.categories.list());
          transactions = filterTransactions(transactions, filters);
          const inlineWarnings = buildAmountWarnings(transactions);
          const warningBlock = inlineWarnings.length > 0 ? '\n\nWarnings:\n' + inlineWarnings.join('\n') : '';
          const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
          return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock + rangeNote }] };
        }

        // Saved-templates path — delegate to helper
        const fetched = await fetchParsedTransactions(deps, context.principal, chatMid, since, until, filters);
        if ('error' in fetched) {
          return { content: [{ type: 'text' as const, text: fetched.error }], isError: true };
        }
        const { transactions, warnings, rangeNote } = fetched;
        const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';

        if (transactions.length === 0) {
          const filterNote = Object.values(filters).some((v) => v !== undefined)
            ? ' Filters were applied — check category names via manage_categories (action: list), currency codes, merchant patterns, or the amount range.'
            : '';
          return {
            content: [{
              type: 'text' as const,
              text: '0 transactions matched. Check that saved templates cover the message timestamps — ' +
                'use manage_templates (action: list) to review validity ranges.' + filterNote + warningBlock + rangeNote,
            }],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock + rangeNote }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get transactions: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
