import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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

  describe('persistence validation', () => {
    it('rejects an invalid template before persistence', async () => {
      const server = new FakeServer();
      const deps = makeDeps();
      registerBankTools(server as unknown as McpServer, makeContext(), deps);
      const result = await server.tools.get('manage_templates')!({
        chatMid: 'chatX', action: 'upsert',
        template: { name: 'bad', pattern: '([invalid', amount_sign: 'debit' },
      });
      expect(result.isError).toBe(true);
      expect(deps.templates.list('chatX')).toEqual([]);
    });

    it('rejects an invalid category before persistence', async () => {
      const server = new FakeServer();
      const deps = makeDeps();
      registerBankTools(server as unknown as McpServer, makeContext(), deps);
      const result = await server.tools.get('manage_categories')!({
        action: 'upsert', category: { name: 'bad', pattern: '([invalid' },
      });
      expect(result.isError).toBe(true);
      expect(deps.categories.list()).toEqual([]);
    });

    it('applies no preset writes when any preset template is invalid (all-or-nothing)', async () => {
      const server = new FakeServer();
      const deps = makeDeps();
      registerBankTools(server as unknown as McpServer, makeContext(), deps);

      // A preset with a valid template first, then an invalid one. Validation
      // must complete before the first write, so neither templates nor
      // aliases reach the store.
      writeFileSync(
        join(presetsDir, 'mixed.json'),
        JSON.stringify({
          description: 'mixed',
          templates: [
            { name: 'good', pattern: 'SPENT (?<original_currency>THB) (?<original_amount>[\\d.,]+)', amount_sign: 'debit' },
            { name: 'bad', pattern: '([invalid', amount_sign: 'debit' },
          ],
          currency_aliases: { บาท: 'THB' },
        }),
      );

      const result = await server.tools.get('manage_templates')!({
        chatMid: 'chatX', action: 'apply_preset', preset_name: 'mixed',
      });
      expect(result.isError).toBe(true);
      expect(deps.templates.list('chatX')).toEqual([]);
      expect(deps.templates.listAliases('chatX')).toEqual({});
    });
  });

  describe('full-call regex timeout containment', () => {
    // A message that triggers catastrophic backtracking against (a|aa)+$.
    const EVIL_MSG = `prefix ${'a'.repeat(40)}!`;

    function makeTimeoutDeps(
      executor: RegexExecutor,
      messagesByPrincipal: Record<string, Message[]>,
    ): BankToolDeps<Principal> {
      return {
        createMessageReader: async (p: Principal) => {
          readerCreations.push(p.subject);
          return fakeReader(messagesByPrincipal[p.subject] ?? []);
        },
        templates: new TemplateStore(templatesDir),
        categories: new CategoryStore(':memory:'),
        presets: new PresetStore(presetsDir),
        regex: executor,
      };
    }

    it('contains an inline-template timeout in get_transactions', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        const result = await server.tools.get('get_transactions')!({
          chatMid: 'chatX',
          templates: [{ pattern: '(a|aa)+$', amount_sign: 'debit' }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('get transactions');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });

    it('contains a saved-template timeout in get_transactions', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        // First save the evil template using a separate (non-timeout) server so
        // persistence validation passes — the timeout surface is get_transactions.
        const saveServer = new FakeServer();
        const saveDeps = makeDeps({ 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(saveServer as unknown as McpServer, makeContext(), saveDeps);
        const saved = await saveServer.tools.get('manage_templates')!({
          chatMid: 'chatX', action: 'upsert',
          template: { name: 'evil', pattern: '(a|aa)+$', amount_sign: 'debit' },
        });
        expect(saved.isError).toBeFalsy();
        // Now the shared templatesDir holds the evil template; the timeout
        // deps read from the same dir.
        const result = await server.tools.get('get_transactions')!({ chatMid: 'chatX' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('get transactions');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });

    it('contains a category timeout after one transaction is parsed', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', `SPENT THB 100.00 at ${'a'.repeat(40)}!`, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        // Save a valid template WITHOUT a merchant capture so categorize
        // falls back to rawText (which ends in the trailing '!' that defeats
        // the (a|aa)+$ anchor and forces catastrophic backtracking). Then insert
        // an evil category directly into the timeout deps' in-memory store —
        // CategoryStore(':memory:') is not shared across makeDeps calls, so a
        // direct upsert is the reliable setup. The evil pattern compiles fine;
        // the timeout fires later inside categorize's regex.test.
        const saveServer = new FakeServer();
        const saveDeps = makeDeps({ 'user-a': [textMsg('m1', `SPENT THB 100.00 at ${'a'.repeat(40)}!`, '1000')] });
        registerBankTools(saveServer as unknown as McpServer, makeContext(), saveDeps);
        await saveServer.tools.get('manage_templates')!({
          chatMid: 'chatX', action: 'upsert',
          template: {
            name: 'good',
            pattern: 'SPENT (?<original_currency>THB) (?<original_amount>[\\d.,]+) at [\\w]+!',
            amount_sign: 'debit',
          },
        });
        deps.categories.upsert({ name: 'Evil', pattern: '(a|aa)+$' });
        const result = await server.tools.get('get_transactions')!({ chatMid: 'chatX' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('get transactions');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });

    it('contains a merchant-filter timeout in get_transactions', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', `SPENT THB 100.00 at ${'a'.repeat(40)}!`, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        // Save a valid template WITHOUT a merchant capture so filterTransactions
        // falls back to rawText (which ends in the trailing '!' that defeats
        // the (a|aa)+$ anchor and forces catastrophic backtracking). No
        // categories are saved, so categorize completes instantly; the timeout
        // fires inside filterTransactions when testing the merchants filter.
        const saveServer = new FakeServer();
        const saveDeps = makeDeps({ 'user-a': [textMsg('m1', `SPENT THB 100.00 at ${'a'.repeat(40)}!`, '1000')] });
        registerBankTools(saveServer as unknown as McpServer, makeContext(), saveDeps);
        await saveServer.tools.get('manage_templates')!({
          chatMid: 'chatX', action: 'upsert',
          template: {
            name: 'good',
            pattern: 'SPENT (?<original_currency>THB) (?<original_amount>[\\d.,]+) at [\\w]+!',
            amount_sign: 'debit',
          },
        });
        const result = await server.tools.get('get_transactions')!({
          chatMid: 'chatX', merchants: ['(a|aa)+$'],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('get transactions');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });

    it('contains a saved-template timeout during sample_messages preset detection', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        // Save an evil template via a non-timeout server; detectPresets will
        // test it against the message and time out.
        const saveServer = new FakeServer();
        const saveDeps = makeDeps({ 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(saveServer as unknown as McpServer, makeContext(), saveDeps);
        await saveServer.tools.get('manage_templates')!({
          chatMid: 'chatX', action: 'upsert',
          template: { name: 'evil', pattern: '(a|aa)+$', amount_sign: 'debit' },
        });
        // Write any preset so detectPresets has a preset to consider; the
        // saved-template test runs first and times out.
        writeFileSync(
          join(presetsDir, 'p.json'),
          JSON.stringify({
            description: 'p',
            templates: [{ name: 'p1', pattern: 'SPENT THB (?<original_amount>\\d+)', amount_sign: 'debit' }],
            currency_aliases: {},
          }),
        );
        const result = await server.tools.get('sample_messages')!({ chatMid: 'chatX', count: 20 });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('sample messages');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });

    it('contains a built-in-preset timeout during sample_messages preset detection', async () => {
      const executor = new RegexExecutor({ timeoutMs: 10 });
      try {
        const server = new FakeServer();
        const deps = makeTimeoutDeps(executor, { 'user-a': [textMsg('m1', EVIL_MSG, '1000')] });
        registerBankTools(server as unknown as McpServer, makeContext(), deps);
        // No saved templates → detectPresets skips the saved-template loop and
        // goes straight to testing the preset's own (evil) template pattern.
        writeFileSync(
          join(presetsDir, 'evil.json'),
          JSON.stringify({
            description: 'evil preset',
            templates: [{ name: 'evil1', pattern: '(a|aa)+$', amount_sign: 'debit' }],
            currency_aliases: {},
          }),
        );
        const result = await server.tools.get('sample_messages')!({ chatMid: 'chatX', count: 20 });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('sample messages');
        expect(() => JSON.parse(result.content[0].text)).toThrow();
      } finally {
        await executor.close();
      }
    });
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
