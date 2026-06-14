import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AsyncLocalStorage } from 'async_hooks';
import express from 'express';
import { join } from 'path';
import { z } from 'zod';
import { LineClient, AuthData } from './line-client';
import { setupOAuthRoutes, validateBearerToken, latestAuthData, seedTestToken as oauthSeedTestToken, makeWwwAuthenticate } from './oauth';

const CONTENT_TYPE_LABELS: Record<number, string> = {
  0: 'text',
  1: 'image',
  2: 'video',
  3: 'audio',
  7: 'sticker',
  13: 'location',
  22: 'flex',
};

const server = new McpServer({ name: 'line-mcp', version: '1.0.0' });
const authStore = new AsyncLocalStorage<AuthData>();

server.registerTool(
  'list_chats',
  {
    description:
      'List all LINE chats (group chats and 1:1 contacts). ' +
      'Each chat shows its mid (required by get_messages), display name, type (GROUP or USER), and member count.',
    inputSchema: {},
  },
  async () => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const client = makeLineClient(authData);
      const chats = await client.listChats();
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
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const client = makeLineClient(authData);
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
    },
  },
  async ({ url }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const client = makeLineClient(authData);
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

function makeLineClient(authData: AuthData): LineClient {
  return new LineClient(authData, globalThis.fetch, () => {
    latestAuthData.set(authData.mid, authData);
  });
}

function seedTestToken(): void {
  const testToken = process.env.TEST_TOKEN;
  const authRaw = process.env.LINE_AUTH_DATA;
  if (!testToken || !authRaw) return;
  try {
    const authData: AuthData = JSON.parse(authRaw);
    oauthSeedTestToken(testToken, authData);
    process.stderr.write('[LINE] Test token seeded from TEST_TOKEN + LINE_AUTH_DATA\n');
  } catch {
    process.stderr.write('[LINE] Warning: failed to seed test token — LINE_AUTH_DATA is not valid JSON\n');
  }
}

async function main() {
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  const WWW_AUTH = makeWwwAuthenticate(PORT);
  seedTestToken();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  setupOAuthRoutes(app, PORT);

  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  app.post('/mcp', async (req, res) => {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const authData = validateBearerToken(token);

    if (!authData) {
      res.status(401).set('WWW-Authenticate', WWW_AUTH).json({ error: 'invalid_token' });
      return;
    }

    await authStore.run(authData, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).send('Use POST /mcp');
  });

  app.listen(PORT, '0.0.0.0', () => {
    process.stderr.write(`LINE MCP server listening on http://localhost:${PORT}/mcp\n`);
    process.stderr.write(`Add to Claude Code: claude mcp add --transport http --scope user line http://localhost:${PORT}/mcp\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
