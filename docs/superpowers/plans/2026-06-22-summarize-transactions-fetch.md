# summarize_transactions: fetch from LINE directly — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `transactions` array input from `summarize_transactions` and replace it with `chatMid`/`since`/`until` so the tool fetches and parses internally, eliminating the double-token round-trip.

**Architecture:** Extract a private `fetchParsedTransactions()` helper in `src/index.ts` that contains the full fetch→parse→`applyBalanceDiffs` pipeline currently inlined in `get_transactions`. Both tools call this helper; `get_transactions` interface stays unchanged.

**Tech Stack:** TypeScript, Zod (input schema), Vitest (tests), MCP SDK.

## Global Constraints

- `fetchParsedTransactions` must NOT be exported — it is private glue in `src/index.ts`.
- `summarize_transactions` always uses saved templates only (no inline template override).
- `get_transactions` interface is unchanged — do not modify its input schema or output format.
- All error messages must match the exact strings currently in `get_transactions`.

---

### Task 1: Extract helper + refactor both tools

**Files:**
- Modify: `src/index.ts` (lines 297–408)
- Modify: `tests/e2e.test.ts` (add one new test at the end)

**Interfaces:**
- Produces:
  ```ts
  // private in src/index.ts — added above the get_transactions registration
  async function fetchParsedTransactions(
    authData: AuthData,
    chatMid: string,
    since?: string,
    until?: string,
  ): Promise<
    | { transactions: Transaction[]; warnings: string[]; rangeNote: string }
    | { error: string }
  >
  ```

---

- [ ] **Step 1: Run existing unit tests to establish a passing baseline**

  ```bash
  npm run test:unit
  ```

  Expected: all tests pass. If any are already failing, do not proceed — fix them first.

---

- [ ] **Step 2: Add a failing e2e test for the new `summarize_transactions` interface**

  Open `tests/e2e.test.ts`. Add this test at the very end of the file (after the last existing `it(...)` block):

  ```ts
  it('summarize_transactions accepts chatMid directly', async () => {
    expect(firstChatMid).toBeTruthy();
    const result = await mcpClient.callTool({
      name: 'summarize_transactions',
      arguments: { chatMid: firstChatMid, group_by: 'month' },
    });
    // Either a valid summary or "no saved templates" — both prove the new interface is wired
    const text = extractText(result);
    const isValidSummary = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
    const isNoTemplatesError = text.includes('No templates') || text.includes('no saved templates');
    expect(isValidSummary || isNoTemplatesError).toBe(true);
  });
  ```

  Run it to verify it fails because `summarize_transactions` currently does not accept `chatMid`:

  ```bash
  npx vitest run tests/e2e.test.ts 2>&1 | tail -20
  ```

  Expected: the new test fails with a schema validation error (zod rejects `chatMid`; `transactions` is required).

---

- [ ] **Step 3: Extract `fetchParsedTransactions` helper**

  In `src/index.ts`, insert the following private function immediately **above** the `server.registerTool('get_transactions', ...)` call (currently at line 279). Do NOT change any existing code yet.

  ```ts
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

    const client = makeLineClient(authData);
    const messages = since
      ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
      : await client.getMessages(chatMid, 200);

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
  ```

---

- [ ] **Step 4: Refactor `get_transactions` to use the helper**

  Replace the `async ({ chatMid, templates: suppliedTemplates, since, until }) => { ... }` handler body (lines 297–381 in the original file) with the following. The `inputSchema` and `description` stay unchanged.

  ```ts
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
  ```

---

- [ ] **Step 5: Replace `summarize_transactions` registration**

  Replace the entire `server.registerTool('summarize_transactions', ...)` block (lines 384–409 in the original file) with:

  ```ts
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
  ```

  Note: `TransactionSchema` is no longer used in this file after this change. Remove it from the import on line 13:

  ```ts
  import { parseTransaction, summarize, expandUntilBound, applyBalanceDiffs, TransactionTemplateSchema } from './transaction-parser';
  ```

---

- [ ] **Step 6: Verify TypeScript compiles cleanly**

  ```bash
  npm run build 2>&1 | tail -20
  ```

  Expected: no errors. If TS complains about an unused import, fix it.

---

- [ ] **Step 7: Run unit tests**

  ```bash
  npm run test:unit
  ```

  Expected: all existing unit tests pass (no changes to any unit-tested module).

---

- [ ] **Step 8: Run e2e tests (requires `.line-auth.json`)**

  ```bash
  npm run test:e2e 2>&1 | tail -30
  ```

  Expected: all tests pass, including the new `summarize_transactions accepts chatMid directly` test.

  If `.line-auth.json` is absent, skip this step and note it in the commit message.

---

- [ ] **Step 9: Commit**

  ```bash
  git add src/index.ts tests/e2e.test.ts
  git commit -m "feat: summarize_transactions fetches from LINE directly, eliminating transaction round-trip"
  ```
