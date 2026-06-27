# MCP Resources Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a comprehensive usage guide as MCP resources (`line://guide` + `line://guide/tools/<name>`) so the AI assistant and developers can read cross-tool workflow guidance directly from the server.

**Architecture:** Markdown files in `docs/guide/` are registered as static MCP resources in `src/index.ts` using `server.registerResource()`. A shared helper reads each file from disk at request time. File presence in Docker is ensured by a `COPY` directive.

**Tech Stack:** `@modelcontextprotocol/sdk` `registerResource` API, Node.js `fs.promises.readFile`, existing `McpServer` in `src/index.ts`.

## Global Constraints

- All guide files live under `docs/guide/` — not `data/` (runtime data) or `dist/` (build output)
- Path resolution uses `process.cwd()` (repo root) consistent with `data-dir.ts`
- Missing guide files return an error string in content — they do not throw or crash the server
- Resource MIME type: `text/markdown`
- `registerResource` calls go in `src/index.ts` alongside existing `registerTool` calls
- Tests extend `tests/e2e.test.ts` (requires `.line-auth.json`)

---

### Task 1: Resource registration + stub files + e2e test

**Files:**
- Modify: `src/index.ts` — add `fs` import, `readGuideFile` helper, 10 `registerResource` calls
- Modify: `tests/e2e.test.ts` — add resource list + read tests
- Create: `docs/guide/overview.md` (stub)
- Create: `docs/guide/tools/list_chats.md` (stub)
- Create: `docs/guide/tools/get_messages.md` (stub)
- Create: `docs/guide/tools/get_image.md` (stub)
- Create: `docs/guide/tools/sample_messages.md` (stub)
- Create: `docs/guide/tools/manage_templates.md` (stub)
- Create: `docs/guide/tools/get_transactions.md` (stub)
- Create: `docs/guide/tools/summarize_transactions.md` (stub)
- Create: `docs/guide/tools/initiate_import.md` (stub)
- Create: `docs/guide/tools/complete_import.md` (stub)

**Interfaces:**
- Produces: `readGuideFile(relPath: string, uri: string): Promise<ReadResourceResult>` used by all `registerResource` callbacks

- [ ] **Step 1: Write the failing e2e tests**

Append to `tests/e2e.test.ts` (after the last `it(...)` block):

```typescript
it('resources/list returns all 10 guide URIs', async () => {
  const result = await mcpClient.listResources();
  const uris = result.resources.map((r) => r.uri);
  const expected = [
    'line://guide',
    'line://guide/tools/list_chats',
    'line://guide/tools/get_messages',
    'line://guide/tools/get_image',
    'line://guide/tools/sample_messages',
    'line://guide/tools/manage_templates',
    'line://guide/tools/get_transactions',
    'line://guide/tools/summarize_transactions',
    'line://guide/tools/initiate_import',
    'line://guide/tools/complete_import',
  ];
  for (const uri of expected) {
    expect(uris).toContain(uri);
  }
});

it('resources/read returns non-empty markdown for line://guide', async () => {
  const result = await mcpClient.readResource({ uri: 'line://guide' });
  expect(result.contents).toHaveLength(1);
  const item = result.contents[0];
  expect(item.mimeType).toBe('text/markdown');
  if ('text' in item) {
    expect(item.text.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/e2e.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `mcpClient.listResources()` returns 0 resources, assertions fail.

- [ ] **Step 3: Create stub guide files**

Create `docs/guide/overview.md`:
```markdown
# LINE MCP Server — Usage Guide

(Full content coming soon.)
```

Create `docs/guide/tools/list_chats.md`:
```markdown
# list_chats

(Guide content coming soon.)
```

Repeat the same stub pattern for each of the remaining 8 tool files:
- `docs/guide/tools/get_messages.md`
- `docs/guide/tools/get_image.md`
- `docs/guide/tools/sample_messages.md`
- `docs/guide/tools/manage_templates.md`
- `docs/guide/tools/get_transactions.md`
- `docs/guide/tools/summarize_transactions.md`
- `docs/guide/tools/initiate_import.md`
- `docs/guide/tools/complete_import.md`

Each stub is:
```markdown
# <tool_name>

(Guide content coming soon.)
```

- [ ] **Step 4: Add `fs` import to `src/index.ts`**

Add after the existing imports (e.g. after line 17 `import { cacheDbPath } from './data-dir';`):

```typescript
import fs from 'fs';
```

- [ ] **Step 5: Add `readGuideFile` helper and resource registrations to `src/index.ts`**

Add immediately after the `server` and `authStore` declarations (around line 33, before the first `server.registerTool` call):

```typescript
async function readGuideFile(relPath: string, uri: string) {
  try {
    const text = await fs.promises.readFile(join(process.cwd(), relPath), 'utf8');
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text }] };
  } catch {
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text: `Guide file not found: ${relPath}` }] };
  }
}

server.registerResource(
  'guide-overview',
  'line://guide',
  { description: 'Usage overview: workflow map, tool index, key facts about caching and auth', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/overview.md', 'line://guide'),
);
server.registerResource(
  'guide-list_chats',
  'line://guide/tools/list_chats',
  { description: 'When to use list_chats, prerequisites, next steps', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/list_chats.md', 'line://guide/tools/list_chats'),
);
server.registerResource(
  'guide-get_messages',
  'line://guide/tools/get_messages',
  { description: 'When to use get_messages, key parameters, workflow position', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/get_messages.md', 'line://guide/tools/get_messages'),
);
server.registerResource(
  'guide-get_image',
  'line://guide/tools/get_image',
  { description: 'When to use get_image, URL source requirements', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/get_image.md', 'line://guide/tools/get_image'),
);
server.registerResource(
  'guide-sample_messages',
  'line://guide/tools/sample_messages',
  { description: 'When to use sample_messages, since/until params, role before template writing', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/sample_messages.md', 'line://guide/tools/sample_messages'),
);
server.registerResource(
  'guide-manage_templates',
  'line://guide/tools/manage_templates',
  { description: 'When to use manage_templates, capture group requirements, time-bounded templates', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/manage_templates.md', 'line://guide/tools/manage_templates'),
);
server.registerResource(
  'guide-get_transactions',
  'line://guide/tools/get_transactions',
  { description: 'When to use get_transactions, why since is critical, auto-loaded templates', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/get_transactions.md', 'line://guide/tools/get_transactions'),
);
server.registerResource(
  'guide-summarize_transactions',
  'line://guide/tools/summarize_transactions',
  { description: 'When to use summarize_transactions, group_by options, final step in transaction workflow', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/summarize_transactions.md', 'line://guide/tools/summarize_transactions'),
);
server.registerResource(
  'guide-initiate_import',
  'line://guide/tools/initiate_import',
  { description: 'When to use initiate_import, upload flow, expiry', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/initiate_import.md', 'line://guide/tools/initiate_import'),
);
server.registerResource(
  'guide-complete_import',
  'line://guide/tools/complete_import',
  { description: 'When to use complete_import, timezone requirement, needs_info handling', mimeType: 'text/markdown' },
  (_uri) => readGuideFile('docs/guide/tools/complete_import.md', 'line://guide/tools/complete_import'),
);
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
npx vitest run tests/e2e.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS including the two new resource tests.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/e2e.test.ts docs/guide/
git commit -m "feat: register MCP resources guide with stub content"
```

---

### Task 2: Write guide content

**Files:**
- Modify: `docs/guide/overview.md`
- Modify: `docs/guide/tools/list_chats.md`
- Modify: `docs/guide/tools/get_messages.md`
- Modify: `docs/guide/tools/get_image.md`
- Modify: `docs/guide/tools/sample_messages.md`
- Modify: `docs/guide/tools/manage_templates.md`
- Modify: `docs/guide/tools/get_transactions.md`
- Modify: `docs/guide/tools/summarize_transactions.md`
- Modify: `docs/guide/tools/initiate_import.md`
- Modify: `docs/guide/tools/complete_import.md`

**Interfaces:**
- Consumes: stub files from Task 1
- Produces: finalized guide files (no interface changes — same URIs, same registration)

- [ ] **Step 1: Write `docs/guide/overview.md`**

Replace the stub with:

```markdown
# LINE MCP Server — Usage Guide

This MCP server connects to LINE messenger and exposes tools for reading chats, parsing bank transaction notifications, and importing chat history. It authenticates via OAuth (QR code scan) handled automatically by Claude Code.

## Workflow Map

| Workflow | Tool sequence |
|----------|--------------|
| Browse chats & messages | `list_chats` → `get_messages` → `get_image` (optional) |
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Import historical chat export | `initiate_import` → *(curl upload)* → `complete_import` |

## Key Facts

- **Message cache:** Every message fetched is stored in a local SQLite database (`data/cache/messages.db`). The cache persists history beyond LINE's ~2-week API window — `since` dates from months ago work without special configuration.
- **Templates persist:** Regex templates saved with `manage_templates` are stored per-chat in `data/templates/<chatMid>.json` and loaded automatically by `get_transactions` in all future sessions. No need to re-derive patterns each session.
- **Auth:** On first use, Claude Code opens a browser QR page. Scan with the LINE mobile app. Tokens refresh automatically; no manual intervention is needed after initial setup.

## Per-Tool Guides

Read these resources for workflow context on each tool:

- `line://guide/tools/list_chats`
- `line://guide/tools/get_messages`
- `line://guide/tools/get_image`
- `line://guide/tools/sample_messages`
- `line://guide/tools/manage_templates`
- `line://guide/tools/get_transactions`
- `line://guide/tools/summarize_transactions`
- `line://guide/tools/initiate_import`
- `line://guide/tools/complete_import`
```

- [ ] **Step 2: Write `docs/guide/tools/list_chats.md`**

```markdown
# list_chats

**When to use:** At the start of any session to discover available chats and retrieve their MIDs.

**Prerequisites:** None.

**Next steps:** Pass a MID to `get_messages` to read that chat's messages, or to `sample_messages` / `get_transactions` for transaction parsing.

**Avoid:** Don't hardcode MIDs across sessions — chat MIDs are stable but calling `list_chats` first is cheap and confirms the chat still exists.
```

- [ ] **Step 3: Write `docs/guide/tools/get_messages.md`**

```markdown
# get_messages

**When to use:** To read recent messages from a known chat — browsing conversation content, checking for images, or reviewing what was said.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** `get_image` if any message has a `previewUrl`; `sample_messages` if you need to inspect raw text for pattern-writing.

**Key parameters:**
- `count` (default 50, max 200) — for history older than 200 messages, use `sample_messages` with `since` instead.

**Avoid:** Don't use for transaction parsing — use `get_transactions` which applies saved templates automatically. Don't set `count` above 200 (validation rejects it).
```

- [ ] **Step 4: Write `docs/guide/tools/get_image.md`**

```markdown
# get_image

**When to use:** When a message returned by `get_messages` contains a `previewUrl` and you need to view the image.

**Prerequisites:** `get_messages` — the `url` parameter must be a `previewUrl` from a message, not a manually constructed URL.

**Next steps:** Depends on context — typically none; image viewing is a terminal step.

**Avoid:** Don't construct LINE image URLs manually. Only use URLs that appear verbatim in `get_messages` output — they carry auth tokens and expire.
```

- [ ] **Step 5: Write `docs/guide/tools/sample_messages.md`**

```markdown
# sample_messages

**When to use:** Before writing a regex template — to inspect the raw text format of bank notification messages in a chat.

**Prerequisites:** `list_chats` to get the `chatMid`.

**Next steps:** `manage_templates` (action: upsert) to save a pattern based on what you observe.

**Key parameters:**
- `since` / `until` (ISO 8601 date strings) — critical for reaching older messages if a bank changed its format months ago. Without `since`, only the latest messages are returned.
- Results are sorted oldest-first and filtered to text-only messages.

**Avoid:** Don't skip this step before writing templates — message formats vary significantly between banks and change over time. Use `since` whenever you need to capture historical format variations.
```

- [ ] **Step 6: Write `docs/guide/tools/manage_templates.md`**

```markdown
# manage_templates

**When to use:** To save, update, delete, or list named regex templates for parsing bank notifications from a chat.

**Prerequisites:** `sample_messages` to inspect the actual message format before writing a pattern.

**Next steps:** `get_transactions` — saved templates load automatically from `data/templates/<chatMid>.json` in all future sessions.

**Key parameters:**
- `action`: `upsert` | `delete` | `list`
- `pattern`: regex with named capture groups. **Required:** `(?<original_amount>...)`, `(?<original_currency>...)`. Optional: `(?<balance>...)`, `(?<merchant>...)`, `(?<date>...)`, `(?<account>...)`, `(?<amount>...)`, `(?<currency>...)`
- `amount_sign`: `debit` | `credit` — required for `upsert`
- `valid_from` / `valid_until`: ISO 8601 with timezone offset — use when a bank changes format so old messages use old templates and new messages use new ones

**Avoid:** Never use literal spaces in patterns — LINE bank messages frequently contain non-breaking spaces (U+00A0) that look identical but break literal-space matches. Always use `\\s+`. The `s` (dotAll) flag is applied automatically so `.` matches newlines in bilingual messages.
```

- [ ] **Step 7: Write `docs/guide/tools/get_transactions.md`**

```markdown
# get_transactions

**When to use:** To extract structured transaction records from bank notification messages in a LINE chat.

**Prerequisites:** `manage_templates` must have been called at least once to save templates for this chat. Templates load automatically — no need to pass them on each call.

**Next steps:** `summarize_transactions` to aggregate totals by month or merchant.

**Key parameters:**
- `chatMid`: the chat MID from `list_chats`
- `since` (ISO date string, e.g. `"2026-05-01"`): **always pass this** for complete history over a date range. Without `since`, only the latest 200 messages are scanned and a note is appended recommending `since` for accuracy.
- `until` (ISO date string): optional end bound; defaults to now

**Avoid:** Don't call without `since` if you need complete monthly data — you will get incomplete results. Don't pass inline `templates` unless testing a new pattern; saved templates are already loaded automatically and apply `valid_from`/`valid_until` filtering per message.
```

- [ ] **Step 8: Write `docs/guide/tools/summarize_transactions.md`**

```markdown
# summarize_transactions

**When to use:** To aggregate parsed transaction data into totals grouped by month or merchant.

**Prerequisites:** `get_transactions` — this tool operates on the same parsed data pipeline.

**Next steps:** None — this is the final step in the transaction workflow.

**Key parameters:**
- `chatMid`: the chat MID
- `group_by`: `month` | `merchant`
- `since` / `until`: filter the aggregation window (ISO date strings)

**Avoid:** Don't call before `get_transactions` has run with a `since` range covering the period you want to summarize — the result will be incomplete.
```

- [ ] **Step 9: Write `docs/guide/tools/initiate_import.md`**

```markdown
# initiate_import

**When to use:** To import a LINE chat export file (.txt) to backfill historical messages beyond LINE's ~2-week API window.

**Prerequisites:** The user must have exported a chat from the LINE mobile app (Chat menu → Export chat history).

**Next steps:** After receiving the `upload_url`, upload the `.txt` file:
```
curl -X POST --data-binary @/path/to/file.txt -H "Content-Type: text/plain" "<upload_url>"
```
The curl response contains a `file_ref_id`. Pass that to `complete_import`.

**Key parameters:** None — the tool generates a one-time upload URL valid for 15 minutes.

**Avoid:** Don't use for recent messages — the message cache handles incremental fetches automatically. If the upload URL expires, call `initiate_import` again to get a new one.
```

- [ ] **Step 10: Write `docs/guide/tools/complete_import.md`**

```markdown
# complete_import

**When to use:** To finalize a chat history import after uploading the export file via `initiate_import`.

**Prerequisites:** `initiate_import` must have run and the export file must have been uploaded to the returned `upload_url`.

**Next steps:** Imported messages are now in the cache. Call `sample_messages` or `get_transactions` — they will include the imported history.

**Key parameters:**
- `file_ref_id`: from the curl response after uploading the export file
- `timezone`: IANA timezone name (e.g. `"Asia/Bangkok"`). **Always ask the user explicitly** — LINE exports use local time with no timezone marker, so an incorrect timezone shifts all timestamps.
- `chat_mid`: optional; used to override auto-detection when the tool returns candidate MIDs

**Avoid:** Don't guess the timezone — ask the user explicitly before calling. If `complete_import` returns `status: "needs_info"`, read its `message` field and ask the user for the missing information before retrying.
```

- [ ] **Step 11: Run tests to confirm files load correctly**

```bash
npx vitest run tests/e2e.test.ts --reporter=verbose 2>&1 | grep -E "PASS|FAIL|guide"
```

Expected: all tests PASS. The resource tests still pass — the content changed but the files are present and non-empty.

- [ ] **Step 12: Commit**

```bash
git add docs/guide/
git commit -m "docs: write guide content for all MCP resources"
```

---

### Task 3: Update Dockerfile for Docker deployments

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: `docs/guide/` from Task 2
- Produces: Docker image where `docs/guide/` is present at `/app/docs/guide/`

- [ ] **Step 1: Add COPY instruction to Dockerfile**

In `Dockerfile`, locate the production stage (the second `FROM` block, which has `WORKDIR /app` and `COPY --from=builder`). Add one line after the existing `COPY` lines:

```dockerfile
COPY docs/guide ./docs/guide
```

The production stage should look like:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY src/ltsm ./dist/ltsm
COPY docs/guide ./docs/guide
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "chore: copy docs/guide into Docker image for MCP resources"
```

---

### Task 4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: final resource URIs and file paths from Tasks 1–2

- [ ] **Step 1: Add MCP Resources section to CLAUDE.md**

In `CLAUDE.md`, locate the `### Source files (`src/`)` section. Add a new `### MCP Resources (`docs/guide/`)` subsection after the architecture description. Insert the following block after the `**`index.ts`**` description and before the next source file entry (or at an appropriate place in the Architecture section):

```markdown
### MCP Resources (`docs/guide/`)

Ten static markdown resources are registered in `index.ts` via `server.registerResource()` and served over the MCP protocol:

| URI | File |
|-----|------|
| `line://guide` | `docs/guide/overview.md` |
| `line://guide/tools/<name>` | `docs/guide/tools/<name>.md` |

Files are read from disk at request time via `fs.promises.readFile`. Missing files return an error string in the content rather than crashing. The `docs/guide/` tree is copied into the Docker image (`COPY docs/guide ./docs/guide` in `Dockerfile`).

**Maintenance rule:** When any `docs/guide/` file is added, removed, or substantively changed, update this CLAUDE.md section to match. When a new tool is added to `index.ts`, also create `docs/guide/tools/<tool_name>.md` and a corresponding `registerResource` call.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document MCP resources in CLAUDE.md with maintenance rule"
```
