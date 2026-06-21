# LINE Export Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-step MCP protocol that lets users backfill the SQLite message cache from a LINE chat export `.txt` file without passing the file content through Claude's context.

**Architecture:** A new `src/export-parser.ts` provides a pure parsing function. `src/oauth.ts` gains two in-memory maps and a `POST /import-upload` HTTP endpoint protected by a one-time token. `src/index.ts` gains two MCP tools (`initiate_import`, `complete_import`) and a second `AsyncLocalStorage` to pass the Express `Request` into tool handlers for URL construction.

**Tech Stack:** Node.js `crypto` (built-in UUID + SHA-256), `Intl.DateTimeFormat` (built-in timezone math), `express.raw()` for body parsing, `better-sqlite3` (existing), `vitest` (existing).

## Global Constraints

- TypeScript strict mode; no `any`
- No new npm dependencies
- Unit tests live in `src/` (picked up by `npm run test:unit` = `vitest run src`)
- All new MCP tool handlers follow the existing `authStore.getStore()` pattern
- `INSERT OR REPLACE` idempotency: re-importing the same file must not create duplicate rows
- One-time upload tokens expire after 15 minutes; file refs expire after 1 hour
- Lazy expiry eviction (check on access, no background timers)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/export-parser.ts` | `parseExportHeader`, `parseExportFile` |
| Create | `src/export-parser.test.ts` | Unit tests (runs under `npm run test:unit`) |
| Modify | `src/oauth.ts` | `pendingUploads`, `pendingFiles` maps; `POST /import-upload` route |
| Modify | `src/index.ts` | `requestStore` ALS; `initiate_import` and `complete_import` tools |

---

### Task 1: Export parser + unit tests

**Files:**
- Create: `src/export-parser.ts`
- Create: `src/export-parser.test.ts`

**Interfaces produced (used by Tasks 2 and 3):**
```typescript
// src/export-parser.ts
export function parseExportHeader(text: string): string
// throws Error('File does not appear to be a LINE chat export.') on bad input

export function parseExportFile(text: string, chatMid: string, timezone: string): Message[]
// Message is imported from './line-client'
```

---

- [ ] **Step 1: Write the failing tests**

Create `src/export-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseExportHeader, parseExportFile } from './export-parser';

const MINIMAL = `Chat history with Test Bot
Saved on: 6/21/2026, 17:00

Thu, 6/12/2025
17:09\tTest Bot\tHello world`;

describe('parseExportHeader', () => {
  it('extracts chat name', () => {
    expect(parseExportHeader(MINIMAL)).toBe('Test Bot');
  });

  it('throws on invalid format', () => {
    expect(() => parseExportHeader('not a LINE export')).toThrow('LINE chat export');
  });
});

describe('parseExportFile', () => {
  const MID = 'u123abc';
  const TZ = 'Asia/Bangkok';

  it('parses a single message', () => {
    const msgs = parseExportFile(MINIMAL, MID, TZ);
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.text).toBe('Hello world');
    expect(m.senderName).toBe('Test Bot');
    expect(m.from).toBe('export:Test Bot');
    expect(m.to).toBe(MID);
    expect(m.contentType).toBe(0);
    expect(m.toType).toBe(0);
    expect(m.hasContent).toBe(false);
    expect(m.id).toMatch(/^export-[0-9a-f]{24}$/);
  });

  it('converts Bangkok timestamp to correct UTC epoch', () => {
    const msgs = parseExportFile(MINIMAL, MID, TZ);
    // 2025-06-12 17:09 Asia/Bangkok (UTC+7) = 2025-06-12 10:09 UTC
    const expected = new Date('2025-06-12T10:09:00.000Z').getTime();
    expect(parseInt(msgs[0].createdTime, 10)).toBe(expected);
  });

  it('joins continuation lines with newline, trimming trailing whitespace', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
10:00\tBot\tFirst line
Second line
Third line`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('First line\nSecond line\nThird line');
  });

  it('preserves blank lines within multi-line messages', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
10:00\tBot\tLine one

Line three`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Line one\n\nLine three');
  });

  it('generates deterministic IDs (re-import is idempotent)', () => {
    const a = parseExportFile(MINIMAL, MID, TZ);
    const b = parseExportFile(MINIMAL, MID, TZ);
    expect(a[0].id).toBe(b[0].id);
  });

  it('generates unique IDs for different message texts at the same timestamp', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tFirst message
09:00\tBot\tSecond message`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).not.toBe(msgs[1].id);
  });

  it('parses messages across multiple days', () => {
    const text = `Chat history with Bot
Saved on: 6/21/2026, 17:00

Mon, 1/1/2024
09:00\tBot\tFirst

Tue, 1/2/2024
11:00\tBot\tSecond`;
    const msgs = parseExportFile(text, MID, TZ);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('First');
    expect(msgs[1].text).toBe('Second');
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run src/export-parser.test.ts
```
Expected: FAIL with `Cannot find module './export-parser'`

- [ ] **Step 3: Implement `src/export-parser.ts`**

```typescript
import crypto from 'crypto';
import type { Message } from './line-client';

export function parseExportHeader(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  const match = firstLine.match(/^Chat history with (.+)$/);
  if (!match) throw new Error('File does not appear to be a LINE chat export.');
  return match[1].trim();
}

// Converts a local date/time in the given IANA timezone to UTC milliseconds.
// Uses the Intl.DateTimeFormat offset-estimation technique (no external deps).
function localToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number,
  timezone: string,
): number {
  // Treat local time as UTC to get a rough candidate
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Format that UTC instant in the target timezone to measure the actual offset
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(new Date(guess));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
  const renderedMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), 0);
  // Offset correction: utc = 2*guess - renderedMs  (exact for non-DST-gap instants)
  return 2 * guess - renderedMs;
}

function syntheticId(
  chatMid: string, dateStr: string, timeStr: string, senderName: string, text: string,
): string {
  return 'export-' + crypto
    .createHash('sha256')
    .update(chatMid + dateStr + timeStr + senderName + text)
    .digest('hex')
    .slice(0, 24);
}

const DAY_RE = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MSG_RE = /^(\d{2}:\d{2})\t(.+?)\t(.*)$/;

interface Pending {
  dateStr: string; timeStr: string;
  year: number; month: number; day: number;
  hour: number; minute: number;
  senderName: string;
  textLines: string[];
}

export function parseExportFile(text: string, chatMid: string, timezone: string): Message[] {
  const lines = text.split('\n');
  const messages: Message[] = [];
  let currentDate: { year: number; month: number; day: number } | null = null;
  let pending: Pending | null = null;

  function flush(): void {
    if (!pending) return;
    const msgText = pending.textLines.join('\n').trimEnd();
    messages.push({
      id: syntheticId(chatMid, pending.dateStr, pending.timeStr, pending.senderName, msgText),
      from: `export:${pending.senderName}`,
      senderName: pending.senderName,
      to: chatMid,
      toType: 0,
      createdTime: String(localToUtcMs(pending.year, pending.month, pending.day, pending.hour, pending.minute, timezone)),
      contentType: 0,
      text: msgText,
      hasContent: false,
    });
    pending = null;
  }

  for (const line of lines) {
    const dayMatch = line.match(DAY_RE);
    if (dayMatch) {
      flush();
      currentDate = { month: parseInt(dayMatch[1], 10), day: parseInt(dayMatch[2], 10), year: parseInt(dayMatch[3], 10) };
      continue;
    }

    const msgMatch = line.match(MSG_RE);
    if (msgMatch && currentDate) {
      flush();
      const [, timeStr, senderName, firstText] = msgMatch;
      const [hh, mm] = timeStr.split(':').map(Number);
      pending = {
        dateStr: `${currentDate.month}/${currentDate.day}/${currentDate.year}`,
        timeStr,
        ...currentDate,
        hour: hh,
        minute: mm,
        senderName,
        textLines: [firstText],
      };
      continue;
    }

    // Non-matching lines with no pending message: file header, blank lines between days — ignore
    if (!pending) continue;
    // Blank or continuation lines within a message — preserve
    pending.textLines.push(line);
  }
  flush();

  return messages;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npx vitest run src/export-parser.test.ts
```
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/export-parser.ts src/export-parser.test.ts
git commit -m "feat: add LINE export parser with unit tests"
```

---

### Task 2: In-memory stores + upload endpoint

**Files:**
- Modify: `src/oauth.ts`

**Interfaces consumed (from Task 1):**
```typescript
import { parseExportHeader } from './export-parser';
// parseExportHeader(text: string): string — throws on invalid format
```

**Interfaces produced (used by Task 3):**
```typescript
// exported from src/oauth.ts
export const pendingUploads: Map<string, { expires: number }>
export const pendingFiles: Map<string, { content: string; chatName: string; expires: number }>
```

**New HTTP route:** `POST /import-upload?token=<uuid>`
- One-time token auth (no Bearer header required)
- Raw body, any content type, max 10 MB
- Returns: `{ file_ref_id: string, chat_name: string }`
- Error responses: `401` (bad/expired token), `400` (invalid LINE export format)

---

- [ ] **Step 1: Add maps and import to `src/oauth.ts`**

Add after the `export const latestAuthData` line (around line 50):

```typescript
import { parseExportHeader } from './export-parser';

// ─── Import upload state ──────────────────────────────────────────────────────

export const pendingUploads = new Map<string, { expires: number }>();
export const pendingFiles   = new Map<string, { content: string; chatName: string; expires: number }>();
```

- [ ] **Step 2: Add `POST /import-upload` route inside `setupOAuthRoutes`**

First, in `src/oauth.ts` replace the existing express type-only import:
```typescript
// Before:
import type { Express, Request, Response } from 'express';
// After:
import express, { type Express, type Request, type Response } from 'express';
```

Then inside `setupOAuthRoutes(app, _port)`:

Then inside `setupOAuthRoutes(app, _port)`:

```typescript
app.post(
  '/import-upload',
  express.raw({ type: '*/*', limit: '10mb' }),
  (req: Request, res: Response) => {
    const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
    const entry = pendingUploads.get(token);
    if (!entry || entry.expires < Date.now()) {
      pendingUploads.delete(token);
      res.status(401).json({ error: 'invalid_or_expired_token' });
      return;
    }
    pendingUploads.delete(token); // consume — one-time use

    const content = (req.body as Buffer).toString('utf8');
    let chatName: string;
    try {
      chatName = parseExportHeader(content);
    } catch {
      res.status(400).json({ error: 'File does not appear to be a LINE chat export.' });
      return;
    }

    const fileRefId = crypto.randomUUID();
    pendingFiles.set(fileRefId, { content, chatName, expires: Date.now() + 3_600_000 });

    res.json({ file_ref_id: fileRefId, chat_name: chatName });
  },
);
```

- [ ] **Step 3: Verify the server starts without errors**

```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/oauth.ts
git commit -m "feat: add upload endpoint and pending-file stores to oauth"
```

---

### Task 3: MCP tools — `initiate_import` and `complete_import`

**Files:**
- Modify: `src/index.ts`

**Interfaces consumed (from Task 1):**
```typescript
import { parseExportFile } from './export-parser';
// parseExportFile(text: string, chatMid: string, timezone: string): Message[]
```

**Interfaces consumed (from Task 2):**
```typescript
import { pendingUploads, pendingFiles } from './oauth';
// pendingUploads: Map<string, { expires: number }>
// pendingFiles:   Map<string, { content: string; chatName: string; expires: number }>
```

---

- [ ] **Step 1: Add `requestStore` and extend the `/mcp` handler**

In `src/index.ts`, after the existing `const authStore = new AsyncLocalStorage<AuthData>();` line:

```typescript
import type { Request as ExpressRequest } from 'express';

const requestStore = new AsyncLocalStorage<ExpressRequest>();
```

Then in the `app.post('/mcp', ...)` handler, nest the existing `authStore.run` inside a `requestStore.run`:

```typescript
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
```

- [ ] **Step 2: Add imports for the new tools**

At the top of `src/index.ts`, add:

```typescript
import { pendingUploads, pendingFiles } from './oauth';
import { parseExportFile } from './export-parser';
```

- [ ] **Step 3: Register `initiate_import` tool**

Add before the `makeLineClient` function:

```typescript
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
    if (!req) {
      return { content: [{ type: 'text' as const, text: 'Request context unavailable.' }], isError: true };
    }
    const token = crypto.randomUUID();
    pendingUploads.set(token, { expires: Date.now() + 900_000 }); // 15 min
    const base = `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${base}/import-upload?token=${token}`;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ upload_url: uploadUrl }),
      }],
    };
  },
);
```

Add `import crypto from 'crypto';` at the top of `index.ts` (it is not currently imported there).

- [ ] **Step 4: Register `complete_import` tool**

Add after `initiate_import`:

```typescript
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
        ? { from: new Date(Math.min(...timestamps)).toISOString(), to: new Date(Math.max(...timestamps)).toISOString() }
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
```

- [ ] **Step 5: Build to catch type errors**

```bash
npm run build 2>&1 | tail -10
```
Expected: clean build, no TypeScript errors

- [ ] **Step 6: Smoke test the full flow manually**

Start the server:
```bash
npm start &
```

In another terminal (use a valid MCP bearer token for `TOKEN`):
```bash
# Step 1 — get upload URL
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"initiate_import","arguments":{}}}' \
  | jq .

# Step 2 — upload file (replace UPLOAD_URL with the value from step 1)
curl -s -X POST "UPLOAD_URL" \
  --data-binary @"specs/chat_export_examples/Chat history with SCB Connect.txt" \
  -H "Content-Type: text/plain" | jq .

# Step 3 — complete import (replace FILE_REF_ID with value from step 2)
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"complete_import","arguments":{"file_ref_id":"FILE_REF_ID","timezone":"Asia/Bangkok"}}}' \
  | jq .
```

Expected: `status: "success"` with `imported > 0`

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: add initiate_import and complete_import MCP tools for export backfill"
```
