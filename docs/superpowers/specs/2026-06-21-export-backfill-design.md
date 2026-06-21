# LINE Export Backfill — Design Spec

**Date:** 2026-06-21  
**Status:** Approved

## Problem

The LINE API only exposes recent message history. Users who have older messages available as LINE's built-in text export (`.txt` files) have no way to backfill the SQLite cache with that history, which means `get_transactions` and `summarize_transactions` miss older data.

## Goal

Allow a user to import a LINE chat export file into the SQLite message cache so that all MCP tools can query the full history as if it came from the API.

## Non-Goals

- Parsing binary LINE backup formats
- Importing images or other non-text content
- Modifying existing API-sourced cache records

---

## Export File Format

LINE exports chat history as UTF-8 plain text with this structure:

```
Chat history with <ChatName>
Saved on: M/D/YYYY, HH:MM

Day, M/D/YYYY
HH:MM	SenderName	message text first line
                    continuation of multi-line message
HH:MM	SenderName	next message
```

Key observations:
- Only `HH:MM` timestamps (no seconds, no timezone)
- Sender names only (no MIDs)
- Multi-line messages: continuation lines have no leading timestamp; joined with `\n`
- Messages wrapped in `[…]` are flex/image messages rendered as text — imported as-is

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/export-parser.ts` | Pure function: text → `Message[]`. No I/O, no LINE calls. |
| `tests/export-parser.test.ts` | Unit tests (no LINE session required, runs under `npm run test:unit`) |

### Modified files

| File | Change |
|------|--------|
| `src/index.ts` | Two new MCP tools: `initiate_import`, `complete_import` |
| `src/oauth.ts` | New HTTP route: `POST /import-upload` |

---

## Three-Step Import Protocol

### Step 1 — `initiate_import` MCP tool

**Input:** none

**Server action:**
- Generates a one-time `upload_token` (UUID v4, 15-minute TTL)
- Stores it in an in-memory `pendingUploads: Map<token, { expires: number }>` (same pattern as `loginSessions` in `oauth.ts`)

**Response:**
```json
{ "upload_url": "https://<server>/import-upload?token=<uuid>" }
```

**Claude's next action:** runs via Bash tool:
```bash
curl -F "file=@/local/path.txt" "<upload_url>"
```
The file content travels directly from the local filesystem to the server — it never passes through Claude's context window.

---

### Step 2 — `POST /import-upload?token=<uuid>` HTTP endpoint

**Auth:** one-time token in query string (consumed on first use — replay protection)

**Input:** multipart form data with field `file` containing the `.txt` export

**Server actions:**
1. Validates and consumes the token (delete from `pendingUploads`)
2. Reads file body as UTF-8 string
3. Parses the first line to extract `chat_name`
4. Generates a `file_ref_id` (UUID v4, 1-hour TTL)
5. Stores `{ content, chat_name, expires }` in `pendingFiles: Map<file_ref_id, ...>`

**Response:**
```json
{ "file_ref_id": "<uuid>", "chat_name": "SCB Connect" }
```

Claude shows the detected `chat_name` to the user and proceeds to Step 3.

---

### Step 3 — `complete_import` MCP tool

**Input:**
| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `file_ref_id` | string | yes | From Step 2 response |
| `timezone` | string | no | IANA name, e.g. `Asia/Bangkok`. Claude **must** ask the user explicitly before calling if not provided. |
| `chat_mid` | string | no | Override auto-resolution |

**Server actions:**
1. Retrieve stored file content by `file_ref_id` (error if expired/missing)
2. Resolve `chat_mid`:
   - If `chat_mid` provided → use directly
   - Otherwise call `listChats`, case-insensitive match on `chat_name`:
     - Exactly one match → use it
     - No match → `needs_info` with all available chat names
     - Multiple matches → `needs_info` with matching candidates
3. If `timezone` not provided → `needs_info`
4. If all resolved → parse + upsert + return success

**`needs_info` response** (Claude re-asks the user and calls again):
```json
{
  "status": "needs_info",
  "missing": ["timezone"],
  "message": "What timezone are these messages in? e.g. Asia/Bangkok"
}
```
or
```json
{
  "status": "needs_info",
  "missing": ["chat_mid"],
  "candidates": [
    { "chat_mid": "u123abc", "name": "SCB Connect" }
  ],
  "message": "Multiple chats match 'SCB Connect'. Please pick one."
}
```

**Success response:**
```json
{
  "status": "success",
  "imported": 312,
  "chat_mid": "u123abc",
  "chat_name": "SCB Connect",
  "date_range": { "from": "2025-06-12T04:24:00.000Z", "to": "2026-06-21T10:11:00.000Z" }
}
```

---

## Parser (`src/export-parser.ts`)

```typescript
export function parseExportFile(text: string, chatMid: string, timezone: string): Message[]
```

### Tokenization

1. Split on `\n`, iterate line by line
2. **Skip** lines 1–2 (file header) and the blank line after
3. **Day header** regex: `/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2})\/(\d{1,2})\/(\d{4})$/`  
   → update current date context
4. **Message line** regex: `/^(\d{2}:\d{2})\t(.+?)\t(.*)$/`  
   → flush previous message, start new accumulator
5. **Continuation line** (anything else, non-empty) → append `\n` + line to current message text
6. After last line → flush final message

### Timestamp → epoch

Given parsed `year`, `month`, `day`, `hh`, `mm` and a user-supplied IANA `timezone`:

Use the `Intl.DateTimeFormat` + `formatToParts` offset-estimation technique:
1. Construct a candidate UTC instant assuming the local time is UTC: `guess = Date.UTC(year, month-1, day, hh, mm, 0)`
2. Format `guess` in the target timezone via `Intl.DateTimeFormat` with `hour12: false`
3. Parse the formatted parts back to numbers; compute `offset = guess - Date.UTC(parsedYear, parsedMonth-1, parsedDay, parsedHour, parsedMinute, 0)`
4. Return `guess + offset` (one Newton-step; exact for all non-DST-gap instants; good enough for export timestamps which are never precisely at a DST boundary)

This requires no external libraries. If `luxon` is added as a dependency in future, replace with `DateTime.fromObject({...}, { zone: timezone }).toMillis()` which handles DST gaps correctly.

### Synthetic message ID

```
id = "export-" + crypto.createHash('sha256')
  .update(chatMid + dateStr + timeStr + senderName + text)
  .digest('hex')
  .slice(0, 24)
```

Deterministic → re-importing the same file is fully idempotent (`INSERT OR REPLACE` in SQLite handles collisions).

### Synthesized `Message` fields

| Field | Value |
|-------|-------|
| `id` | `export-<sha256 hex slice>` |
| `from` | `export:<senderName>` (e.g. `export:SCB Connect`) |
| `senderName` | parsed sender name |
| `to` | `chatMid` |
| `toType` | `0` (direct message) |
| `createdTime` | UTC epoch ms as string |
| `contentType` | `0` (text) |
| `text` | parsed + joined multi-line text |
| `hasContent` | `false` |

---

## In-Memory Stores

Both stores live in `oauth.ts` (alongside `loginSessions` and `pendingCodes`) and are exported so `index.ts` can read `pendingFiles` in `complete_import`:

```typescript
export const pendingUploads = new Map<string, { expires: number }>();
export const pendingFiles   = new Map<string, { content: string; chatName: string; expires: number }>();
```

Expiry is checked on access (lazy eviction) — no background timers needed.

The `complete_import` tool calls `listChats` via the per-request `LineClient` instance, obtained through the same `AsyncLocalStorage` mechanism already used for `AuthData` in all other tool handlers.

---

## Error Cases

| Situation | Response |
|-----------|---------|
| Upload token expired/invalid | HTTP 401 |
| `file_ref_id` expired/missing | MCP error: "Import session expired. Call `initiate_import` again." |
| File not valid LINE export | MCP error: "File does not appear to be a LINE chat export." |
| `timezone` not a valid IANA name | MCP error with example valid values |
| No chats available (LINE not authed) | Propagates existing `listChats` error |

---

## Testing

`tests/export-parser.test.ts` (unit, no LINE session):
- Parses a minimal single-message fixture
- Handles multi-line messages (joined with `\n`)
- Generates deterministic IDs (same input → same ID)
- Re-import of same content is idempotent (duplicate IDs)
- Correct UTC epoch for a known Bangkok-timezone timestamp
- Skips blank lines and continuation lines correctly

The existing `e2e.test.ts` is not modified (no upload flow in e2e scope).

---

## Server URL Discovery

`initiate_import` constructs the `upload_url` using the incoming MCP request's `Host` header and protocol:

```typescript
const base = `${req.protocol}://${req.get('host')}`;
```

This requires passing the Express `req` object into the MCP tool handler via `AsyncLocalStorage` (same mechanism already used for `AuthData`).
