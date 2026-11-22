import { execFileSync } from 'node:child_process';
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
        'Bash(npm run test:e2e*)',
      ]),
    );
  });

  it('denies LINE credentials, ltsm edits, npm publish and force pushes', () => {
    const deny = settings.permissions?.deny ?? [];
    expect(deny).toEqual(
      expect.arrayContaining([
        'Read(./.line-auth.json)',
        'Read(./.line-mcp-tokens.json)',
        'Read(./data/**)',
        'Read(./.env*)',
        'Edit(./packages/line-client/assets/ltsm/**)',
        'Write(./packages/line-client/assets/ltsm/**)',
        'Bash(npm publish*)',
        'Bash(git push --force*)',
        'Bash(git push -f*)',
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
    expect(ci).toContain('gitleaks');
    expect(ci).toContain('GITLEAKS_VERSION:');
    expect(ci).toContain('--log-opts=');
    expect(ci).toContain('fetch-depth: 0');
  });

  it('scans staged changes before commit and skips without gitleaks', () => {
    const hook = readFileSync('.husky/pre-commit', 'utf8');
    expect(hook).toContain('command -v gitleaks');
    expect(hook).toContain('gitleaks protect --staged --redact');
    expect(hook).toContain('skipping staged secret scan');
  });

  it('extends the default rules and allowlists only known test fixtures', () => {
    const config = readFileSync('.gitleaks.toml', 'utf8');
    expect(config).toContain('[extend]');
    expect(config).toContain('useDefault = true');
    expect(config).toContain('packages/mcp-runtime/src/token-codec');
  });
});
