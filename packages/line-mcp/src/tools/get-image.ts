import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import type { LinePrincipal } from '../auth/line-auth-provider';
import type { LineToolDeps } from './deps';

export function registerGetImage(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
  server.registerTool(
    'get_image',
    {
      description:
        'Fetch an image from LINE and return it as inline base64 for display. ' +
        'Pass a pictureUrl from list_chats, or a previewUrl/downloadUrl from get_messages. ' +
        'Prefer previewUrl for faster loads; use downloadUrl for full-resolution.',
      inputSchema: {
        url: z.string().url().describe('Image URL to fetch'),
      },
    },
    async ({ url }) => {
      try {
        const client = await deps.createRequestClient(context.principal);
        const { buffer, mimeType } = await client.api.getImageBuffer(url);
        return {
          content: [
            {
              type: 'image' as const,
              data: buffer.toString('base64'),
              mimeType,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to fetch image: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
