import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// docs/guide sits alongside dist/ as a sibling of package.json (not inside
// src/, so it needs no compile step) — `__dirname` resolves the same way
// whether this file is running via ts-node from src/ or as compiled dist/.
const DOCS_DIR = path.join(__dirname, '..', 'docs', 'guide');

async function readGuideFile(relPath: string, uri: string) {
  try {
    const text = await fs.promises.readFile(path.join(DOCS_DIR, relPath), 'utf8');
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text }] };
  } catch {
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text: `Guide file not found: ${relPath}` }] };
  }
}

export interface RegisterLineResourcesOptions {
  /**
   * Register the messenger overview at `line://guide`. Defaults to true.
   * A composed server that registers its own combined overview at that same
   * URI should pass `false` here so registration stays additive rather than
   * fighting over which overview wins.
   */
  includeOverview?: boolean;
}

const TOOL_GUIDES: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'list_chats', description: 'When to use list_chats, prerequisites, next steps' },
  { name: 'get_messages', description: 'When to use get_messages, key parameters, workflow position' },
  { name: 'get_image', description: 'When to use get_image, URL source requirements' },
  { name: 'initiate_import', description: 'When to use initiate_import, upload flow, expiry' },
  { name: 'complete_import', description: 'When to use complete_import, timezone requirement, needs_info handling' },
];

/** Registers the messenger overview (optional) plus the five messenger tool guides. */
export function registerLineResources(server: McpServer, options: RegisterLineResourcesOptions = {}): void {
  const { includeOverview = true } = options;

  if (includeOverview) {
    server.registerResource(
      'guide-overview',
      'line://guide',
      { description: 'Usage overview: workflow map, tool index, key facts about caching and auth', mimeType: 'text/markdown' },
      (_uri) => readGuideFile('overview.md', 'line://guide'),
    );
  }

  for (const { name, description } of TOOL_GUIDES) {
    server.registerResource(
      `guide-${name}`,
      `line://guide/tools/${name}`,
      { description, mimeType: 'text/markdown' },
      (_uri) => readGuideFile(`tools/${name}.md`, `line://guide/tools/${name}`),
    );
  }
}
