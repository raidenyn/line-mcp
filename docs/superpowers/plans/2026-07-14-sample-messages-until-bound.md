# Sample Messages Until Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sample_messages` include all messages within date-only and month-only `until` bounds.

**Architecture:** Extract the `sample_messages` upper-bound parsing and text-message filtering into a small pure module. The MCP handler will validate and parse the upper bound once, then pass the timestamp to the pure filter; tests can therefore use fixed message fixtures without LINE credentials or network I/O.

**Tech Stack:** TypeScript, Vitest, Zod, Model Context Protocol SDK.

## Global Constraints

- Keep the `sample_messages` MCP input schema and response format unchanged.
- Reuse `expandUntilBound()` from `src/transaction-parser.ts` for date-only and month-only semantics.
- Full ISO timestamps remain exact upper bounds.
- Preserve the existing invalid-`until` error text in `src/index.ts`.
- Do not change `since` retrieval or pagination behavior.

---

## File Structure

- Create: `src/sample-messages.ts` - pure parsing and filtering functions used by the MCP handler.
- Create: `src/sample-messages.test.ts` - deterministic boundary regression tests with fixed `Message` fixtures.
- Modify: `src/index.ts:9-14,481-494` - delegate upper-bound handling and text filtering to the pure module.

### Task 1: Extract and Cover Sample-Message Filtering

**Files:**
- Create: `src/sample-messages.ts`
- Create: `src/sample-messages.test.ts`
- Modify: `src/index.ts:9-14,481-494`

**Interfaces:**
- Consumes: `Message` from `src/line-client.ts` and `expandUntilBound(until: string): string` from `src/transaction-parser.ts`.
- Produces: `parseSampleUntilBound(until: string): number` and `filterSampleMessages(messages: Message[], untilMs?: number): Message[]` from `src/sample-messages.ts`.

- [ ] **Step 1: Write the failing regression tests**

Create `src/sample-messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Message } from './line-client';
import { filterSampleMessages, parseSampleUntilBound } from './sample-messages';

function message(id: string, iso: string): Message {
  return {
    id,
    from: 'user',
    to: 'chat',
    toType: 1,
    createdTime: String(new Date(iso).getTime()),
    contentType: 0,
    text: id,
    hasContent: false,
  };
}

describe('sample message until bounds', () => {
  const messages = [
    message('midday', '2026-05-31T12:00:00.000Z'),
    message('june', '2026-06-01T00:00:00.000Z'),
    message('may-end', '2026-05-31T23:59:59.999Z'),
  ];

  it('keeps messages later on a date-only until boundary', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05-31'));
    expect(result.map((item) => item.id)).toEqual(['midday', 'may-end']);
  });

  it('expands a month-only until bound through the end of that month', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05'));
    expect(result.map((item) => item.id)).toEqual(['midday', 'may-end']);
  });

  it('keeps a complete ISO timestamp as an exact upper bound', () => {
    const result = filterSampleMessages(messages, parseSampleUntilBound('2026-05-31T12:00:00.000Z'));
    expect(result.map((item) => item.id)).toEqual(['midday']);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run src/sample-messages.test.ts`

Expected: FAIL because `./sample-messages` does not exist.

- [ ] **Step 3: Add the pure upper-bound parser and filter**

Create `src/sample-messages.ts`:

```ts
import type { Message } from './line-client';
import { expandUntilBound } from './transaction-parser';

export function parseSampleUntilBound(until: string): number {
  return new Date(expandUntilBound(until)).getTime();
}

export function filterSampleMessages(messages: Message[], untilMs?: number): Message[] {
  return messages
    .filter((message) => message.contentType === 0 && message.text)
    .filter((message) => untilMs === undefined || parseInt(message.createdTime, 10) <= untilMs)
    .sort((a, b) => parseInt(a.createdTime, 10) - parseInt(b.createdTime, 10));
}
```

In `src/index.ts`, add this import next to the existing local imports:

```ts
import { filterSampleMessages, parseSampleUntilBound } from './sample-messages';
```

Replace the `until` validation and `textMessages` construction in the `sample_messages` handler with:

```ts
let untilMs: number | undefined;
if (until) {
  untilMs = parseSampleUntilBound(until);
  if (!Number.isFinite(untilMs)) {
    return { content: [{ type: 'text' as const, text: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` }], isError: true };
  }
}
const client = makeLineClient(authData);
const messages = since
  ? await client.getMessagesInRange(chatMid, new Date(since).getTime())
  : await client.getMessages(chatMid, count);
const textMessages = filterSampleMessages(messages, untilMs);
```

- [ ] **Step 4: Run focused tests to verify the fix**

Run: `npx vitest run src/sample-messages.test.ts src/transaction-parser.test.ts`

Expected: PASS, including date-only inclusion, month-only inclusion, exact timestamp behavior, and existing `expandUntilBound()` behavior.

- [ ] **Step 5: Run the unit suite and build**

Run: `npm run test:unit && npm run build`

Expected: Both commands exit with status 0.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/index.ts src/sample-messages.ts src/sample-messages.test.ts
git commit -m "fix: include full sample message until date"
```
