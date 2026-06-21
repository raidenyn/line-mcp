# Pagination — Fetch All Messages for a Time Range

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `get_transactions` and `sample_messages` paginate backwards through LINE's history when `since` is given, removing the 200-message cap.

**Architecture:** Extract private helpers from `getMessages` to eliminate duplication, add `getMessagesInRange` on top of them, then wire the two tools to call it when `since` is present. Page size is an optional parameter defaulting to 200 (LINE's cap) so unit tests can exercise pagination with small values.

**Tech Stack:** TypeScript, Vitest, `@modelcontextprotocol/sdk`, `zod`, LINE Chrome Gateway API

## Global Constraints

- Max 200 messages per `getPreviousMessagesV2WithRequest` call (LINE API hard limit)
- All new code in TypeScript; no new runtime dependencies
- Unit tests mock `./ltsm` and use `vi.fn()` for fetch (match existing `src/line-client.test.ts` pattern)
- Existing `getMessages` public API must not change (same signature, same behavior)
- Run `npm run test:unit` after every task to confirm no regressions

---

### Task 1: Extract private helpers and add `getMessagesInRange` to `LineClient`

**Files:**
- Modify: `src/line-client.ts`
- Test: `src/line-client.test.ts`

**Interfaces:**
- Produces:
  - `private interface RawMessage` (module-level, used by helpers and `getMessagesInRange`)
  - `private fetchRawPage(chatMid: string, count: number): Promise<RawMessage[]>`
  - `private fetchPreviousRawPage(chatMid: string, endMessageId: { messageId: string; deliveredTime: string }, count: number): Promise<RawMessage[]>`
  - `private resolveContactNames(mids: string[]): Promise<void>`
  - `private mapRawMessages(raw: RawMessage[]): Message[]`
  - `public getMessagesInRange(chatMid: string, sinceMs: number, resolveNames?: boolean, pageSize?: number): Promise<Message[]>`

- [ ] **Step 1: Write failing tests for `getMessagesInRange`**

Add a new `describe` block at the bottom of `src/line-client.test.ts`:

```typescript
// ───────────────────────────────────────────────────────────
// getMessagesInRange
// ───────────────────────────────────────────────────────────

describe('LineClient.getMessagesInRange', () => {
  function rawMsg(id: string, createdTime: string, from = 'u1') {
    return { id, from, to: 'g1', toType: 2, createdTime, contentType: 0, text: 'txt', hasContent: false };
  }

  it('returns empty array when no messages exist', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) return Promise.resolve(apiOk([]));
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false);
    expect(result).toHaveLength(0);
  });

  it('returns messages within range from a single page', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1700000002000'),
          rawMsg('m2', '1700000003000'),
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000001000, false);
    expect(result).toHaveLength(2);
    expect(result.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('filters out messages older than sinceMs', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000'), // before sinceMs
          rawMsg('m2', '1700000002000'), // after sinceMs
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m2');
  });

  it('paginates backwards and stops when oldest message is before sinceMs', async () => {
    // pageSize=2: first page is full → triggers pagination
    // second page contains one message before sinceMs → stops
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m3', '1700000003000'),
          rawMsg('m4', '1700000004000'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000'), // before sinceMs
          rawMsg('m2', '1700000002000'), // after sinceMs
        ]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    // m1 filtered out; m2, m3, m4 kept
    expect(result).toHaveLength(3);
    expect(result.map(m => m.id).sort()).toEqual(['m2', 'm3', 'm4']);
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls).toHaveLength(1);
  });

  it('stops pagination when previous page is empty (end of history)', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1700000001000'),
          rawMsg('m2', '1700000002000'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([]));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, false, 2);
    expect(result).toHaveLength(2);
    const prevCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getPreviousMessagesV2WithRequest'),
    );
    expect(prevCalls).toHaveLength(1);
  });

  it('resolves contact names once across all pages', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('getRecentMessagesV2')) {
        return Promise.resolve(apiOk([
          rawMsg('m3', '1700000003000', 'u1'),
          rawMsg('m4', '1700000004000', 'u2'),
        ]));
      }
      if (url.includes('getPreviousMessagesV2WithRequest')) {
        return Promise.resolve(apiOk([
          rawMsg('m1', '1699999999000', 'u3'), // before sinceMs — filtered out
          rawMsg('m2', '1700000002000', 'u4'),
        ]));
      }
      if (url.includes('getContactsV2')) {
        return Promise.resolve(apiOk({
          contacts: {
            u1: { contact: { mid: 'u1', displayName: 'Alice' } },
            u2: { contact: { mid: 'u2', displayName: 'Bob' } },
            u4: { contact: { mid: 'u4', displayName: 'Dave' } },
          },
        }));
      }
      return Promise.resolve(apiOk(null));
    });
    const client = new LineClient(baseAuth, mockFetch);
    const result = await client.getMessagesInRange('g1', 1700000000000, true, 2);
    const contactCalls = mockFetch.mock.calls.filter(([url]: string[]) =>
      url.includes('getContactsV2'),
    );
    expect(contactCalls).toHaveLength(1); // one batch for all in-range messages
    expect(result.find(m => m.id === 'm4')?.senderName).toBe('Bob');
    expect(result.find(m => m.id === 'm2')?.senderName).toBe('Dave');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/line-client.test.ts
```

Expected: FAIL — `client.getMessagesInRange is not a function`

- [ ] **Step 3: Implement the changes in `src/line-client.ts`**

**3a.** Add `RawMessage` interface after the existing `Message` interface (around line 47):

```typescript
interface RawMessage {
  id: string;
  from: string;
  to: string;
  toType: number;
  createdTime: string;
  contentType: number;
  text?: string;
  hasContent: boolean;
  contentMetadata?: Record<string, string>;
}
```

**3b.** Add four private methods inside the `LineClient` class, just before `getMessages` (around line 465):

```typescript
private async fetchRawPage(chatMid: string, count: number): Promise<RawMessage[]> {
  return this.request<RawMessage[]>(
    '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2',
    [chatMid, count],
  );
}

private async fetchPreviousRawPage(
  chatMid: string,
  endMessageId: { messageId: string; deliveredTime: string },
  count: number,
): Promise<RawMessage[]> {
  return this.request<RawMessage[]>(
    '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
    [{ messageBoxId: chatMid, endMessageId, messagesCount: count }, 1],
  );
}

private async resolveContactNames(mids: string[]): Promise<void> {
  const unknownMids = [...new Set(mids)].filter(mid => !this.contactNameCache.has(mid));
  if (unknownMids.length > 0) {
    const resolved = await this.fetchContactsV2(unknownMids);
    for (const c of resolved) this.contactNameCache.set(c.mid, c.displayName);
  }
}

private mapRawMessages(raw: RawMessage[]): Message[] {
  return (raw ?? []).map((m) => ({
    id: m.id,
    from: m.from,
    senderName: this.contactNameCache.get(m.from),
    to: m.to,
    toType: m.toType,
    createdTime: m.createdTime,
    contentType: m.contentType,
    text: m.text,
    hasContent: m.hasContent,
    contentMetadata: m.contentMetadata,
    previewUrl: m.contentType === 1 ? m.contentMetadata?.['PREVIEW_URL'] : undefined,
    downloadUrl: m.contentType === 1 ? m.contentMetadata?.['DOWNLOAD_URL'] : undefined,
  }));
}
```

**3c.** Replace the existing `getMessages` method body to use the helpers:

```typescript
async getMessages(chatMid: string, count = 50, resolveNames = true): Promise<Message[]> {
  await this.ensureAuthenticated();
  const raw = await this.fetchRawPage(chatMid, count);
  if (resolveNames) {
    await this.resolveContactNames((raw ?? []).map(m => m.from));
  }
  return this.mapRawMessages(raw);
}
```

**3d.** Add `getMessagesInRange` immediately after `getMessages`:

```typescript
async getMessagesInRange(
  chatMid: string,
  sinceMs: number,
  resolveNames = true,
  pageSize = 200,
): Promise<Message[]> {
  await this.ensureAuthenticated();

  let allRaw: RawMessage[] = [];

  const firstPage = await this.fetchRawPage(chatMid, pageSize);
  const page0 = firstPage ?? [];
  allRaw = [...page0];

  let currentPage = page0;
  while (currentPage.length >= pageSize) {
    const oldest = currentPage.reduce((a, b) =>
      parseInt(a.createdTime, 10) < parseInt(b.createdTime, 10) ? a : b,
    );
    if (parseInt(oldest.createdTime, 10) < sinceMs) break;

    const prevPage = await this.fetchPreviousRawPage(
      chatMid,
      { messageId: oldest.id, deliveredTime: oldest.createdTime },
      pageSize,
    );
    const page = prevPage ?? [];
    allRaw = [...allRaw, ...page];
    currentPage = page;
  }

  const filtered = allRaw.filter(m => parseInt(m.createdTime, 10) >= sinceMs);

  if (resolveNames) {
    await this.resolveContactNames(filtered.map(m => m.from));
  }

  return this.mapRawMessages(filtered);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/line-client.test.ts
```

Expected: all tests PASS, including the new `getMessagesInRange` suite

- [ ] **Step 5: Commit**

```bash
git add src/line-client.ts src/line-client.test.ts
git commit -m "feat: extract LineClient helpers and add getMessagesInRange with backward pagination"
```

---

### Task 2: Wire `get_transactions` and `sample_messages` to use `getMessagesInRange`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `client.getMessagesInRange(chatMid, sinceMs, resolveNames?)` from Task 1
- The `limit` parameter is removed from `get_transactions`; `since`/`until` are added to `sample_messages`

- [ ] **Step 1: Update `get_transactions` in `src/index.ts`**

Remove the `limit` line from `inputSchema` and change the fetch call. The full updated tool registration (replace lines ~252–343):

In `inputSchema`, remove:
```typescript
limit: z.number().int().min(1).max(200).default(100).describe('Max messages to fetch from LINE'),
```

Change the handler signature from `async ({ chatMid, templates: suppliedTemplates, limit, since, until })` to:
```typescript
async ({ chatMid, templates: suppliedTemplates, since, until })
```

Replace the message fetch (currently `const messages = await client.getMessages(chatMid, limit, false);`) with:
```typescript
const messages = since
  ? await client.getMessagesInRange(chatMid, new Date(since).getTime(), false)
  : await client.getMessages(chatMid, 200, false);
```

Add a trailing note to the result text when `since` is absent. Find the final return in the tool handler:
```typescript
return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock }] };
```
Change it to:
```typescript
const rangeNote = since ? '' : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';
return { content: [{ type: 'text' as const, text: JSON.stringify(transactions) + warningBlock + rangeNote }] };
```

- [ ] **Step 2: Update `sample_messages` in `src/index.ts`**

Add `since` and `until` to `inputSchema`:
```typescript
since: z.string().optional().describe('ISO date — fetch messages from this date onwards (enables full history pagination)'),
until: z.string().optional().describe('ISO date — exclude messages after this date'),
```

Change the handler signature from `async ({ chatMid, count })` to:
```typescript
async ({ chatMid, count, since, until })
```

Replace the fetch call (currently `const messages = await client.getMessages(chatMid, count, false);`) with:
```typescript
const messages = since
  ? await client.getMessagesInRange(chatMid, new Date(since).getTime(), false)
  : await client.getMessages(chatMid, count, false);
```

Apply `until` filtering before the sort. After the existing filter line `const textMessages = messages.filter(...)`:
```typescript
const textMessages = messages
  .filter((m) => m.contentType === 0 && m.text)
  .filter((m) => !until || parseInt(m.createdTime, 10) <= new Date(until).getTime())
  .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
```

- [ ] **Step 3: Run unit tests to confirm no regressions**

```bash
npm run test:unit
```

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: paginate get_transactions and sample_messages when since is provided; remove limit param"
```

---

### Task 3: Update README.md and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README.md**

In the tools table, update the `sample_messages` row description:
```
| `sample_messages` | Fetch raw text messages with timestamps; accepts optional `since`/`until` for historical ranges — use before writing regex templates |
```

In the tools table, update the `get_transactions` row description:
```
| `get_transactions` | Parse bank notifications into structured transactions; paginates the full history when `since` is given; auto-loads saved templates |
```

In the **Workflow (first time)** section, update step 1:
```
1. Call `sample_messages` to inspect raw message text — pass `since` to reach older messages if the bank changed its format months ago
```

Add a new tip after the existing `\\s+` tip:
```
> **Tip:** Pass `since` to `get_transactions` (e.g. `since: "2026-05-01"`) to fetch the complete history for a month. Without `since`, only the latest 200 messages are checked.
```

- [ ] **Step 2: Update CLAUDE.md**

In the `sample_messages` entry under **Source files**, update to:
```
- `sample_messages` — fetches raw text messages from a chat (filters `contentType === 0`, sorted oldest-first). Accepts optional `since`/`until` ISO date strings; when `since` is provided, calls `getMessagesInRange` to paginate the full history back to that date.
```

In the `get_transactions` entry, update the `limit` reference:
- Remove: `Max messages to fetch from LINE` / `limit` parameter mention.
- Update to: `` when `since` is provided, calls `getMessagesInRange()` to paginate backwards until `sinceMs` is reached; without `since`, falls back to `getMessages(200)` with a note in the response. ``

Full updated `get_transactions` blurb:
```
- `get_transactions` — `templates` parameter is optional; when omitted, loads saved templates from `.line-templates/<chatMid>.json` via `loadTemplates()` and filters each message's applicable templates by `filterByTime()`. When `since` is provided, calls `getMessagesInRange()` to paginate backwards through LINE history until that date; without `since`, fetches the latest 200 messages and appends a note recommending `since` for full-range accuracy. Returns a zero-match hint when saved templates exist but nothing matched.
```

- [ ] **Step 3: Run unit tests one final time**

```bash
npm run test:unit
```

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README and CLAUDE.md for pagination — remove limit param, document since/until on sample_messages"
```
