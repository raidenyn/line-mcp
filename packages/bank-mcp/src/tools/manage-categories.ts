import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import { CategorySchema } from '../transaction-parser';
import type { BankToolDeps } from './deps';

export function registerManageCategories<P extends Principal>(
  server: McpServer,
  _context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'manage_categories',
    {
      description:
        'Create, update, delete, or list global spending categories used to automatically tag transactions. ' +
        'Categories apply across all chats — unlike templates, which are chat-specific. ' +
        "Each category has a regex `pattern` matched against a transaction's merchant (falling back to its raw message text when no merchant was captured). " +
        'Patterns are tried in the order categories were created; the first match wins. ' +
        'get_transactions and summarize_transactions apply categorization automatically — no need to call this before every use, only when adding or changing categories.',
      inputSchema: {
        action: z.enum(['upsert', 'delete', 'list']).describe(
          '"upsert" — save or replace a category by name. "delete" — remove a named category. "list" — return all saved categories in match order.'
        ),
        category: CategorySchema.optional().describe(
          'Required for action: upsert. `pattern` is a JS regex matched case-insensitively against merchant (or rawText when merchant is absent). No named capture groups needed — this is a plain match test.'
        ),
        name: z.string().optional().describe('Category name to remove (required for action: delete)'),
      },
    },
    async ({ action, category, name }) => {
      if (action === 'upsert') {
        if (!category) {
          return { content: [{ type: 'text' as const, text: 'category is required for action: upsert' }], isError: true };
        }
        try {
          deps.categories.upsert(category);
          return { content: [{ type: 'text' as const, text: `Category '${category.name}' saved.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to save category: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'delete') {
        if (!name) {
          return { content: [{ type: 'text' as const, text: 'name is required for action: delete' }], isError: true };
        }
        try {
          const deleted = deps.categories.delete(name);
          if (!deleted) {
            return { content: [{ type: 'text' as const, text: `No category named '${name}' found.` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: `Category '${name}' deleted.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to delete category: ${(err as Error).message}` }], isError: true };
        }
      }

      // action === 'list'
      try {
        const categories = deps.categories.list();
        const text = categories.length === 0
          ? 'No categories saved.'
          : JSON.stringify(categories, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to list categories: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
