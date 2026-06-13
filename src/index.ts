import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as qrcodeterminal from 'qrcode-terminal';
import { LineClient, AuthData } from './line-client';

const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: 'text',
  1: 'image',
  2: 'video',
  3: 'audio',
  7: 'sticker',
  13: 'location',
  22: 'flex',
};

let pendingLoginClient: LineClient | null = null;
const server = new McpServer({ name: 'line-mcp', version: '1.0.0' });

function parseAuth(auth: string): AuthData | null {
  try {
    return JSON.parse(auth) as AuthData;
  } catch {
    return null;
  }
}

server.registerTool(
  'login',
  {
    description:
      'Start LINE QR code login. Returns a QR code and URL to scan with the LINE mobile app. ' +
      'On first login a PIN will be shown — the user must enter it in LINE mobile to confirm. ' +
      'After scanning (and entering PIN if prompted), call list_chats to complete authentication.',
  },
  async () => {
    try {
      pendingLoginClient = new LineClient();
      const { qrUrl } = await pendingLoginClient.login();
      const qrText = await new Promise<string>((resolve) => {
        qrcodeterminal.generate(qrUrl, { small: true }, resolve);
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Scan this QR code with your LINE mobile app:\n\n${qrText}\nURL: ${qrUrl}\n\nAfter scanning, call list_chats (without auth) to continue.`,
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
      'List all LINE chats (group chats and 1:1 contacts). ' +
      'Pass the auth JSON from a previous login to use stored credentials. ' +
      'Omit auth when completing a QR login flow (after scanning the QR and entering PIN if prompted). ' +
      'On login completion, the response includes an AUTH_DATA block — save it and pass it as auth on future calls. ' +
      'Each chat shows its mid (required by get_messages), display name, type (GROUP or USER), and member count.',
    inputSchema: {
      auth: z
        .string()
        .optional()
        .describe(
          'Auth JSON returned after login. Omit only when completing the QR login flow.',
        ),
    },
  },
  async ({ auth }) => {
    try {
      let client: LineClient;
      let isLoginCompletion = false;

      if (auth) {
        const authData = parseAuth(auth);
        if (!authData) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid auth JSON.' }],
            isError: true,
          };
        }
        client = new LineClient(authData);
      } else {
        if (!pendingLoginClient) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No pending login. Call the login tool first and scan the QR code.',
              },
            ],
            isError: true,
          };
        }
        client = pendingLoginClient;
        isLoginCompletion = true;
      }

      const chats = await client.listChats();

      const lines = chats.map((c) => {
        const type = c.type === 'group' ? 'GROUP' : 'USER';
        const members = c.memberCount != null ? ` (${c.memberCount} members)` : '';
        return `[${type}] ${c.name}${members}\n  mid: ${c.mid}`;
      });
      const chatText = lines.length > 0 ? lines.join('\n') : 'No chats found.';

      if (isLoginCompletion) {
        const completedAuth = client.getCompletedAuth();
        pendingLoginClient = null;
        if (completedAuth) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `${chatText}\n\n---\n` +
                  `AUTH_DATA (save this and pass as \`auth\` to list_chats, get_messages, and get_image):\n` +
                  JSON.stringify(completedAuth),
              },
            ],
          };
        }
      }

      return { content: [{ type: 'text' as const, text: chatText }] };
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
    description:
      'Get recent messages from a LINE chat. Use the mid value from list_chats. ' +
      'Sender names are resolved automatically. ' +
      'Non-text messages (images, stickers, etc.) show a content-type label and preview URL when available.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      count: z.number().int().min(1).max(200).default(50).describe('Number of recent messages to fetch'),
      auth: z.string().describe('Auth JSON returned by list_chats after login'),
    },
  },
  async ({ chatMid, count, auth }) => {
    const authData = parseAuth(auth);
    if (!authData) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid auth JSON.' }],
        isError: true,
      };
    }
    try {
      const client = new LineClient(authData);
      const messages = await client.getMessages(chatMid, count);
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

server.registerTool(
  'get_image',
  {
    description:
      'Fetch an image from LINE and return it as inline base64 for display. ' +
      'Pass a pictureUrl from list_chats, or a previewUrl/downloadUrl from get_messages. ' +
      'Prefer previewUrl for faster loads; use downloadUrl for full-resolution.',
    inputSchema: {
      url: z.string().url().describe('Image URL to fetch'),
      auth: z.string().describe('Auth JSON returned by list_chats after login'),
    },
  },
  async ({ url, auth }) => {
    const authData = parseAuth(auth);
    if (!authData) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid auth JSON.' }],
        isError: true,
      };
    }
    try {
      const client = new LineClient(authData);
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
