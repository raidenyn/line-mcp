# LINE MCP Template Store — Design Spec

**Date:** 2026-06-21
**Goal:** Eliminate dependency on the `regex-from-messages` skill by (1) persisting transaction templates server-side so they survive sessions, and (2) embedding enough regex guidance into tool descriptions that Claude can derive and save correct patterns unaided.

---

## Problem

`get_transactions` requires the caller to supply regex templates on every call. Building those templates requires knowledge of named capture groups, JSON double-escaping, non-breaking spaces, and the `s` flag — all currently documented only in the `regex-from-messages` skill. Without that skill loaded, Claude struggles to produce correct patterns, and correct patterns are re-derived from scratch each session.

---

## Solution Overview

Three changes:

1. **`src/template-store.ts`** — new module for file-based template persistence
2. **Three tool changes** — two new tools (`sample_messages`, `manage_templates`), one modified tool (`get_transactions`)
3. **Description enrichment** — regex rules embedded in tool/parameter descriptions so no external skill is needed

---

## Storage Layer

### Directory and file layout

```
.line-templates/
  c1234abcdef.json      # one file per chat MID
  u5678ghijkl.json
```

Location: project root (same level as `.line-mcp-secret`). Created automatically on first write.

### File format

```json
{
  "templates": [
    {
      "name": "uob-debit-v1",
      "pattern": "spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)",
      "amount_sign": "debit",
      "date_format": "DD/MM",
      "valid_until": "2025-02-28T23:59:59+07:00"
    },
    {
      "name": "uob-debit-v2",
      "pattern": "deducted\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)",
      "amount_sign": "debit",
      "valid_from": "2025-03-01T00:00:00+07:00"
    }
  ]
}
```

### `NamedTemplate` type

Extends `TransactionTemplate` (from `transaction-parser.ts`) with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Unique key within the chat; used for upsert/delete |
| `valid_from` | `string` | No | ISO 8601 datetime with timezone offset; omit = beginning of time |
| `valid_until` | `string` | No | ISO 8601 datetime with timezone offset; omit = still active |

### `src/template-store.ts` module

Pure functions, no singleton state:

- `loadTemplates(chatMid)` → `NamedTemplate[]` — reads file; returns `[]` if file absent or corrupt
- `upsertTemplate(chatMid, template)` — inserts or replaces by `name`
- `deleteTemplate(chatMid, name)` → `boolean` — returns `false` if name not found
- `listTemplates(chatMid)` → `NamedTemplate[]` — full objects including patterns
- `filterByTime(templates, timestampMs)` → `NamedTemplate[]` — keeps entries where `timestampMs` falls within `[valid_from, valid_until]`

**Path traversal guard:** chat MID validated against `/^[a-zA-Z0-9_-]+$/` before constructing file path. Invalid MIDs throw before any I/O.

---

## Tool Changes

### New: `sample_messages`

**Purpose:** Show raw message text with timestamps so Claude can identify anchor strings, field boundaries, and when the bank changed its format — before writing any regex.

**Input:**
- `chatMid: string`
- `count: number` (default 20, max 50)

**Output:** Text-only (`contentType === 0`) messages, oldest-first, one per line:
```
[2025-01-15T10:23:00.000Z] You have spent THB 1,250.00 using UOB card at Starbucks on 15/01.
[2025-03-02T08:11:00.000Z] Amount deducted THB 890.00 from your account at 7-Eleven.
```

**Description includes:** *"Use this before writing regex templates — it shows raw message text with timestamps so you can identify anchor strings, field boundaries, and when the bank changed its message format."*

---

### New: `manage_templates`

**Purpose:** CRUD for saved templates. Single tool, three actions.

**Input:**
- `chatMid: string`
- `action: "upsert" | "delete" | "list"`
- `template: NamedTemplate` — required for `upsert`
- `name: string` — required for `delete`

**Actions:**
- `upsert` — saves or replaces template matching `template.name`; returns confirmation
- `delete` — removes template by `name`; errors if not found: `"No template named '<name>' found for this chat."`
- `list` — returns full template array (patterns, signs, date formats, validity ranges) for the chat, in insertion order

**`template` parameter description embeds regex rules:**
- Named capture groups required: `(?<currency>...)` and `(?<amount>...)`. Optional: `(?<merchant>...)`, `(?<date>...)`, `(?<balance>...)`, `(?<account>...)`
- Pattern compiled as `new RegExp(pattern, 's')` — dotAll always on; one pattern handles multi-line/bilingual messages
- Backslashes must be doubled in JSON: `\\d`, `\\s`, `\\.` — but `/` needs no escaping
- Bank messages often use non-breaking spaces (U+00A0) — use `\\s+` not a literal space at word boundaries
- `amount_sign: "debit"` → stored negative; `"credit"` → stored positive
- `date_format` hint: `"DD/MM"`, `"DD/MM/YYYY"`, or `"DD/MM/YYYY HH:mm"` — omit if date is already ISO-parseable
- `valid_from` / `valid_until`: ISO 8601 with timezone, e.g. `"2025-03-01T00:00:00+07:00"` — use when the bank changed its message format; messages outside this range skip this template

---

### Modified: `get_transactions`

**Change:** `templates` parameter becomes optional.

**New behaviour when `templates` is omitted:**
1. Load templates from `.line-templates/<chatMid>.json`
2. For each message, filter loaded templates to those where `createdTime` falls within `[valid_from, valid_until]`
3. Try filtered templates in order; first match wins

**Error messages:**
- No file + no param supplied: `"No templates provided and none saved for this chat. Call sample_messages to inspect messages, then manage_templates (action: upsert) to save patterns."`
- Templates loaded but all filtered out (none valid for message timestamps): individual messages silently dropped. If zero transactions result: `"0 transactions matched. Check that saved templates cover the message timestamps — use manage_templates (action: list) to review validity ranges."`

**Updated description:** *"If templates is omitted, saved templates for this chat are loaded automatically and filtered per message by valid_from/valid_until, so format changes across time are handled transparently."*

---

## Description Enrichment Strategy

The self-contained workflow Claude follows without any skill:

1. `sample_messages` — inspect raw messages, note timestamps of format changes
2. Read `manage_templates` schema — regex rules are in the parameter descriptions
3. `manage_templates (action: upsert)` — save pattern(s) with appropriate `valid_from`/`valid_until`
4. `get_transactions` — call with no `templates` arg; server loads and applies automatically

---

## Error Handling Summary

| Scenario | Behaviour |
|----------|-----------|
| Corrupt/unreadable template file | Returns `[]` + warning in response; server does not crash |
| No templates saved, none supplied | Clear error with workflow hint |
| Zero transactions after filtering | Returns empty result with hint to check validity ranges |
| Invalid chatMid (path traversal) | Rejected before any I/O with descriptive error |
| `delete` on unknown name | Error: `"No template named '<name>' found for this chat."` |
| Unparseable `valid_from`/`valid_until` | Template treated as always-valid; warning included in response |

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `src/template-store.ts` | New — storage module |
| `src/index.ts` | Add `sample_messages`, `manage_templates` tools; modify `get_transactions` |
| `.gitignore` | Add `.line-templates/` |
