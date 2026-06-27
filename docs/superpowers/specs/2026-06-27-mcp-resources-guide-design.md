# MCP Resources Guide — Design Spec

**Date:** 2026-06-27
**Status:** Approved

## Overview

Add a set of MCP resources to the LINE MCP server that expose a usage guide consumable by both the AI assistant and human developers. Resources are readable via the MCP protocol (`resources/list`, `resources/read`) and serve markdown content loaded from disk at request time.

## Goals

- Let the AI assistant understand how to use the tools without the user having to explain each session
- Provide cross-tool workflow guidance (what to call before/after each tool, when to use one vs. another)
- Keep documentation alongside the code in version control, editable without touching TypeScript

## File Structure

Guide markdown files live in `docs/guide/` in the repo root (not in `data/` — these are source files, not runtime data):

```
docs/guide/
  overview.md
  tools/
    list_chats.md
    get_messages.md
    get_image.md
    sample_messages.md
    manage_templates.md
    get_transactions.md
    summarize_transactions.md
    initiate_import.md
    complete_import.md
```

These files ship with the repository and are read from disk at resource-read time. They are not copied to `dist/` but **must be present in the working directory** at runtime. The `Dockerfile` currently only copies `src/`, `dist/`, and config files — it must be updated to also `COPY docs/guide ./docs/guide` so resources are available in the Docker image. For local `ts-node` development the files are already accessible from the repo root.

## MCP Resource URIs

| URI | File |
|-----|------|
| `line://guide` | `docs/guide/overview.md` |
| `line://guide/tools/list_chats` | `docs/guide/tools/list_chats.md` |
| `line://guide/tools/get_messages` | `docs/guide/tools/get_messages.md` |
| `line://guide/tools/get_image` | `docs/guide/tools/get_image.md` |
| `line://guide/tools/sample_messages` | `docs/guide/tools/sample_messages.md` |
| `line://guide/tools/manage_templates` | `docs/guide/tools/manage_templates.md` |
| `line://guide/tools/get_transactions` | `docs/guide/tools/get_transactions.md` |
| `line://guide/tools/summarize_transactions` | `docs/guide/tools/summarize_transactions.md` |
| `line://guide/tools/initiate_import` | `docs/guide/tools/initiate_import.md` |
| `line://guide/tools/complete_import` | `docs/guide/tools/complete_import.md` |

## Resource Registration

All resources are registered in `src/index.ts` alongside the existing `registerTool` calls, using `server.registerResource(name, uri, metadata, readCallback)`.

The `readCallback`:
- Reads the corresponding markdown file with `fs.readFile` (async, at request time — not cached)
- Returns content as `text/markdown` MIME type
- If the file is missing, returns a short error string (does not throw — keeps the server alive)

Path resolution uses `process.cwd()` (repo root), which works in both `ts-node` (development) and `dist/` builds as long as the working directory is the repo root.

## Content Structure

### `overview.md`

1. **Server description** — one paragraph: what this MCP server is and what it connects to
2. **Workflow map** — a table with three workflows and the ordered tool sequence for each:

| Workflow | Tools in order |
|----------|---------------|
| Browse chats & messages | `list_chats` → `get_messages` → `get_image` (optional) |
| Parse bank transactions | `sample_messages` → `manage_templates` → `get_transactions` → `summarize_transactions` |
| Import chat history | `initiate_import` → `complete_import` |

3. **Key facts** — message cache (SQLite, persists history beyond LINE's ~2-week API window), auth (OAuth via QR code, handled by Claude Code automatically)

### Per-tool files (`tools/<name>.md`)

Each file follows this template (sections omitted only if genuinely not applicable):

```markdown
# <tool_name>

**When to use:** One sentence on the right scenario for this tool.

**Prerequisites:** Tool(s) to call first, or "None".

**Next steps:** What to call after this tool, and why.

**Key parameters:** Only non-obvious parameters — skip anything self-evident from the name.

**Avoid:** Common misuses or gotchas specific to this tool.
```

## Error Handling

Missing guide files return an error message string rather than propagating an exception. This means a deleted or misnamed file produces a readable error in the resource content, not a crashed server.

## Dockerfile Change

Add one line to the production stage of `Dockerfile`:

```dockerfile
COPY docs/guide ./docs/guide
```

This ensures guide files are present at `/app/docs/guide/` in the container, consistent with `WORKDIR /app`.

## CLAUDE.md Maintenance Instruction

`CLAUDE.md` must be updated as part of this implementation to document the resources feature. Additionally, a standing instruction must be added to `CLAUDE.md` that reads:

> **MCP Resources:** When any `docs/guide/` file is added, removed, or substantively changed, update the `CLAUDE.md` description of the resources feature to match. When a new tool is added to `index.ts`, a corresponding `docs/guide/tools/<tool_name>.md` file must also be created and registered as a resource.

This keeps `CLAUDE.md` — the primary reference for Claude Code sessions — accurate as the server evolves.

## Out of Scope

- Caching file reads in memory (files are small, changes should be visible immediately)
- Auto-generating content from tool schemas (content is hand-authored for AI-readability)
- Per-user or per-session resources (all resources are static and shared)
