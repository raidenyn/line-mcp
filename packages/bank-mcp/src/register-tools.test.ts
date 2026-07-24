import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext, Principal } from '@raidenyn/mcp-runtime';
import type { Message, MessageReader } from '@raidenyn/line-client';
import { registerBankTools, type BankToolDeps } from './tools';
import { registerBankResources } from './resources';
import { TemplateStore } from './template-store';
import { CategoryStore } from './category-store';
import { PresetStore } from './preset-store';
import { RegexExecutor } from './regex-executor';
import { buildAmountWarnings } from './tools/fetch-transactions';

// ─── Minimal fakes ─────────────────────────────────────────────────────────
// A fake server that just captures the tool/resource handlers registered
// against it, so we can invoke a tool by name without a real MCP transport.

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

class FakeServer {
  readonly tools = new Map<string, ToolHandler>();
  readonly resources = new Map<string, string>();
  registerTool(name: string, _schema: unknown, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }
  registerResource(id: string, uri: string, _meta: unknown, _reader: unknown): void {
    this.resources.set(uri, id);
  }
}

function textMsg(id: string, text: string, createdTime: string): Message {
  return { id, from: 'c', to: 'c', toType: 1, createdTime, contentType: 0, hasContent: false, text } as Message;
}

// A principal-bound reader that always returns a fixed message list — no LINE
// API, no auth, no network. Isolation between principals is achieved by
// createMessageReader below handing each principal its own list.
function fakeReader(messages: Message[]): MessageReader {
  return {
    getMessages: async () => messages,
    getMessagesInRange: async () => messages,
  };
}

const SHARED_TEMPLATE = {
  name: 't1',
  pattern: 'SPENT (?<original_currency>THB) (?<original_amount>[\\d.,]+) at (?<merchant>\\w+)',
  amount_sign: 'debit' as const,
};

let templatesDir: string;
let presetsDir: string;
let currentPrincipal: Principal;
let readerCreations: string[];
let regex: RegexExecutor;

function makeContext(): RequestContext<Principal> {
  return {
    get principal(): Principal {
      return currentPrincipal;
    },
    // Bank tools never read `request`; a stub is enough to satisfy the type.
    get request(): RequestContext<Principal>['request'] {
      return {} as RequestContext<Principal>['request'];
    },
  };
}

function makeDeps(messagesByPrincipal: Record<string, Message[]> = {
  'user-a': [textMsg('a1', 'SPENT THB 100.00 at StoreA', '1000')],
  'user-b': [textMsg('b1', 'SPENT THB 200.00 at StoreB', '2000')],
}): BankToolDeps<Principal> {
  return {
    createMessageReader: async (p: Principal) => {
      readerCreations.push(p.subject);
      return fakeReader(messagesByPrincipal[p.subject] ?? []);
    },
    // Real stores, pointed at throwaway temp locations — deliberately ONE
    // instance each, shared by every principal (trusted-tenant model).
    templates: new TemplateStore(templatesDir),
    categories: new CategoryStore(':memory:'),
    presets: new PresetStore(presetsDir), // empty dir → no built-in presets
    regex,
  };
}

beforeEach(() => {
  templatesDir = mkdtempSync(join(tmpdir(), 'bank-tmpl-'));
  presetsDir = mkdtempSync(join(tmpdir(), 'bank-presets-'));
  readerCreations = [];
  currentPrincipal = { subject: 'user-a', scopes: [] };
  regex = new RegexExecutor();
});
afterEach(async () => {
  await regex.close();
  rmSync(templatesDir, { recursive: true, force: true });
  rmSync(presetsDir, { recursive: true, force: true });
});

// Strips the trailing rangeNote/warnings so the leading JSON payload parses.
function parsePayload(text: string): unknown {
  return JSON.parse(text.split('\n\n')[0]);
}

describe('registerBankTools', () => {
  it('registers exactly the five bank tools', () => {
    const server = new FakeServer();
    registerBankTools(server as unknown as McpServer, makeContext(), makeDeps());
    expect([...server.tools.keys()].sort()).toEqual(
      ['get_transactions', 'manage_categories', 'manage_templates', 'sample_messages', 'summarize_transactions'].sort(),
    );
  });

  it('gives two principals isolated readers but shares one category/template store (trusted-tenant)', async () => {
    const server = new FakeServer();
    const deps = makeDeps();
    registerBankTools(server as unknown as McpServer, makeContext(), deps);

    // Principal A saves a template + a category into the SHARED stores.
    currentPrincipal = { subject: 'user-a', scopes: [] };
    const upsertT = await server.tools.get('manage_templates')!({
      chatMid: 'chatX', action: 'upsert', template: SHARED_TEMPLATE,
    });
    expect(upsertT.isError).toBeFalsy();
    const upsertC = await server.tools.get('manage_categories')!({
      action: 'upsert', category: { name: 'Shopping', pattern: 'Store' },
    });
    expect(upsertC.isError).toBeFalsy();

    // Principal B — DIFFERENT principal — reads transactions. It supplies no
    // inline templates, so it must pick up A's SHARED saved template; its
    // reader must be B's own (StoreB / 200), not A's; and A's SHARED category
    // must tag it.
    currentPrincipal = { subject: 'user-b', scopes: [] };
    const resB = await server.tools.get('get_transactions')!({ chatMid: 'chatX' });
    expect(resB.isError).toBeFalsy();
    const txB = parsePayload(resB.content[0].text) as Array<Record<string, unknown>>;
    expect(txB).toHaveLength(1);
    expect(txB[0].merchant).toBe('StoreB');        // B's OWN reader was used
    expect(txB[0].original_amount).toBe(-200);      // debit sign applied
    expect(txB[0].category).toBe('Shopping');       // A's SHARED category applied

    // Principal A reads: its reader is isolated (StoreA / 100), while the same
    // shared template + category still apply.
    currentPrincipal = { subject: 'user-a', scopes: [] };
    const resA = await server.tools.get('get_transactions')!({ chatMid: 'chatX' });
    const txA = parsePayload(resA.content[0].text) as Array<Record<string, unknown>>;
    expect(txA).toHaveLength(1);
    expect(txA[0].merchant).toBe('StoreA');
    expect(txA[0].original_amount).toBe(-100);
    expect(txA[0].category).toBe('Shopping');

    // A fresh reader was created per principal invocation — the per-owner seam.
    expect(readerCreations).toContain('user-a');
    expect(readerCreations).toContain('user-b');
  });

  it('warns both transaction tools and summarizes unlabelled amounts separately', async () => {
    const server = new FakeServer();
    const deps = makeDeps({
      'user-a': [textMsg('a1', 'FX USD 50 CHARGED 1750', '1782864000000')],
    });
    registerBankTools(server as unknown as McpServer, makeContext(), deps);

    const saved = await server.tools.get('manage_templates')!({
      chatMid: 'chatX',
      action: 'upsert',
      template: {
        name: 'unlabelled-fx',
        pattern: 'FX (?<original_currency>USD) (?<original_amount>[\\d.]+) CHARGED (?<amount>[\\d.]+)',
        amount_sign: 'debit',
      },
    });
    expect(saved.isError).toBeFalsy();

    const warning = '1 transaction(s) have an amount with unknown currency; summaries report these amounts separately under unknown_currency and unknown_by_group.';
    const transactions = await server.tools.get('get_transactions')!({ chatMid: 'chatX' });
    expect(transactions.isError).toBeFalsy();
    expect(transactions.content[0].text).toContain(warning);

    const summary = await server.tools.get('summarize_transactions')!({
      chatMid: 'chatX',
      group_by: 'month',
    });
    expect(summary.isError).toBeFalsy();
    expect(summary.content[0].text).toContain(warning);
    expect(parsePayload(summary.content[0].text)).toMatchObject({
      total_debit: 0,
      currency: 'none',
      unknown_currency: {
        total_debit: 1750,
        transactions_count: 1,
      },
    });
  });

  it('does not warn when a derived amount has its balance currency', () => {
    expect(buildAmountWarnings([
      {
        id: 'm1',
        date: '2026-06-01T00:00:00.000Z',
        original_amount: -50,
        original_currency: 'USD',
        amount: -1750,
        currency: 'THB',
        amount_estimated: true,
        rawText: '',
      },
    ])).not.toContain(
      '1 transaction(s) have an amount with unknown currency; summaries report these amounts separately under unknown_currency and unknown_by_group.',
    );
  });
});

describe('registerBankResources', () => {
  it('registers the shared overview plus five tool guides by default', () => {
    const server = new FakeServer();
    registerBankResources(server as unknown as McpServer);
    expect(server.resources.size).toBe(6);
    expect([...server.resources.keys()]).toContain('line://guide');
  });

  it('omits the shared overview URI when includeOverview is false', () => {
    const server = new FakeServer();
    registerBankResources(server as unknown as McpServer, { includeOverview: false });
    const uris = [...server.resources.keys()];
    expect(uris).toHaveLength(5);
    expect(uris).not.toContain('line://guide');
  });
});
