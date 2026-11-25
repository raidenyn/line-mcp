import { describe, expect, it } from 'vitest';
// Plain ESM without declarations: the CI helper is a script, not part of the
// TypeScript build.
import { findPeerProblems } from '../../scripts/check-peers.mjs';

const clean = { bad: {}, missing: {}, conflicts: [], intersections: {} };

describe('peer dependency check', () => {
  it('reports nothing for a report with no peer problems', () => {
    const report = Object.fromEntries(
      ['.', 'packages/bank-mcp', 'packages/line-client', 'packages/line-client-sqlite', 'packages/line-mcp', 'packages/mcp-runtime', 'packages/server']
        .map((importer) => [importer, clean]),
    );
    expect(findPeerProblems(report)).toEqual([]);
  });

  it('reports unmet, missing and conflicting peers with their importer', () => {
    expect(findPeerProblems({ '.': { ...clean, bad: { zod: { wanted: '^3' } } } })).toEqual([
      expect.stringMatching(/^\.: bad zod/),
    ]);
    expect(findPeerProblems({ 'packages/server': { ...clean, missing: { express: {} } } })).toEqual([
      expect.stringMatching(/^packages\/server: missing express/),
    ]);
    expect(findPeerProblems({ 'packages/line-mcp': { ...clean, conflicts: ['@modelcontextprotocol/sdk'] } })).toEqual([
      expect.stringMatching(/^packages\/line-mcp: conflicts /),
    ]);
  });
});
