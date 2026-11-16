import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';

// Same commit/context shape the real `Release` workflow plans with.
const commits = [
  { hash: 'a'.repeat(40), message: 'fix: correct pagination' },
  { hash: 'b'.repeat(40), message: 'feat: add account export' },
];

const context = {
  commits,
  lastRelease: { gitHead: 'c'.repeat(40), gitTag: 'v0.1.0' },
  logger: { log: () => undefined },
  nextRelease: { gitHead: 'd'.repeat(40), gitTag: 'v0.2.0', version: '0.2.0' },
  options: { repositoryUrl: 'https://github.com/raidenyn/line-mcp.git' },
};

describe('release notes', () => {
  it('renders the changes, not just a version header', async () => {
    const notes = await generateNotes({ preset: 'conventionalcommits' }, context);

    // The installed preset major must match the writer that
    // @semantic-release/release-notes-generator uses: an incompatible pair
    // renders only the version header.
    expect(notes).toContain('## [0.2.0]');
    expect(notes).toContain('### Bug Fixes');
    expect(notes).toContain('* correct pagination');
    expect(notes).toContain('### Features');
    expect(notes).toContain('* add account export');
  });
});
