import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import { invalidArgument } from '../ledger/errors';
import { requestHash } from '../ledger/request-hash';
import {
  LABEL_MAX,
  normalizeCurrency,
  normalizeTimezone,
  optionalIdempotencyKey,
  optionalNullableString,
  optionalRevision,
  optionalString,
  parseLineSourceId,
  parseReviewFrom,
} from '../ledger/validation';
import type { BankToolDeps } from './deps';
import { runTool } from './envelope';

const ACTIONS = [
  'add_source',
  'get_source',
  'list_sources',
  'update_source',
  'get_settings',
  'update_settings',
] as const;
type Action = (typeof ACTIONS)[number];

const WRITE_KEYS = ['idempotency_key', 'expected_revision'] as const;

/** The declared fields each action may use; anything else is `invalid_argument`. */
const ALLOWED_FIELDS: Record<Action, readonly string[]> = {
  add_source: [
    'provider', 'source_id', 'label', 'timezone', 'review_from',
    'base_currency', 'owner_timezone', ...WRITE_KEYS,
  ],
  get_source: ['provider', 'source_id'],
  list_sources: [],
  update_source: ['provider', 'source_id', 'label', 'timezone', 'review_from', ...WRITE_KEYS],
  get_settings: [],
  update_settings: ['timezone', 'base_currency', ...WRITE_KEYS],
};

const DECLARED_FIELDS = [
  'action', 'provider', 'source_id', 'label', 'timezone', 'review_from',
  'base_currency', 'owner_timezone', ...WRITE_KEYS,
] as const;

function field(
  description: string,
  type: 'string' | 'integer',
): z.ZodOptional<z.ZodUnknown> {
  return z.unknown().optional().meta({ type, description });
}

const DESCRIPTION =
  'Manage the expense ledger: its LINE chat sources and the owner settings (base currency, timezone). ' +
  '`action` is required and is one of add_source, get_source, list_sources, update_source, get_settings, update_settings. ' +
  'add_source needs provider "line", source_id (the chat MID), and for the first source base_currency and owner_timezone; label, timezone, review_from are optional. ' +
  'get_source and update_source need provider and source_id. update_source changes label, timezone or review_from. ' +
  'update_settings changes the owner timezone or repeats the base currency, which can never change after the first source. ' +
  'update_source and update_settings accept idempotency_key and expected_revision; read actions do not. ' +
  'Every answer is structured: a result or an error with a code, message and sometimes an action or details.';

export function registerManageAccounts<P extends Principal>(
  server: McpServer,
  context: RequestContext<P>,
  deps: BankToolDeps<P>,
): void {
  server.registerTool(
    'manage_accounts',
    {
      description: DESCRIPTION,
      inputSchema: {
        action: field('Required. One of add_source, get_source, list_sources, update_source, get_settings, update_settings.', 'string'),
        provider: field('The source provider. Only "line" is supported.', 'string'),
        source_id: field('The LINE chat MID of the source, a string of 1-100 letters, digits, underscores or hyphens.', 'string'),
        label: field('A label for the source, up to 200 characters. On update_source, null clears it.', 'string'),
        timezone: field('The source own IANA timezone. On update_source, null returns it to the owner timezone.', 'string'),
        review_from: field('The first date to review, written YYYY-MM-DD. Defaults to three calendar months before today.', 'string'),
        base_currency: field('The owner base currency as an ISO 4217 code. Required for the first source and never changes after.', 'string'),
        owner_timezone: field('The owner IANA timezone. Required for the first source; later changes use update_settings.', 'string'),
        idempotency_key: field('A write key of 1-200 characters. A repeat with the same arguments returns the stored answer.', 'string'),
        expected_revision: field('Refuse the write with conflict when this does not match the current revision.', 'integer'),
      },
    },
    async (args) => {
      const input = args as Record<string, unknown>;
      const owner = context.principal.subject;
      return runTool(() => {
        const action = parseAction(input.action);
        for (const name of DECLARED_FIELDS) {
          if (name === 'action') continue;
          if (input[name] !== undefined && !ALLOWED_FIELDS[action].includes(name)) {
            throw invalidArgument(name, `${name} is not used by action ${action}`);
          }
        }

        const idempotencyKey = optionalIdempotencyKey(input.idempotency_key);
        const expectedRevision = optionalRevision(input.expected_revision);
        const keys = {
          idempotencyKey,
          requestHash: idempotencyKey === undefined ? undefined : requestHash(input),
          expectedRevision,
        };

        switch (action) {
          case 'add_source': {
            const provider = requireProvider(input.provider);
            const sourceId = parseLineSourceId(input.source_id);
            const baseCurrency = input.base_currency === undefined
              ? undefined
              : normalizeCurrency(input.base_currency, 'base_currency');
            const ownerTimezone = input.owner_timezone === undefined
              ? undefined
              : normalizeTimezone(input.owner_timezone, 'owner_timezone');
            const timezone = input.timezone === undefined
              ? undefined
              : normalizeTimezone(input.timezone, 'timezone');
            const result = deps.ledger.addSource(owner, {
              provider,
              source_id: sourceId,
              label: optionalString(input.label, 'label', LABEL_MAX),
              timezone,
              review_from: input.review_from === undefined
                ? undefined
                : parseReviewFrom(input.review_from, 'review_from'),
              base_currency: baseCurrency,
              owner_timezone: ownerTimezone,
            }, keys);
            return result;
          }
          case 'get_source': {
            const provider = requireProvider(input.provider);
            const sourceId = parseLineSourceId(input.source_id);
            return deps.ledger.getSource(owner, provider, sourceId);
          }
          case 'list_sources':
            return deps.ledger.listSources(owner);
          case 'update_source': {
            const provider = requireProvider(input.provider);
            const sourceId = parseLineSourceId(input.source_id);
            const timezone = optionalNullableString(input.timezone, 'timezone', 100);
            return deps.ledger.updateSource(owner, provider, sourceId, {
              label: optionalNullableString(input.label, 'label', LABEL_MAX),
              timezone: timezone === undefined || timezone === null
                ? timezone
                : normalizeTimezone(timezone, 'timezone'),
              review_from: input.review_from === undefined
                ? undefined
                : parseReviewFrom(input.review_from, 'review_from'),
            }, keys);
          }
          case 'get_settings':
            return { settings: deps.ledger.getSettings(owner) };
          case 'update_settings':
            return deps.ledger.updateSettings(owner, {
              timezone: input.timezone === undefined
                ? undefined
                : normalizeTimezone(input.timezone, 'timezone'),
              base_currency: input.base_currency === undefined
                ? undefined
                : normalizeCurrency(input.base_currency, 'base_currency'),
            }, keys);
        }
      });
    },
  );
}

function parseAction(value: unknown): Action {
  if (value === undefined) {
    throw invalidArgument('action', 'action is required');
  }
  if (typeof value !== 'string' || !(ACTIONS as readonly string[]).includes(value)) {
    throw invalidArgument('action', `action must be one of ${ACTIONS.join(', ')}`);
  }
  return value as Action;
}

function requireProvider(value: unknown): 'line' {
  if (value === undefined) {
    throw invalidArgument('provider', 'provider is required');
  }
  if (value !== 'line') {
    throw invalidArgument('provider', 'provider must be "line"');
  }
  return 'line';
}
