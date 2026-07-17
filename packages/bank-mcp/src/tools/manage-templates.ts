import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import { NamedTemplateSchema } from '../template-store';
import type { BankToolDeps } from './deps';

export function registerManageTemplates<P extends Principal>(
  server: McpServer,
  _context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'manage_templates',
    {
      description:
        'Create, update, delete, or list saved transaction regex templates for a LINE chat. ' +
        'Templates are persisted in data/templates/<chatMid>.json and auto-loaded by get_transactions. ' +
        'Recommended workflow: call sample_messages first to inspect raw message text, ' +
        'then upsert templates here, then call get_transactions with no templates argument.',
      inputSchema: {
        chatMid: z.string().describe('Chat MID from list_chats'),
        action: z.enum(['upsert', 'delete', 'list', 'upsert_alias', 'delete_alias', 'list_aliases', 'list_presets', 'apply_preset']).describe(
          '"upsert" — save or replace a template by name. ' +
          '"delete" — remove a named template. ' +
          '"list" — return all saved templates for this chat (full objects, in insertion order). ' +
          '"upsert_alias" — save or replace a currency alias (e.g. alias: "บาท", canonical: "THB"). ' +
          '"delete_alias" — remove a currency alias by its alias string. ' +
          '"list_aliases" — return all currency aliases for this chat. ' +
          '"list_presets" — list all available built-in bank presets (chatMid is ignored). ' +
          '"apply_preset" — copy all templates and aliases from a named preset into this chat\'s template file.'
        ),
        template: NamedTemplateSchema.optional().describe(
          'Required for action: upsert. Pattern rules: ' +
          'Use named capture groups — (?<original_amount>...) and (?<original_currency>...) are REQUIRED; ' +
          '(?<amount>...), (?<currency>...), (?<merchant>...), (?<date>...), (?<balance>...), (?<account>...) are optional. ' +
          '(?<amount>) captures native-currency amount directly; if absent, it is computed from consecutive balance diffs. ' +
          '(?<currency>) captures the account default currency (e.g. "THB"); (?<original_currency>) captures the transaction currency (e.g. "USD" for foreign spends). ' +
          'Pattern is compiled with the "s" flag (dotAll) — . matches newlines, enabling one pattern for bilingual messages. ' +
          'Backslashes must be doubled in JSON strings: \\\\d, \\\\s, \\\\. — but / does NOT need escaping. ' +
          'Bank messages often use non-breaking spaces (U+00A0) — use \\\\s+ instead of a literal space at word boundaries. ' +
          'amount_sign: "debit" stores amount as negative; "credit" as positive. ' +
          'date_format hint: "DD/MM", "DD/MM/YYYY", or "DD/MM/YYYY HH:mm" — omit if date is already ISO-parseable. ' +
          'valid_from / valid_until: ISO 8601 with timezone offset, e.g. "2025-03-01T00:00:00+07:00". ' +
          'Messages outside this window skip this template — use when the bank changed its message format.'
        ),
        name: z.string().optional().describe('Template name to remove (required for action: delete)'),
        alias: z.string().optional().describe('Currency string captured by regex (required for upsert_alias and delete_alias)'),
        canonical: z.string().optional().describe('Canonical currency code to normalise to, e.g. "THB" (required for upsert_alias)'),
        preset_name: z.string().optional().describe('Preset name to apply (required for action: apply_preset). Use list_presets to see available names.'),
      },
    },
    async ({ chatMid, action, template, name, alias, canonical, preset_name }) => {
      if (action === 'upsert') {
        if (!template) {
          return { content: [{ type: 'text' as const, text: 'template is required for action: upsert' }], isError: true };
        }
        try {
          deps.templates.upsert(chatMid, template);
          return { content: [{ type: 'text' as const, text: `Template '${template.name}' saved for chat ${chatMid}.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to save template: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'delete') {
        if (!name) {
          return { content: [{ type: 'text' as const, text: 'name is required for action: delete' }], isError: true };
        }
        try {
          const deleted = deps.templates.delete(chatMid, name);
          if (!deleted) {
            return { content: [{ type: 'text' as const, text: `No template named '${name}' found for this chat.` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: `Template '${name}' deleted from chat ${chatMid}.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to delete template: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'upsert_alias') {
        if (!alias || !canonical) {
          return { content: [{ type: 'text' as const, text: 'alias and canonical are required for action: upsert_alias' }], isError: true };
        }
        try {
          deps.templates.upsertAlias(chatMid, alias, canonical);
          return { content: [{ type: 'text' as const, text: `Alias '${alias}' → '${canonical}' saved for chat ${chatMid}.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to save alias: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'delete_alias') {
        if (!alias) {
          return { content: [{ type: 'text' as const, text: 'alias is required for action: delete_alias' }], isError: true };
        }
        try {
          const deleted = deps.templates.deleteAlias(chatMid, alias);
          if (!deleted) {
            return { content: [{ type: 'text' as const, text: `No alias '${alias}' found for this chat.` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: `Alias '${alias}' deleted from chat ${chatMid}.` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to delete alias: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'list_aliases') {
        try {
          const aliases = deps.templates.listAliases(chatMid);
          const text = Object.keys(aliases).length === 0
            ? `No currency aliases saved for chat ${chatMid}.`
            : JSON.stringify(aliases, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to list aliases: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'list_presets') {
        try {
          const presets = deps.presets.loadAll();
          const list = Object.entries(presets).map(([presetName, p]) => ({
            name: presetName,
            description: p.description,
            template_count: p.templates.length,
            currency_alias_count: Object.keys(p.currency_aliases).length,
          }));
          return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to list presets: ${(err as Error).message}` }], isError: true };
        }
      }

      if (action === 'apply_preset') {
        if (!preset_name) {
          return { content: [{ type: 'text' as const, text: 'preset_name is required for action: apply_preset' }], isError: true };
        }
        try {
          const preset = deps.presets.get(preset_name);
          if (!preset) {
            const available = Object.keys(deps.presets.loadAll()).join(', ') || 'none';
            return { content: [{ type: 'text' as const, text: `Preset '${preset_name}' not found. Available presets: ${available}` }], isError: true };
          }
          for (const tmpl of preset.templates) {
            deps.templates.upsert(chatMid, tmpl);
          }
          for (const [aliasKey, canonicalValue] of Object.entries(preset.currency_aliases)) {
            deps.templates.upsertAlias(chatMid, aliasKey, canonicalValue);
          }
          const aliasCount = Object.keys(preset.currency_aliases).length;
          return {
            content: [{
              type: 'text' as const,
              text: `Applied preset '${preset_name}': ${preset.templates.length} templates and ${aliasCount} aliases added/updated for chat ${chatMid}.`,
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to apply preset: ${(err as Error).message}` }], isError: true };
        }
      }

      // action === 'list'
      try {
        const templates = deps.templates.list(chatMid);
        const text = templates.length === 0
          ? `No templates saved for chat ${chatMid}.`
          : JSON.stringify(templates, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to list templates: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
