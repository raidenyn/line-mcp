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

  it('documents anonymous pulls of the public images', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('docker pull ghcr.io/raidenyn/line-mcp-full:');
    expect(readme).toContain('docker pull ghcr.io/raidenyn/line-mcp:');
    expect(readme).toContain('@sha256:');
    expect(readme).toContain('`edge`');
    expect(readme).toContain('`sha-<short>`');
    // Public packages need no credential and no access grant.
    expect(readme).not.toContain('docker login ghcr.io');
    expect(readme).not.toContain('must grant access');
    expect(readme).not.toContain('must stay private');
    expect(readme).toContain('cannot be made private again');
  });

  it('documents the same newest-stable gate for the X.Y and X moving tags', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain(
      '| `X.Y` | Newest release in that minor line — moves only for the globally newest stable tag |',
    );
    expect(readme).toContain(
      '| `X` | Newest release in that major line — moves only for the globally newest stable tag, and never on `0.x` |',
    );
  });

  it('documents publishing, re-publishing, and the one-way visibility flip', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('## Docker Images');
    expect(runbook).toContain('### First publication: the one-way visibility flip');
    expect(runbook).toContain('GITHUB_TOKEN');
    expect(runbook).toContain('ghcr-publish');
    expect(runbook).toContain('Publish Docker');
    expect(runbook).toContain('cannot be made private again');
    expect(runbook).toContain('released');
    // The private-package bootstrap and its personal token are gone.
    expect(runbook).not.toContain('GHCR Private-Package Bootstrap');
    expect(runbook).not.toContain('GHCR_PUBLISH_TOKEN');
    expect(runbook).not.toContain('GHCR_PACKAGES_PRIVATE');
    expect(runbook).not.toContain('Inherit access');
    expect(runbook).not.toContain('read:packages');
    expect(runbook).not.toContain('must stay private');
  });

  it('points the visibility flip at the personal package settings pages', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    // `raidenyn` is a personal account, so organization package URLs 404.
    expect(runbook).toContain('/users/raidenyn/packages/container/');
    expect(runbook).not.toContain('github.com/orgs/');
    // The flip is visibility only: packages are never deleted or unlinked.
    expect(runbook.toLowerCase()).toContain('never delete');
    expect(runbook).not.toContain('unlink each package');
  });

  it('records the publication workflow in the architecture reference', () => {
    const architecture = readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(architecture).toContain('publish-docker.yml');
    expect(architecture).toContain('ghcr.io');
    expect(architecture).toContain('GITHUB_TOKEN');
    expect(architecture).toContain('public');
    expect(architecture).not.toContain('GHCR_PUBLISH_TOKEN');
    expect(architecture).not.toContain('GHCR_PACKAGES_PRIVATE');
  });

  it('records the dated owner acceptance of public images and keeps npm blocked', () => {
    const notices = readFileSync('packages/line-client/THIRD_PARTY_NOTICES.md', 'utf8');
    expect(notices).toContain('2026-11-16');
    expect(notices).toContain('owner');
    expect(notices).toContain('public container images');
    expect(notices).toContain('not approved');
    expect(notices.toLowerCase()).toContain('npm');

    const provenance = JSON.parse(
      readFileSync('packages/line-client/assets/ltsm/provenance.json', 'utf8'),
    ) as {
      approvedDistributionForms: Record<string, string>;
    };
    const forms = provenance.approvedDistributionForms;
    expect(forms.publicContainerImage).toContain('2026-11-16');
    expect(forms.sourceRepository).toContain('public');
    expect(forms.publicNpmPublish).toMatch(/^NOT approved/);
  });
});
