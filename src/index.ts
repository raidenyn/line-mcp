import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as qrcodeterminal from 'qrcode-terminal';
import { LineClient } from './line-client';

const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: 'text',
  1: 'image',
  2: 'video',
  3: 'audio',
  7: 'sticker',
  13: 'location',
  22: 'flex',
};

const client = new LineClient('.line-auth.json');
const server = new McpServer({ name: 'line-mcp', version: '1.0.0' });

server.registerTool(
  'login',
  {
    description:
      'Start LINE QR code login. Returns a URL to scan with the LINE mobile app. After scanning, call list_chats to complete authentication and list your chats.',
  },
  async () => {
    try {
      const { qrUrl } = await client.login();
      const qrText = await new Promise<string>((resolve) => {
        qrcodeterminal.generate(qrUrl, { small: true }, resolve);
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Scan this QR code with your LINE mobile app:\n\n${qrText}\nURL: ${qrUrl}\n\nAfter scanning, call list_chats to continue.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Login failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'list_chats',
  {
    description:
      'List all LINE chats (group chats and 1:1 contacts). If login is in progress (QR was shown), this will complete the authentication first.',
  },
  async () => {
    try {
      const chats = await client.listChats();
      if (chats.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No chats found.' }] };
      }
      const lines = chats.map((c) => {
        const type = c.type === 'group' ? 'GROUP' : 'USER';
        const members = c.memberCount != null ? ` (${c.memberCount} members)` : '';
        return `[${type}] ${c.name}${members}\n  mid: ${c.mid}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list chats: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'get_messages',
  {
    description: 'Get recent messages from a LINE chat. Use the mid value from list_chats.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      count: z.number().int().min(1).max(200).default(50).describe('Number of recent messages to fetch'),
    },
  },
  async ({ chatMid, count }) => {
    try {
      const messages = await client.getMessages(chatMid, count);
      if (messages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
      }
      const lines = messages.map((m) => {
        const createdMs = parseInt(m.createdTime, 10);
        const time = Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : 'unknown';
        const label = CONTENT_TYPE_LABELS[m.contentType] ?? `type:${m.contentType}`;
        if (m.contentType === 0) {
          return `[${time}] ${m.from}: ${m.text ?? ''}`;
        }
        const extra = m.previewUrl ? ` (preview: ${m.previewUrl})` : '';
        return `[${time}] ${m.from}: [${label}]${extra}`;
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

server.registerTool(
  'get_image',
  {
    description:
      'Fetch an image from LINE and return it as base64. Pass a URL from list_chats (pictureUrl) or get_messages (previewUrl or downloadUrl).',
    inputSchema: {
      url: z.string().url().describe('Image URL to fetch'),
    },
  },
  async ({ url }) => {
    try {
      const { buffer, mimeType } = await client.getImageBuffer(url);
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('LINE MCP server started (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
