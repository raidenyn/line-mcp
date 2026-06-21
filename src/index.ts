import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AsyncLocalStorage } from 'async_hooks';
import express from 'express';
import { join } from 'path';
import { z } from 'zod';
import { LineClient, AuthData } from './line-client';
import { setupOAuthRoutes, validateBearerToken, latestAuthData, seedTestToken as oauthSeedTestToken, makeWwwAuthenticate, persistAuthData } from './oauth';
import { parseTransaction, summarize, expandUntilBound, TransactionTemplateSchema, TransactionSchema } from './transaction-parser';
import { upsertTemplate, deleteTemplate, listTemplates, filterByTime, loadTemplates, NamedTemplateSchema, NamedTemplate } from './template-store';

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

server.registerTool(
  'manage_templates',
  {
    description:
      'Create, update, delete, or list saved transaction regex templates for a LINE chat. ' +
      'Templates are persisted in .line-templates/<chatMid>.json and auto-loaded by get_transactions. ' +
      'Recommended workflow: call sample_messages first to inspect raw message text, ' +
      'then upsert templates here, then call get_transactions with no templates argument.',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      action: z.enum(['upsert', 'delete', 'list']).describe(
        '"upsert" — save or replace a template by name. ' +
        '"delete" — remove a named template. ' +
        '"list" — return all saved templates for this chat (full objects, in insertion order).'
      ),
      template: NamedTemplateSchema.optional().describe(
        'Required for action: upsert. Pattern rules: ' +
        'Use named capture groups — (?<currency>...) and (?<amount>...) are REQUIRED; ' +
        '(?<merchant>...), (?<date>...), (?<balance>...), (?<account>...) are optional. ' +
        'Pattern is compiled with the "s" flag (dotAll) — . matches newlines, enabling one pattern for bilingual messages. ' +
        'Backslashes must be doubled in JSON strings: \\\\d, \\\\s, \\\\. — but / does NOT need escaping. ' +
        'Bank messages often use non-breaking spaces (U+00A0) — use \\\\s+ instead of a literal space at word boundaries. ' +
        'amount_sign: "debit" stores amount as negative; "credit" as positive. ' +
        'date_format hint: "DD/MM", "DD/MM/YYYY", or "DD/MM/YYYY HH:mm" — omit if date is already ISO-parseable. ' +
        'valid_from / valid_until: ISO 8601 with timezone offset, e.g. "2025-03-01T00:00:00+07:00". ' +
        'Messages outside this window skip this template — use when the bank changed its message format.'
      ),
      name: z.string().optional().describe('Template name to remove (required for action: delete)'),
    },
  },
  async ({ chatMid, action, template, name }) => {
    if (action === 'upsert') {
      if (!template) {
        return { content: [{ type: 'text' as const, text: 'template is required for action: upsert' }], isError: true };
      }
      try {
        upsertTemplate(chatMid, template);
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
        const deleted = deleteTemplate(chatMid, name);
        if (!deleted) {
          return { content: [{ type: 'text' as const, text: `No template named '${name}' found for this chat.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `Template '${name}' deleted from chat ${chatMid}.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to delete template: ${(err as Error).message}` }], isError: true };
      }
    }

    // action === 'list'
    try {
      const templates = listTemplates(chatMid);
      const text = templates.length === 0
        ? `No templates saved for chat ${chatMid}.`
        : JSON.stringify(templates, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to list templates: ${(err as Error).message}` }], isError: true };
    }
  },
);

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
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      if (since) {
        const sinceMs = new Date(since).getTime();
        if (!Number.isFinite(sinceMs)) {
          return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
        }
      }
      if (until) {
        const untilMs = new Date(until).getTime();
        if (!Number.isFinite(untilMs)) {
          return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
        }
      }
      const client = makeLineClient(authData);
      const messages = since
        ? await client.getMessagesInRange(chatMid, new Date(since).getTime(), false)
        : await client.getMessages(chatMid, count, false);
      const textMessages = messages
        .filter((m) => m.contentType === 0 && m.text)
        .filter((m) => !until || parseInt(m.createdTime, 10) <= new Date(until).getTime())
        .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
      if (textMessages.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No text messages found.' }] };
      }
      const lines = textMessages.map((m) => {
        const time = new Date(parseInt(m.createdTime, 10)).toISOString();
        return `[${time}] ${m.text}`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to sample messages: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'get_transactions',
  {
    description:
      'Fetch messages from a LINE chat and parse them into structured transactions using regex templates. ' +
      'Non-matching messages (promotions, alerts) are silently dropped. Results are sorted oldest→newest. ' +
      'If templates is omitted, saved templates for this chat are loaded automatically from .line-templates/<chatMid>.json ' +
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
    },
  },
  async ({ chatMid, templates: suppliedTemplates, since, until }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      if (since) {
        const sinceMs = new Date(since).getTime();
        if (!Number.isFinite(sinceMs)) {
          return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
        }
      }
      if (until) {
        if (!Number.isFinite(new Date(until).getTime())) {
          return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
        }
      }
      const client = makeLineClient(authData);
      const messages = since
        ? await client.getMessagesInRange(chatMid, new Date(since).getTime(), false)
        : await client.getMessages(chatMid, 200, false);

      const warnings: string[] = [];
      let savedTemplates: NamedTemplate[] | null = null;

      if (!suppliedTemplates) {
        const loaded = loadTemplates(chatMid);
        if (loaded.warning) warnings.push(loaded.warning);
        savedTemplates = loaded.templates;

        if (savedTemplates.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No templates provided and none saved for this chat. ' +
                'Call sample_messages to inspect messages, then manage_templates (action: upsert) to save patterns.',
            }],
            isError: true,
          };
        }

        for (const t of savedTemplates) {
          if (t.valid_from && !Number.isFinite(new Date(t.valid_from).getTime())) {
            warnings.push(`Template "${t.name}": valid_from "${t.valid_from}" could not be parsed — treating as always-valid.`);
          }
          if (t.valid_until && !Number.isFinite(new Date(t.valid_until).getTime())) {
            warnings.push(`Template "${t.name}": valid_until "${t.valid_until}" could not be parsed — treating as always-valid.`);
          }
        }
      }

      let transactions = messages
        .map((msg) => {
          const templatesForMsg = savedTemplates
            ? filterByTime(savedTemplates, parseInt(msg.createdTime, 10))
            : suppliedTemplates!;
          return parseTransaction(msg, templatesForMsg);
        })
        .filter((tx) => tx !== null);

      if (since) transactions = transactions.filter((tx) => tx.date >= since);
      if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
      transactions.sort((a, b) => a.date.localeCompare(b.date));

      const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';
      const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';

      if (savedTemplates !== null && transactions.length === 0 && messages.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '0 transactions matched. Check that saved templates cover the message timestamps — ' +
              'use manage_templates (action: list) to review validity ranges.' + warningBlock + rangeNote,
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

server.registerTool(
  'summarize_transactions',
  {
    description:
      'Aggregate a list of transactions (from get_transactions) into totals and per-group breakdowns. ' +
      'Pure arithmetic — no LINE API calls. ' +
      'When transactions span multiple currencies the totals are labelled "mixed"; filter to one currency before calling if you need meaningful totals.',
    inputSchema: {
      transactions: z.array(TransactionSchema).describe('Transaction list from get_transactions'),
      group_by: z.enum(['month', 'merchant']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name'),
      since: z.string().optional().describe('ISO date — exclude transactions before this date'),
      until: z.string().optional().describe('ISO date — exclude transactions after this date'),
    },
  },
  async ({ transactions, group_by, since, until }) => {
    try {
      const result = summarize(transactions, group_by, since, until);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to summarize: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

function makeLineClient(authData: AuthData): LineClient {
  return new LineClient(authData, globalThis.fetch, () => {
    latestAuthData.set(authData.mid, authData);
    persistAuthData(authData);
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
