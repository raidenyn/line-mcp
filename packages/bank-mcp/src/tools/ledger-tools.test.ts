import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import type { MessageReader } from '@raidenyn/line-client';
import { registerBankTools, type BankToolDeps } from './index';
import { LedgerStore } from '../ledger/ledger-store';
import { TemplateStore } from '../template-store';
import { CategoryStore } from '../category-store';
import { PresetStore } from '../preset-store';
import { RegexExecutor } from '../regex-executor';

interface ToolBody {
  settings?: {
    base_currency: string;
    timezone: string;
    revision: number;
  };
  sources?: Array<Record<string, unknown>>;
  source?: Record<string, unknown>;
  error?: { code: string; message: string; action?: string; details?: Record<string, unknown> };
}

let server: McpServer;
let client: Client;
let store: LedgerStore;
let currentPrincipal: Principal;
let currentNow: number;
let regex: RegexExecutor;
let templatesDir: string;
let presetsDir: string;

function emptyReader(): MessageReader {
  return {
    getMessages: async () => [],
    getMessagesInRange: async () => [],
  };
}

function makeContext(): RequestContext<Principal> {
  return {
    get principal(): Principal {
      return currentPrincipal;
    },
    get request(): RequestContext<Principal>['request'] {
      return {} as RequestContext<Principal>['request'];
    },
  };
}

function body(result: CallToolResult): ToolBody {
  return (result.structuredContent ?? {}) as ToolBody;
}

function asOwner(owner: string): void {
  currentPrincipal = { subject: owner, scopes: [] };
}

async function call(args: Record<string, unknown>, tool = 'manage_accounts'): Promise<CallToolResult> {
  return client.callTool({ name: tool, arguments: args }) as Promise<CallToolResult>;
}

async function setupLedger(
  owner: string,
  options: { sourceId?: string; baseCurrency?: string; timezone?: string } = {},
): Promise<ToolBody> {
  asOwner(owner);
  const result = await call({
    action: 'add_source',
    provider: 'line',
    source_id: options.sourceId ?? 'c-primary',
    base_currency: options.baseCurrency ?? 'THB',
    owner_timezone: options.timezone ?? 'Asia/Bangkok',
  });
  expect(result.isError).toBeFalsy();
  return body(result);
}

beforeEach(async () => {
  currentNow = Date.parse('2026-05-31T12:00:00Z');
  currentPrincipal = { subject: 'u-alice', scopes: [] };
  templatesDir = mkdtempSync(join(tmpdir(), 'ledger-tools-tmpl-'));
  presetsDir = mkdtempSync(join(tmpdir(), 'ledger-tools-presets-'));
  store = new LedgerStore(':memory:', { now: () => currentNow });
  regex = new RegexExecutor();
  const deps: BankToolDeps<Principal> = {
    createMessageReader: async () => emptyReader(),
    templates: new TemplateStore(templatesDir),
    categories: new CategoryStore(':memory:'),
    presets: new PresetStore(presetsDir),
    regex,
    ledger: store,
  };
  server = new McpServer({ name: 'ledger-tools-test', version: '0.0.0' });
  registerBankTools(server, makeContext(), deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'ledger-tools-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  store.close();
  await regex.close();
  rmSync(templatesDir, { recursive: true, force: true });
  rmSync(presetsDir, { recursive: true, force: true });
});

describe('ledger_status (acceptance criteria 1)', () => {
  it('answers setup_required with an action before the first source', async () => {
    asOwner('u-fresh');
    const result = await call({}, 'ledger_status');
    expect(result.isError).toBe(true);
    expect(body(result).error?.code).toBe('setup_required');
    expect(body(result).error?.action).toMatch(/manage_accounts.*add_source.*base_currency.*owner_timezone/s);
    // The text carries the same structured JSON.
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(result.structuredContent) });
  });
});

describe('validation stays inside the envelope', () => {
  it('answers a wrong type, an unknown or missing action and fields an action does not use', async () => {
    asOwner('u-fresh');
    const cases: Array<Record<string, unknown>> = [
      {},
      { action: 'nope' },
      { action: 'add_source', provider: 5, source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC' },
      { action: 'add_source', provider: 'x', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC' },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', label: null },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', review_from: null },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: null, owner_timezone: 'UTC' },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'Mars/Base' },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: '+07:00' },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'ABC', owner_timezone: 'UTC' },
      { action: 'add_source', provider: 'line', source_id: 'a/b', base_currency: 'THB', owner_timezone: 'UTC' },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', expected_revision: 0 },
      { action: 'add_source', provider: 'line', source_id: 'c-one', base_currency: 'THB', owner_timezone: 'UTC', idempotency_key: 'x'.repeat(201) },
      { action: 'list_sources', idempotency_key: 'k' },
      { action: 'list_sources', expected_revision: 1 },
      { action: 'get_settings', idempotency_key: 'k' },
    ];
    for (const args of cases) {
      const result = await call(args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(body(result).error?.code, JSON.stringify(args)).toBe('invalid_argument');
    }
    // A bad argument is invalid_argument even before setup.
    expect(body(await call({ action: 'list_sources', idempotency_key: 'k' })).error?.code).toBe('invalid_argument');
  });

  it('refuses a field the chosen action does not use after setup too', async () => {
    await setupLedger('u-alice');
    const baseCurrencyOnUpdate = await call({
      action: 'update_source', provider: 'line', source_id: 'c-primary', base_currency: 'USD',
    });
    expect(body(baseCurrencyOnUpdate).error?.code).toBe('invalid_argument');
    expect(body(baseCurrencyOnUpdate).error?.details).toMatchObject({ field: 'base_currency' });
  });
});

describe('manage_accounts and ledger_status (acceptance criterion 2)', () => {
  it('lists an added source and refuses another base currency with conflict', async () => {
    asOwner('u-alice');
    const added = await call({
      action: 'add_source', provider: 'line', source_id: 'c-chat', base_currency: 'THB', owner_timezone: 'Asia/Bangkok',
    });
    expect(added.isError).toBeFalsy();
    expect(body(added).settings).toEqual({ base_currency: 'THB', timezone: 'Asia/Bangkok', revision: 1 });
    expect(body(added).source).toMatchObject({
      provider: 'line', source_id: 'c-chat', native_id: 'c-chat', timezone: 'Asia/Bangkok', own_timezone: null, revision: 1,
    });

    const status = await call({}, 'ledger_status');
    expect(status.isError).toBeFalsy();
    expect(body(status).sources).toHaveLength(1);
    expect(body(status).sources?.[0]).toMatchObject({ source_id: 'c-chat', native_id: 'c-chat' });
    expect(body(status).settings).toMatchObject({ base_currency: 'THB' });

    const conflict = await call({ action: 'update_settings', base_currency: 'USD' });
    expect(conflict.isError).toBe(true);
    expect(body(conflict).error?.code).toBe('conflict');
    expect(body(conflict).error?.details).toMatchObject({ current: 'THB' });

    const listed = await call({ action: 'list_sources' });
    expect(body(listed).settings?.base_currency).toBe('THB');
  });

  it('accepts thb as THB and keeps a label with quotes and emoji unchanged', async () => {
    asOwner('u-alice');
    await setupLedger('u-alice');
    const result = await call({
      action: 'add_source', provider: 'line', source_id: 'c-second', base_currency: 'thb', owner_timezone: 'Asia/Bangkok',
      label: 'Card "gold" 🥇',
    });
    expect(result.isError).toBeFalsy();
    expect(body(result).settings?.base_currency).toBe('THB');
    expect(body(result).source?.label).toBe('Card "gold" 🥇');

    const fetched = await call({ action: 'get_source', provider: 'line', source_id: 'c-second' });
    expect(body(fetched).source?.label).toBe('Card "gold" 🥇');

    const cleared = await call({ action: 'update_source', provider: 'line', source_id: 'c-second', label: null });
    expect(cleared.isError).toBeFalsy();
    expect(body(cleared).source?.label).toBeNull();
  });

  it('answers setup_required for every action except add_source', async () => {
    asOwner('u-fresh');
    const cases: Array<Record<string, unknown>> = [
      { action: 'get_source', provider: 'line', source_id: 'c-one' },
      { action: 'list_sources' },
      { action: 'update_source', provider: 'line', source_id: 'c-one', label: 'x' },
      { action: 'get_settings' },
      { action: 'update_settings', timezone: 'UTC' },
    ];
    for (const args of cases) {
      const result = await call(args);
      expect(body(result).error?.code, JSON.stringify(args)).toBe('setup_required');
      expect(body(result).error?.action).toBeTruthy();
    }
  });
});

describe('idempotency and revisions (acceptance criterion 4)', () => {
  it('applies a repeated update_source once and refuses a stale expected_revision', async () => {
    await setupLedger('u-alice');
    const args = { action: 'update_source', provider: 'line', source_id: 'c-primary', label: 'renamed', idempotency_key: 'once' };
    const first = await call(args);
    expect(first.isError).toBeFalsy();
    currentNow += 60_000;
    const replay = await call(args);
    expect(replay).toEqual(first);
    expect(body(replay).source?.revision).toBe(2);
    expect(body(replay).source?.updated_at).toBe(body(first).source?.updated_at);

    const stale = await call({ action: 'update_source', provider: 'line', source_id: 'c-primary', label: 'stale', expected_revision: 1 });
    expect(body(stale).error?.code).toBe('conflict');
    expect(body(stale).error?.details).toMatchObject({ current_revision: 2 });

    const fetched = await call({ action: 'get_source', provider: 'line', source_id: 'c-primary' });
    expect(body(fetched).source?.label).toBe('renamed');
  });

  it('refuses an idempotency key reused with other arguments', async () => {
    await setupLedger('u-alice');
    await call({ action: 'update_settings', timezone: 'Europe/Berlin', idempotency_key: 'k' });
    const reused = await call({ action: 'update_settings', timezone: 'Asia/Tokyo', idempotency_key: 'k' });
    expect(body(reused).error?.code).toBe('conflict');
    expect(body(reused).error?.details).toMatchObject({ reason: 'idempotency_key_reused' });
  });

  it('replays an add_source retry across midnight in the source timezone', async () => {
    currentNow = Date.parse('2026-05-31T16:59:00Z'); // 23:59 in Bangkok
    asOwner('u-midnight');
    const args = {
      action: 'add_source', provider: 'line', source_id: 'c-midnight',
      base_currency: 'THB', owner_timezone: 'Asia/Bangkok', idempotency_key: 'midnight-retry',
    };
    const first = await call(args);
    expect(first.isError).toBeFalsy();
    expect(body(first).source?.review_from).toBe('2026-02-28');
    currentNow = Date.parse('2026-05-31T17:01:00Z'); // 00:01 in Bangkok
    const replay = await call(args);
    expect(replay).toEqual(first);
  });
});

describe('timezone handling', () => {
  it('inherits the owner timezone, follows later changes, keeps an own one and refuses a second owner value', async () => {
    await setupLedger('u-alice');
    // The first source has no own timezone and follows the owner's.
    let status = await call({}, 'ledger_status');
    expect(body(status).sources?.[0]).toMatchObject({ timezone: 'Asia/Bangkok', own_timezone: null });

    const changed = await call({ action: 'update_settings', timezone: 'Europe/Berlin' });
    expect(changed.isError).toBeFalsy();
    status = await call({}, 'ledger_status');
    expect(body(status).sources?.[0]).toMatchObject({ timezone: 'Europe/Berlin', own_timezone: null });

    const own = await call({
      action: 'add_source', provider: 'line', source_id: 'c-own', timezone: 'Asia/Tokyo', base_currency: 'THB', owner_timezone: 'Europe/Berlin',
    });
    expect(body(own).source).toMatchObject({ timezone: 'Asia/Tokyo', own_timezone: 'Asia/Tokyo' });

    const conflict = await call({
      action: 'add_source', provider: 'line', source_id: 'c-third', base_currency: 'THB', owner_timezone: 'Asia/Tokyo',
    });
    expect(body(conflict).error?.code).toBe('conflict');
    expect(body(conflict).error?.action).toMatch(/update_settings/);

    const reset = await call({ action: 'update_source', provider: 'line', source_id: 'c-own', timezone: null });
    expect(body(reset).source).toMatchObject({ timezone: 'Europe/Berlin', own_timezone: null });
  });

  it('defaults review_from in the source effective timezone', async () => {
    currentNow = Date.parse('2026-06-01T15:30:00Z'); // 2 June 00:30 in Tokyo
    asOwner('u-tokyo');
    const result = await call({
      action: 'add_source', provider: 'line', source_id: 'c-tokyo', base_currency: 'THB',
      owner_timezone: 'UTC', timezone: 'Asia/Tokyo',
    });
    expect(body(result).source?.review_from).toBe('2026-03-02');
  });
});

describe('tools/list', () => {
  it('advertises the declared types, the required action and no ledger_status fields', async () => {
    const listed = await client.listTools();
    const manage = listed.tools.find((tool) => tool.name === 'manage_accounts');
    expect(manage).toBeDefined();
    expect(manage?.description).toMatch(/action.*required/is);
    const properties = manage?.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties.provider.type).toBe('string');
    expect(properties.expected_revision.type).toBe('integer');
    expect(properties.action.type).toBe('string');

    const status = listed.tools.find((tool) => tool.name === 'ledger_status');
    expect(status).toBeDefined();
    const statusProperties = (status?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(statusProperties).not.toHaveProperty('idempotency_key');
    expect(statusProperties).not.toHaveProperty('expected_revision');
  });
});
