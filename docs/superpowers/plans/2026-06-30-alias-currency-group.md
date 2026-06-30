# Extend Currency Aliases to `currency` Capture Group

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the existing `aliases` map to the `currency` capture group in `parseTransaction`, so both `original_currency` and `currency` are normalised the same way.

**Architecture:** One-line change in `src/transaction-parser.ts` line 126; two new tests in `src/transaction-parser.test.ts`. No new parameters, no storage changes, no schema changes.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new dependencies
- Tests run via: `npx vitest run src/transaction-parser.test.ts`
- Follow TDD: write failing tests first, implement second

---

## File Map

| File | Action |
|------|--------|
| `src/transaction-parser.ts` | Modify line 126 |
| `src/transaction-parser.test.ts` | Add 2 tests to existing alias test block |

---

## Task 1: Apply alias lookup to `currency` group

**Files:**
- Modify: `src/transaction-parser.ts:126`
- Modify: `src/transaction-parser.test.ts`

**Interfaces:**
- Consumes: `parseTransaction(message, templates, aliases?)` — already has the `aliases` param; this task extends its use
- Produces: no signature change; `tx.currency` now carries the normalised value

- [ ] **Step 1: Write failing tests**

Append inside the existing `describe('parseTransaction currency aliases', ...)` block at the bottom of `src/transaction-parser.test.ts`. The block currently ends with `});` after the empty-map test — add these two `it` cases before that closing `});`:

```typescript
  it('normalises currency group via aliases', () => {
    const msg = {
      id: 'fx2',
      createdTime: '1749999600000',
      contentType: 0 as const,
      text: 'FX spend USD 50 (บาท 1750) at Starbucks',
    };
    const tmpl: TransactionTemplate[] = [{
      pattern: 'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>บาท) (?<amount>[\\d.]+)\\) at .+',
      amount_sign: 'debit',
    }];
    const tx = parseTransaction(msg, tmpl, { 'บาท': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.currency).toBe('THB');
  });

  it('passes through unrecognised currency group unchanged', () => {
    const msg = {
      id: 'fx3',
      createdTime: '1749999600000',
      contentType: 0 as const,
      text: 'FX spend USD 50 (บาท 1750) at Starbucks',
    };
    const tmpl: TransactionTemplate[] = [{
      pattern: 'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>บาท) (?<amount>[\\d.]+)\\) at .+',
      amount_sign: 'debit',
    }];
    const tx = parseTransaction(msg, tmpl, { 'บ': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.currency).toBe('บาท');
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: the 2 new tests fail. The `normalises currency group` test fails because `tx.currency` is `'บาท'`, not `'THB'`. All 34 existing tests still pass.

- [ ] **Step 3: Implement the fix**

In `src/transaction-parser.ts`, find line 126:

```typescript
    if (g.currency) tx.currency = g.currency.trim();
```

Change it to:

```typescript
    if (g.currency) tx.currency = aliases[g.currency.trim()] ?? g.currency.trim();
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/transaction-parser.test.ts
```

Expected: all 36 tests pass (34 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/transaction-parser.ts src/transaction-parser.test.ts
git commit -m "feat: apply currency aliases to currency capture group"
```

---

## Self-Review

**Spec coverage:**
- ✅ `tx.currency` normalised via aliases — Task 1 step 3
- ✅ Test: alias applied to `currency` group — Task 1 step 1
- ✅ Test: pass-through when alias not found — Task 1 step 1

**Placeholder scan:** None.

**Type consistency:** `tx.currency` is `string | undefined` (unchanged). The alias lookup returns `string` when `g.currency` is present — no type widening.
