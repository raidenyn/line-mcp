import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '@raidenyn/mcp-runtime';
import type { LinePrincipal } from '../auth/line-auth-provider';
import type { CompleteImportOutcome } from '../import-service';
import type { LineToolDeps } from './deps';

interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Translates every ImportService.complete() outcome back into the exact
// content/isError shape the pre-extraction inline handler produced, so this
// is a structural move, not a behavior change.
function translateOutcome(outcome: CompleteImportOutcome): ToolTextResult {
  switch (outcome.kind) {
    case 'not_found_or_expired':
      return {
        content: [{ type: 'text', text: 'Import session expired or not found. Call initiate_import to start again.' }],
        isError: true,
      };
    case 'wrong_owner':
      return {
        content: [{ type: 'text', text: 'File ref does not belong to this user.' }],
        isError: true,
      };
    case 'needs_timezone':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'needs_info',
            missing: ['timezone'],
            message: 'What timezone are these messages in? e.g. "Asia/Bangkok", "UTC", "Europe/London"',
          }),
        }],
      };
    case 'invalid_timezone':
      return {
        content: [{
          type: 'text',
          text: `Invalid timezone "${outcome.timezone}". Use an IANA timezone name, e.g. "Asia/Bangkok", "UTC", "America/New_York".`,
        }],
        isError: true,
      };
    case 'list_chats_failed':
      return {
        content: [{ type: 'text', text: `Failed to list chats: ${outcome.error}` }],
        isError: true,
      };
    case 'no_chat_match':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'needs_info',
            missing: ['chat_mid'],
            message: `No chat found matching "${outcome.chatName}". Available chats: ${outcome.available}. Provide chat_mid explicitly.`,
          }),
        }],
      };
    case 'multiple_chat_matches':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'needs_info',
            missing: ['chat_mid'],
            candidates: outcome.candidates,
            message: `Multiple chats match "${outcome.chatName}". Please provide chat_mid from the candidates list.`,
          }),
        }],
      };
    case 'import_failed':
      return {
        content: [{ type: 'text', text: `Import failed: ${outcome.error}` }],
        isError: true,
      };
    case 'success':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            imported: outcome.imported,
            chat_mid: outcome.chat_mid,
            chat_name: outcome.chat_name,
            date_range: outcome.date_range,
          }),
        }],
      };
  }
}

export function registerInitiateImport(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
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
      const { upload_url } = deps.importService.initiate(context.principal, context.request);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ upload_url }) }] };
    },
  );
}

export function registerCompleteImport(
  server: McpServer,
  context: RequestContext<LinePrincipal>,
  deps: LineToolDeps,
): void {
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
      const outcome = await deps.importService.complete(context.principal, { file_ref_id, timezone, chat_mid });
      return translateOutcome(outcome);
    },
  );
}
