import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Registration } from '@raidenyn/mcp-runtime';
import {
  registerLineTools,
  registerLineResources,
  type LinePrincipal,
  type LineToolDeps,
} from '@raidenyn/line-mcp';
import { registerBankTools, registerBankResources, type BankToolDeps } from '@raidenyn/bank-mcp';

async function readGuideFile(guideDir: string, relPath: string, uri: string) {
  try {
    const text = await fs.promises.readFile(path.join(guideDir, relPath), 'utf8');
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text }] };
  } catch {
    return { contents: [{ uri, mimeType: 'text/markdown' as const, text: `Guide file not found: ${relPath}` }] };
  }
}

/**
 * Registers ONLY the composed, ten-tool overview at `line://guide`. Both
 * registerLineResources() and registerBankResources() are called with
 * `includeOverview: false` in `buildRegistrations` below so their own
 * package-relative overview docs never fight over this shared URI — this is
 * the one and only overview registration for the composed server, reading
 * `packages/server/docs/guide/overview.md` (the real combined workflow map
 * covering all ten tools).
 */
export function registerComposedOverview(server: McpServer, guideDir: string): void {
  server.registerResource(
    'guide-overview',
    'line://guide',
    { description: 'Usage overview: workflow map, tool index, key facts about caching and auth', mimeType: 'text/markdown' },
    (_uri) => readGuideFile(guideDir, 'overview.md', 'line://guide'),
  );
}

export interface ComposedDeps {
  line: LineToolDeps;
  bank: BankToolDeps<LinePrincipal>;
  guideDir: string;
}

/**
 * Builds the composed server's full registration list: five messenger tools,
 * five bank tools, and eleven resources total (one composed overview + five
 * messenger guides + five bank guides). Exported separately from `server.ts`
 * so tests can drive the EXACT same production wiring against test-double
 * `deps` (never a hand-rolled re-implementation that could drift from what
 * `createServer` actually registers) — only the LINE network layer inside
 * `deps.line`/`deps.bank` needs to be faked in tests; the registration
 * closures themselves are always the real ones.
 *
 * Each closure is a `Registration<LinePrincipal>` (2-param: server, context)
 * wrapping `registerLineTools`/`registerBankTools` (3-param: they also need
 * `deps`) and `registerLineResources`/`registerBankResources` (context-free).
 * `createMcpHost` re-runs every one of these against a FRESH `McpServer` +
 * `RequestContext` on every single `POST /mcp`, so a resource registration
 * re-running per request is cheap (it only wires up a read handler, not the
 * read itself).
 */
export function buildRegistrations(deps: ComposedDeps): ReadonlyArray<Registration<LinePrincipal>> {
  return [
    (server, context) => registerLineTools(server, context, deps.line),
    (server, context) => registerBankTools(server, context, deps.bank),
    (server) => registerLineResources(server, { includeOverview: false }),
    (server) => registerBankResources(server, { includeOverview: false }),
    (server) => registerComposedOverview(server, deps.guideDir),
  ];
}
