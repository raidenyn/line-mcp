import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import { filterSampleMessages, parseSampleUntilBound } from '../sample-messages';
import { detectPresets } from '../preset-store';
import type { BankToolDeps } from './deps';

export function registerSampleMessages<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'sample_messages',
    {
      description:
        'Fetch raw text messages from a LINE chat for regex template derivation. ' +
        'Use this BEFORE writing transaction templates — it shows raw message content with UTC timestamps ' +
        'so you can identify anchor strings, field boundaries, and when the bank changed its message format. ' +
        'Returns only text messages (images, stickers, and other non-text content are excluded), ' +
        'sorted oldest-first so format evolution is visible top-to-bottom.',
      inputSchema: {
        chatMid: z.string().describe('Chat MID from list_chats'),
        count: z.number().int().min(1).max(50).default(20).describe('Number of recent messages to fetch (text messages returned; images/stickers excluded from output)'),
        since: z.string().optional().describe('ISO date — fetch messages from this date onwards (enables full history pagination)'),
        until: z.string().optional().describe('ISO date — exclude messages after this date'),
      },
    },
    async ({ chatMid, count, since, until }) => {
      try {
        if (since) {
          const sinceMs = new Date(since).getTime();
          if (!Number.isFinite(sinceMs)) {
            return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
          }
        }
        let untilMs: number | undefined;
        if (until) {
          untilMs = parseSampleUntilBound(until);
          if (!Number.isFinite(untilMs)) {
            return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
          }
        }
        const reader = await deps.createMessageReader(context.principal);
        const messages = since
          ? await reader.getMessagesInRange(chatMid, new Date(since).getTime())
          : await reader.getMessages(chatMid, count);
        const textMessages = filterSampleMessages(messages, untilMs);
        if (textMessages.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No text messages found.' }] };
        }
        const lines = textMessages.map((m) => {
          const time = new Date(parseInt(m.createdTime, 10)).toISOString();
          return `[${time}] ${m.text}`;
        });
        const { templates: savedTemplates } = deps.templates.load(chatMid);
        const allPresets = deps.presets.loadAll();
        const presetSuggestions = detectPresets(textMessages, savedTemplates, allPresets);

        let messageText = lines.join('\n');
        if (presetSuggestions.length > 0) {
          const hints = presetSuggestions.map(
            (s) => `${s.matched_count} message(s) matched the '${s.preset_name}' preset but no saved template — run manage_templates with action: apply_preset, preset_name: '${s.preset_name}' to set it up.`,
          );
          messageText += '\n\n' + hints.join('\n');
        }

        return {
          content: [
            { type: 'text' as const, text: messageText },
            { type: 'text' as const, text: JSON.stringify({ preset_suggestions: presetSuggestions }) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to sample messages: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
