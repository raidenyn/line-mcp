import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import type { LinePrincipal } from '../auth/line-auth-provider';
import type { LineToolDeps } from './deps';
import { CONTENT_TYPE_LABELS } from './deps';

export function registerGetMessages(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
  server.registerTool(
    'get_messages',
    {
      description:
        'Get recent messages from a LINE chat. Use the mid value from list_chats. ' +
        'Sender names are resolved automatically. ' +
        'Non-text messages (images, stickers, etc.) show a content-type label and preview URL when available.',
      inputSchema: {
        chatMid: z.string().describe('Chat MID from list_chats'),
        count: z.number().int().min(1).max(200).default(50).describe('Number of recent messages to fetch'),
      },
    },
    async ({ chatMid, count }) => {
      try {
        const client = await deps.createRequestClient(context.principal);
        const messages = await client.messages.getMessages(chatMid, count);
        if (messages.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
        }
        const lines = messages.map((m) => {
          const createdMs = parseInt(m.createdTime, 10);
          const time = Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : 'unknown';
          const sender = m.senderName ?? m.from;
          const label = CONTENT_TYPE_LABELS[m.contentType] ?? `type:${m.contentType}`;
          if (m.contentType === 0) {
            return `[${time}] ${sender}: ${m.text ?? ''}`;
          }
          const extra = m.previewUrl ? ` (preview: ${m.previewUrl})` : '';
          return `[${time}] ${sender}: [${label}]${extra}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get messages: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
