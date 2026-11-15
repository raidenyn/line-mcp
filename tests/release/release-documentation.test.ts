import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release documentation', () => {
  it('documents enforced commits and perf releases for contributors', () => {
    const guide = readFileSync('CLAUDE.md', 'utf8');
    expect(guide).toContain('`perf` → patch');
    expect(guide).toContain('commit-msg');
    expect(guide).toContain('CI');
    expect(guide).toContain('docs/RELEASING.md');
  });

  it('documents bootstrap and normal release operations', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('v0.1.0');
    expect(runbook).toContain('gh release create');
    expect(runbook).toContain('workflow_dispatch');
    expect(runbook).toContain('No releasable commits');
    expect(runbook).toContain('release-published');
  });

  it('documents authenticated pulls of the private images', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('docker login ghcr.io');
    expect(readme).toContain('ghcr.io/raidenyn/line-mcp-full:');
    expect(readme).toContain('ghcr.io/raidenyn/line-mcp:');
    expect(readme).toContain('@sha256:');
    expect(readme).toContain('`edge`');
    expect(readme).toContain('`sha-<short>`');
    expect(readme).toContain('must stay private');
    expect(readme).toContain('must grant access');
  });

  it('documents publishing, re-publishing, and private visibility', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('## Docker Images');
    expect(runbook).toContain('### GHCR Private-Package Bootstrap');
    expect(runbook).toContain('GHCR_PACKAGES_PRIVATE');
    expect(runbook).toContain('GHCR_PUBLISH_TOKEN');
    expect(runbook).toContain('ghcr-publish');
    expect(runbook).toContain('Inherit access');
    expect(runbook).toContain('org.opencontainers.image.source');
    expect(runbook).toContain('Publish Docker');
    expect(runbook).toContain('must stay private');
    expect(runbook).toContain('read:packages');
    expect(runbook).toContain('released');
  });

  it('records the publication workflow in the architecture reference', () => {
    const architecture = readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(architecture).toContain('publish-docker.yml');
    expect(architecture).toContain('ghcr.io');
  });
});
