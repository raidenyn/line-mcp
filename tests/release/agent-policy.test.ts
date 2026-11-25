import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PermissionSettings {
  enabledPlugins?: Record<string, boolean>;
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
}

const settings = JSON.parse(
  readFileSync('.claude/settings.json', 'utf8'),
) as PermissionSettings;

describe('agent permission policy', () => {
  it('keeps enabled plugins and declares allow, ask and deny rules', () => {
    expect(settings.enabledPlugins).toBeDefined();
    for (const group of ['allow', 'ask', 'deny'] as const) {
      expect(settings.permissions?.[group]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('prompts before pushes, merges and credentialed suites', () => {
    const ask = settings.permissions?.ask ?? [];
    expect(ask).toEqual(
      expect.arrayContaining([
        'Bash(git push*)',
        'Bash(gh pr create*)',
        'Bash(gh pr merge*)',
        'Bash(docker push*)',
        'Bash(pnpm run test:e2e*)',
        'Bash(pnpm exec vitest run *e2e*)',
        // Legacy forms still work (node_modules/.bin exists), so they must ask too.
        'Bash(npm run test:e2e*)',
        'Bash(npx vitest run *e2e*)',
      ]),
    );
  });

  it('does not allow a broad vitest run that would reach the live e2e suite', () => {
    const allow = settings.permissions?.allow ?? [];
    expect(allow).not.toContain('Bash(pnpm exec vitest run *)');
    expect(allow).not.toContain('Bash(npx vitest run *)');
    expect(allow.some(rule => rule.includes('e2e'))).toBe(false);
    // The safe roots from CLAUDE.md are still auto-approved.
    expect(allow).toEqual(
      expect.arrayContaining([
        'Bash(pnpm exec vitest run packages*)',
        'Bash(pnpm exec vitest run tests/architecture*)',
        'Bash(pnpm exec vitest run tests/release*)',
        'Bash(pnpm exec vitest run tests/smoke*)',
        'Bash(pnpm exec vitest run tests/artifacts*)',
        'Bash(pnpm exec vitest run tests/docker*)',
        'Bash(pnpm run lint*)',
        'Bash(pnpm run build*)',
        'Bash(pnpm run test:unit*)',
        'Bash(pnpm run test:smoke*)',
        'Bash(pnpm run verify*)',
        'Bash(pnpm exec eslint *)',
      ]),
    );
  });

  it('denies LINE credentials, ltsm edits, npm and pnpm publish and force pushes', () => {
    const deny = settings.permissions?.deny ?? [];
    expect(deny).toEqual(
      expect.arrayContaining([
        'Read(/.line-auth.json)',
        'Read(/.line-mcp-tokens.json)',
        'Read(/data/**)',
        'Read(/.env*)',
        'Read(/.line-mcp-secret)',
        'Read(/auth/**)',
        'Read(/line-qr.png)',
        'Edit(/packages/line-client/assets/ltsm/**)',
        'Bash(npm publish*)',
        'Bash(pnpm publish*)',
        'Bash(git push --force*)',
        'Bash(git push -f*)',
        'Bash(git push * --force*)',
        'Bash(git push * -f*)',
        'Bash(git push *+*)',
      ]),
    );
  });

  it('does not track personal settings overrides', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', '.claude/settings.local.json'],
      { encoding: 'utf8' },
    );
    expect(tracked.trim()).toBe('');
  });
});

describe('secret scanning', () => {
  it('scans the changed commits in the CI check job', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    // Read-only token; no workflow-level write permissions.
    expect(ci).toContain('permissions:\n  contents: read');
    // Pinned binary with a pinned digest, checked against the digest itself
    // rather than a checksum file from the same release.
    expect(ci).toContain('GITLEAKS_VERSION: 8.30.1');
    expect(ci).toContain(
      'GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    );
    expect(ci).toContain('sha256sum -c -');
    // Range selection: fail when the base is missing, scan one commit on an
    // initial push, and use the current `git` subcommand.
    expect(ci).toContain('fetch-depth: 0');
    expect(ci).toContain('git cat-file -e');
    expect(ci).toContain('log_opts="-1 ${head_sha}"');
    expect(ci).toContain('"$RUNNER_TEMP/gitleaks" git');
    expect(ci).toContain('--log-opts="$log_opts"');
  });

  it('scans staged changes before commit and skips without gitleaks', () => {
    const hook = readFileSync('.husky/pre-commit', 'utf8');
    expect(hook).toContain('command -v gitleaks');
    expect(hook).toContain('gitleaks git --staged --pre-commit --redact');
  });

  it('exits 0 with a warning when gitleaks is not installed', () => {
    const result = spawnSync('/bin/sh', ['.husky/pre-commit'], {
      env: { ...process.env, PATH: '/nonexistent' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'gitleaks not installed; skipping staged secret scan',
    );
  });

  it('extends the default rules and allowlists only the known test line', () => {
    const config = readFileSync('.gitleaks.toml', 'utf8');
    expect(config).toContain('[extend]');
    expect(config).toContain('useDefault = true');
    expect(config).toContain('condition = "AND"');
    expect(config).toContain('regexTarget = "line"');
    expect(config).toContain('packages/mcp-runtime/src/token-codec');
  });
});
