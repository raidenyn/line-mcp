import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import type { LinePrincipal } from '../auth/line-auth-provider';
import type { LineToolDeps } from './deps';

export function registerListChats(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
  server.registerTool(
    'list_chats',
    {
      description:
        'List all LINE chats (group chats and 1:1 contacts). ' +
        'Each chat shows its mid (required by get_messages), display name, type (GROUP or USER), and member count.',
      inputSchema: {},
    },
    async () => {
      try {
        const client = await deps.createRequestClient(context.principal);
        const chats = await client.api.listChats();
        const lines = chats.map((c) => {
          const type = c.type === 'group' ? 'GROUP' : 'USER';
          const members = c.memberCount != null ? ` (${c.memberCount} members)` : '';
          const pic = c.pictureUrl ? `\n  pictureUrl: ${c.pictureUrl}` : '';
          return `[${type}] ${c.name}${members}\n  mid: ${c.mid}${pic}`;
        });
        const chatText = lines.length > 0 ? lines.join('\n') : 'No chats found.';
        return { content: [{ type: 'text' as const, text: chatText }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list chats: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
