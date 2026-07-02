# SCB Connect Templates + Per-Chat Currency Aliases

**Date:** 2026-06-29  
**Status:** Approved

## Overview

Two related goals:

1. Create 8 regex transaction templates covering all SCB Connect message formats observed in `specs/chat_export_examples/Chat history with SCB Connect.txt`.
2. Add per-chat currency alias support so raw captured strings like `"บาท"` and `"บ"` normalise to `"THB"` — configured via the existing `manage_templates` MCP tool.

---

## Message formats covered

All bracket-format messages use `DD/MM/YYYY` dates; SMS-format messages use `DD/MM`.  
Templates are ordered most-specific first to avoid accidental overlap.

| # | Name | Example message | sign | date_format |
|---|------|-----------------|------|-------------|
| 1 | `scb-credit-labeled` | `[รายการเงินเข้า: ดอกเบี้ยเงินฝาก 314.61 บาท เข้าบัญชี X-1139 วันที่ 25/06/2025]` | credit | DD/MM/YYYY |
| 2 | `scb-credit-standard` | `[รายการเงินเข้า 1,488.03 บาท เข้าบัญชี X-1139 วันที่ 17/06/2025 @22:47 ยอดเงินที่ใช้ได้ 295,772.03 บาท]` | credit | DD/MM/YYYY |
| 3 | `scb-atm-withdrawal` | `[รายการเงินออก 2,900.00 บาท ด้วยบัตรเดบิต X-4885 จากบัญชี X-1139 ผ่านตู้ TMBA ATM ค่าธรรมเนียม 20.00 บาท วันที่ 05/07/2025 @20:45]` | debit | DD/MM/YYYY |
| 4 | `scb-debit-standard` | `[รายการเงินออก 2,000.00 บาท จากบัญชี X-1139 วันที่ 14/06/2025 @13:29 ยอดเงินที่ใช้ได้ 294,284.00 บาท]` | debit | DD/MM/YYYY |
| 5 | `scb-card-payment` | `[ชำระเงิน 163.52 บาท ด้วยบัตรเดบิต X-4885 จากบัญชี X-1139 @Yandex.Go ค่าธรรมเนียม 0.00 บาท วันที่ 06/08/2025 @13:07]` | debit | DD/MM/YYYY |
| 6 | `scb-tax-deduction` | `[หักภาษีเงินได้ สำหรับดอกเบี้ยเงินฝาก 47.19 บาท จากบัญชี X-1139 วันที่ 25/06/2025]` | debit | DD/MM/YYYY |
| 7 | `scb-salary-sms` | `เงินโอน/เงินเดือน 220,910.70บ เข้าบ/ชx121139 27/06@02:03` | credit | DD/MM |
| 8 | `scb-fee-sms` | `หักค่าธรรมเนียมอัตโนมัติ 200.00 บ. จาก บ/ช x121139 วันที่ 01/07 เวลา 03:43` | debit | DD/MM |

Template 8 also matches: `หักเงินอัตโนมัติ 199.00 บ. บ/ช x121139 วันที่ 21/04 เวลา 06:07`

Captured groups per template:

- **1** `original_amount`, `original_currency`(`บาท`), `merchant`(label text), `account`, `date`
- **2** `original_amount`, `original_currency`(`บาท`), `account`, `date`, `balance`
- **3** `original_amount`, `original_currency`(`บาท`), `account`, `merchant`(ATM name), `date`
- **4** `original_amount`, `original_currency`(`บาท`), `account`, `date`, `balance`
- **5** `original_amount`, `original_currency`(`บาท`), `account`, `merchant`, `date`
- **6** `original_amount`, `original_currency`(`บาท`), `merchant`(label text), `account`, `date`
- **7** `original_amount`, `original_currency`(`บ`), `account`, `date`
- **8** `original_amount`, `original_currency`(`บ`), `account`, `date`

---

## Currency alias system

### Storage

`data/templates/<chatMid>.json` is extended with a top-level `currency_aliases` key:

```json
{
  "templates": [...],
  "currency_aliases": {
    "บาท": "THB",
    "บ": "THB"
  }
}
```

Missing key = empty alias map (backward-compatible).

### `template-store.ts` changes

**`loadTemplates` return type** is extended to also return `currency_aliases: Record<string, string>` (empty object when absent).

**`writeTemplates` (private)** currently writes `{ templates }` only. It must be updated to also write `currency_aliases` so aliases are never silently erased when templates change. Signature becomes `writeTemplates(chatMid, templates, aliases, storeDir)`.

**Migration write** at the pattern-rename block also uses the old format — must be updated to include `currency_aliases` (read from the raw file before writing back).

Three new exported functions, all following the existing file-per-chatMid pattern with the same path-traversal guard:

- `upsertAlias(chatMid, alias, canonical, storeDir?)` — inserts or replaces one entry in `currency_aliases`, leaves `templates` unchanged
- `deleteAlias(chatMid, alias, storeDir?)` → `boolean` — removes entry, returns `false` if not found
- `listAliases(chatMid, storeDir?)` → `Record<string, string>` — returns all entries

### `transaction-parser.ts` changes

`parseTransaction` gains an optional second parameter:

```typescript
export function parseTransaction(
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
  aliases: Record<string, string> = {},
): Transaction | null
```

After extracting `original_currency` from the regex match, one lookup is applied before assigning to the transaction:

```typescript
original_currency: (aliases[g.original_currency.trim()] ?? g.original_currency.trim()),
```

No other logic changes.

### `manage_templates` tool — new actions

Three new actions added alongside `upsert`, `delete`, `list`. The `action` enum becomes `['upsert', 'delete', 'list', 'upsert_alias', 'delete_alias', 'list_aliases']`. The tool's Zod input schema gains two new optional fields: `alias: z.string().optional()` and `canonical: z.string().optional()`.

| Action | Required params | Effect |
|--------|----------------|--------|
| `upsert_alias` | `chatMid`, `alias`, `canonical` | Adds or replaces alias entry |
| `delete_alias` | `chatMid`, `alias` | Removes alias entry |
| `list_aliases` | `chatMid` | Returns all alias entries for chat |

### `index.ts` changes

- `get_transactions` and `summarize_transactions` handlers: after calling `loadTemplates(chatMid)`, also destructure `currency_aliases` from the result and pass it as the third argument to `parseTransaction`.
- `manage_templates` handler: switch on the three new action strings and call the corresponding store function.

---

## Files changed

| File | Change |
|------|--------|
| `src/transaction-parser.ts` | Add `aliases` param to `parseTransaction` |
| `src/template-store.ts` | Extend file schema; add `upsertAlias`, `deleteAlias`, `listAliases`; extend `loadTemplates` return |
| `src/index.ts` | Wire aliases in tool handlers; add 3 actions to `manage_templates` |
| `data/templates/<scb-chat-mid>.json` | New file with 8 templates + 2 alias entries |
| `docs/guide/tools/manage_templates.md` | Document 3 new actions |

---

## Out of scope

- Global (cross-chat) alias defaults — per-chat only
- Alias support in `summarize_transactions` directly (it receives already-parsed `Transaction[]` from `get_transactions`, so aliases are already applied upstream)
- UI or web config — MCP tool only
