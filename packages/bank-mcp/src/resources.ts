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

export interface RegisterBankResourcesOptions {
  /**
   * Register the overview at the shared `line://guide` URI. Defaults to true.
   * The composed server (which already registers the combined messenger
   * overview at that same URI via registerLineResources) passes `false` here
   * so bank registration stays additive rather than fighting over which
   * overview wins the shared URI.
   */
  includeOverview?: boolean;
}

const TOOL_GUIDES: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'sample_messages', description: 'When to use sample_messages, since/until params, role before template writing' },
  { name: 'manage_templates', description: 'When to use manage_templates, capture group requirements, time-bounded templates' },
  { name: 'manage_categories', description: 'When to use manage_categories, pattern matching rules, global scope vs per-chat templates' },
  { name: 'get_transactions', description: 'When to use get_transactions, why since is critical, auto-loaded templates' },
  { name: 'summarize_transactions', description: 'When to use summarize_transactions, group_by options, final step in transaction workflow' },
];

/** Registers the bank overview (optional) plus the five bank tool guides. */
export function registerBankResources(server: McpServer, options: RegisterBankResourcesOptions = {}): void {
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
