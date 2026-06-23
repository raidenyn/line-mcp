import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import express from 'express';
import type { Request as ExpressRequest } from 'express';
import { join } from 'path';
import { z } from 'zod';
import { LineClient, AuthData } from './line-client';
import { setupOAuthRoutes, validateBearerToken, latestAuthData, seedTestToken as oauthSeedTestToken, makeWwwAuthenticate, persistAuthData, pendingUploads, pendingFiles } from './oauth';
import { CachingLineClient } from './caching-line-client';
import { MessageCache } from './message-cache';
import { parseTransaction, summarize, expandUntilBound, applyBalanceDiffs, TransactionTemplateSchema, Transaction } from './transaction-parser';
import { upsertTemplate, deleteTemplate, listTemplates, filterByTime, loadTemplates, NamedTemplateSchema } from './template-store';
import { parseExportFile } from './export-parser';
import { startSyncLoop } from './sync';

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
const requestStore = new AsyncLocalStorage<ExpressRequest>();
let sharedCache: MessageCache;

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
        ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
        : await client.getMessages(chatMid, count);
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

async function fetchParsedTransactions(
  authData: AuthData,
  chatMid: string,
  since?: string,
  until?: string,
): Promise<
  | { transactions: Transaction[]; warnings: string[]; rangeNote: string }
  | { error: string }
> {
  if (since && !Number.isFinite(new Date(since).getTime())) {
    return { error: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` };
  }
  if (until && !Number.isFinite(new Date(until).getTime())) {
    return { error: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` };
  }

  const warnings: string[] = [];
  const loaded = loadTemplates(chatMid);
  if (loaded.warning) warnings.push(loaded.warning);
  const savedTemplates = loaded.templates;

  if (savedTemplates.length === 0) {
    return {
      error:
        'No templates provided and none saved for this chat. ' +
        'Call sample_messages to inspect messages, then manage_templates (action: upsert) to save patterns.',
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

  const client = makeLineClient(authData);
  const messages = since
    ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
    : await client.getMessages(chatMid, 200);

  let transactions = messages
    .map((msg) => {
      const templatesForMsg = filterByTime(savedTemplates, parseInt(msg.createdTime, 10));
      return parseTransaction(msg, templatesForMsg);
    })
    .filter((tx) => tx !== null);

  if (since) transactions = transactions.filter((tx) => tx.date >= since);
  if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  applyBalanceDiffs(transactions);

  const rangeNote = since
    ? ''
    : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';

  return { transactions, warnings, rangeNote };
}

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
      if (suppliedTemplates) {
        // Inline-template path — unchanged from before
        if (since && !Number.isFinite(new Date(since).getTime())) {
          return { content: [{ type: 'text' as const, text: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` }], isError: true };
        }
        if (until && !Number.isFinite(new Date(until).getTime())) {
          return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
        }
        const client = makeLineClient(authData);
        const messages = since
          ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
          : await client.getMessages(chatMid, 200);
        let transactions = messages
          .map((msg) => parseTransaction(msg, suppliedTemplates))
          .filter((tx) => tx !== null);
        if (since) transactions = transactions.filter((tx) => tx.date >= since);
        if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
        transactions.sort((a, b) => a.date.localeCompare(b.date));
        applyBalanceDiffs(transactions);
        const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
        return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + rangeNote }] };
      }

      // Saved-templates path — delegate to helper
      const fetched = await fetchParsedTransactions(authData, chatMid, since, until);
      if ('error' in fetched) {
        return { content: [{ type: 'text' as const, text: fetched.error }], isError: true };
      }
      const { transactions, warnings, rangeNote } = fetched;
      const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';

      if (transactions.length === 0) {
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
      'Fetch transactions from a LINE chat and aggregate them into totals and per-group breakdowns. ' +
      'Uses saved templates (set up via manage_templates). ' +
      'When transactions span multiple currencies the totals are labelled "mixed".',
    inputSchema: {
      chatMid: z.string().describe('Chat MID from list_chats'),
      group_by: z.enum(['month', 'merchant']).describe('"month" groups by YYYY-MM; "merchant" groups by merchant name'),
      since: z.string().optional().describe('ISO date — exclude transactions before this date'),
      until: z.string().optional().describe('ISO date — exclude transactions after this date'),
    },
  },
  async ({ chatMid, group_by, since, until }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    try {
      const fetched = await fetchParsedTransactions(authData, chatMid, since, until);
      if ('error' in fetched) {
        return { content: [{ type: 'text' as const, text: fetched.error }], isError: true };
      }
      const { transactions, warnings, rangeNote } = fetched;
      const result = summarize(transactions, group_by, since, until);
      const warningBlock = warnings.length > 0 ? '\n\nWarnings:\n' + warnings.join('\n') : '';
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) + warningBlock + rangeNote }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to summarize: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'initiate_import',
  {
    description:
      'Start a LINE chat export import. Returns a one-time upload URL (valid 15 minutes). ' +
      'After receiving the URL, upload the export .txt file with: ' +
      'curl -X POST --data-binary @/path/to/file.txt -H "Content-Type: text/plain" "<upload_url>" ' +
      'The response includes a file_ref_id to use with complete_import.',
    inputSchema: {},
  },
  async () => {
    const req = requestStore.getStore();
    const authData = authStore.getStore();
    if (!req) {
      return { content: [{ type: 'text' as const, text: 'Request context unavailable.' }], isError: true };
    }
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }
    // Prune expired upload tokens to prevent unbounded memory growth
    const nowMs = Date.now();
    for (const [k, v] of pendingUploads) {
      if (v.expires < nowMs) pendingUploads.delete(k);
    }
    const token = crypto.randomUUID();
    pendingUploads.set(token, { mid: authData.mid, expires: Date.now() + 900_000 }); // 15 min
    const base = process.env['PUBLIC_URL']?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${base}/import-upload?token=${token}`;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ upload_url: uploadUrl }),
      }],
    };
  },
);

server.registerTool(
  'complete_import',
  {
    description:
      'Complete a LINE chat export import started with initiate_import. ' +
      'Always ask the user for their timezone (IANA name, e.g. "Asia/Bangkok") before calling if not already known. ' +
      'Returns status "needs_info" when chat_mid or timezone are required — ask the user and retry. ' +
      'Returns status "success" with import count and date range when done.',
    inputSchema: {
      file_ref_id: z.string().describe('From the curl response after uploading to upload_url'),
      timezone: z.string().optional().describe('IANA timezone name, e.g. "Asia/Bangkok". Ask the user explicitly.'),
      chat_mid: z.string().optional().describe('Override auto-detection. Use when complete_import returns candidates.'),
    },
  },
  async ({ file_ref_id, timezone, chat_mid }) => {
    const authData = authStore.getStore();
    if (!authData) {
      return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true };
    }

    const fileEntry = pendingFiles.get(file_ref_id);
    if (!fileEntry || fileEntry.expires < Date.now()) {
      pendingFiles.delete(file_ref_id);
      return {
        content: [{ type: 'text' as const, text: 'Import session expired or not found. Call initiate_import to start again.' }],
        isError: true,
      };
    }
    if (fileEntry.mid !== authData.mid) {
      return { content: [{ type: 'text' as const, text: 'File ref does not belong to this user.' }], isError: true };
    }

    if (!timezone) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'needs_info',
            missing: ['timezone'],
            message: 'What timezone are these messages in? e.g. "Asia/Bangkok", "UTC", "Europe/London"',
          }),
        }],
      };
    }

    // Validate timezone
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      return {
        content: [{
          type: 'text' as const,
          text: `Invalid timezone "${timezone}". Use an IANA timezone name, e.g. "Asia/Bangkok", "UTC", "America/New_York".`,
        }],
        isError: true,
      };
    }

    let resolvedMid = chat_mid;
    const { content, chatName } = fileEntry;

    if (!resolvedMid) {
      try {
        const client = makeLineClient(authData);
        const chats = await client.listChats();
        const lower = chatName.toLowerCase();
        const matches = chats.filter(c => c.name.toLowerCase() === lower);
        if (matches.length === 0) {
          const available = chats.map(c => c.name).join(', ');
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'needs_info',
                missing: ['chat_mid'],
                message: `No chat found matching "${chatName}". Available chats: ${available}. Provide chat_mid explicitly.`,
              }),
            }],
          };
        }
        if (matches.length > 1) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'needs_info',
                missing: ['chat_mid'],
                candidates: matches.map(c => ({ chat_mid: c.mid, name: c.name })),
                message: `Multiple chats match "${chatName}". Please provide chat_mid from the candidates list.`,
              }),
            }],
          };
        }
        resolvedMid = matches[0].mid;
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list chats: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    try {
      const messages = parseExportFile(content, resolvedMid, timezone);
      sharedCache.upsertMessages(resolvedMid, messages);
      pendingFiles.delete(file_ref_id); // clean up after success

      const timestamps = messages.map(m => parseInt(m.createdTime, 10)).filter(Number.isFinite);
      const dateRange = timestamps.length > 0
        ? {
            from: new Date(timestamps.reduce((a, b) => b < a ? b : a)).toISOString(),
            to:   new Date(timestamps.reduce((a, b) => b > a ? b : a)).toISOString(),
          }
        : null;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'success',
            imported: messages.length,
            chat_mid: resolvedMid,
            chat_name: chatName,
            date_range: dateRange,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Import failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

function makeLineClient(authData: AuthData): CachingLineClient {
  return new CachingLineClient(
    new LineClient(authData, globalThis.fetch, () => {
      latestAuthData.set(authData.mid, authData);
      persistAuthData(authData);
    }),
    sharedCache,
  );
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
  sharedCache = new MessageCache('.line-cache/messages.db');
  startSyncLoop(sharedCache);
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

    await requestStore.run(req, async () => {
      await authStore.run(authData, async () => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close().catch(() => {}); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
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
