import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release documentation', () => {
  it('documents enforced commits and perf releases for contributors', () => {
    const guide = readFileSync('AGENTS.md', 'utf8');
    expect(guide).toContain('`perf` → patch');
    expect(guide).toContain('commit-msg');
    expect(guide).toContain('CI');
    expect(guide).toContain('docs/RELEASING.md');
    expect(guide).toContain('Change type → required process');
    expect(guide).not.toMatch(/do not create or offer git worktrees/i);
  });

  it('keeps CLAUDE.md as a thin import plus Claude-specific notes', () => {
    const claude = readFileSync('CLAUDE.md', 'utf8');
    expect(claude).toMatch(/^@AGENTS\.md$/m);
    // Claude-specific notes may follow the import, but the shared guide must
    // not be duplicated back into CLAUDE.md.
    expect(claude).not.toContain('## Commands');
    expect(claude).not.toContain('## Workflow');
    expect(claude).not.toContain('## Doc map');
  });

  it('documents bootstrap and the gated release operations', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('v0.1.0');
    expect(runbook).toContain('gh release create');
    expect(runbook).toContain('workflow_dispatch');
    expect(runbook).toContain('No releasable commits');
    expect(runbook).toContain('draft');
    expect(runbook).toContain('owner');
    // The five stages of the Release workflow, in order.
    expect(runbook).toContain('`authorize`');
    expect(runbook).toContain('`plan`');
    expect(runbook).toContain('`draft`');
    expect(runbook).toContain('`images`');
    expect(runbook).toContain('`publish`');
    // The release-triggered dispatch and the manual image re-publication are gone.
    expect(runbook).not.toContain('release-published');
    expect(runbook).not.toContain(':edge');
    expect(runbook).not.toContain('gh workflow run publish-docker.yml');
  });

  it('documents recovery after the release is already public', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('after the release is public');
    expect(runbook).toContain('Re-run failed jobs');
    // A full re-run would stop at `draft` once the release is published.
    expect(runbook).toContain('A full re-run would stop at `draft`');
  });

  it('documents anonymous pulls of the public images', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('docker pull ghcr.io/raidenyn/line-mcp-full:');
    expect(readme).toContain('docker pull ghcr.io/raidenyn/line-mcp:');
    expect(readme).toContain('@sha256:');
    expect(readme).toContain('`sha-<short>`');
    expect(readme).toContain('pr-<number>');
    // The `edge` preview tag no longer exists.
    expect(readme).not.toContain('`edge`');
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

  it('documents the publication stages and the one-way visibility flip', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('## Docker Images');
    expect(runbook).toContain('### First publication: the one-way visibility flip');
    expect(runbook).toContain('GITHUB_TOKEN');
    expect(runbook).toContain('ghcr-publish');
    expect(runbook).toContain('Publish Docker');
    expect(runbook).toContain('Docker images');
    expect(runbook).toContain('cannot be made private again');
    // The private-package bootstrap and its personal token are gone.
    expect(runbook).not.toContain('GHCR Private-Package Bootstrap');
    expect(runbook).not.toContain('GHCR_PUBLISH_TOKEN');
    expect(runbook).not.toContain('GHCR_PACKAGES_PRIVATE');
    expect(runbook).not.toContain('Inherit access');
    expect(runbook).not.toContain('read:packages');
    expect(runbook).not.toContain('must stay private');
  });

  it('documents the pull-request label and its tag allowlist', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    expect(runbook).toContain('`publish-docker`');
    expect(runbook).toContain('`pr-<number>`');
    expect(runbook).toContain('`sha-<short>`');
    expect(runbook).toContain('same-repository');
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

  it('documents image tags without the git tag prefix', () => {
    const runbook = readFileSync('docs/RELEASING.md', 'utf8');
    // Images are tagged `X.Y.Z`; only the git tag carries the leading `v`.
    expect(runbook).toContain('ghcr.io/raidenyn/line-mcp-full:X.Y.Z');
    expect(runbook).toContain('ghcr.io/raidenyn/line-mcp:X.Y.Z');
    expect(runbook).not.toContain(':vX.Y.Z');
  });

  it('records the release and publication workflows in the architecture reference', () => {
    const architecture = readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(architecture).toContain('release.yml');
    expect(architecture).toContain('publish-docker.yml');
    expect(architecture).toContain('workflow_call');
    expect(architecture).toContain('ghcr.io');
    expect(architecture).toContain('GITHUB_TOKEN');
    expect(architecture).toContain('draft');
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
