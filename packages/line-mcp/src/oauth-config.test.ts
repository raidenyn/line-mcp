import { describe, it, expect, vi } from 'vitest';
import { resolveOAuthConfig } from './oauth-config';

describe('resolveOAuthConfig', () => {
  it('falls back to localhost loopback-only defaults when everything is unset', () => {
    const config = resolveOAuthConfig({ port: 3000 });
    expect(config.publicOrigin).toBe('http://localhost:3000');
    expect(config.explicitPublicUrl).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.redirectPolicy.isAllowed('https://client.example.com/cb')).toBe(false);
    expect(config.redirectPolicy.isAllowed('http://localhost:8123/cb')).toBe(true);
  });

  it('resolves all three values when set', () => {
    const config = resolveOAuthConfig({
      publicUrl: 'https://mcp.example.com',
      allowedRedirectUris: 'https://client.example.com/oauth/callback',
      trustProxy: '1',
      port: 3000,
    });
    expect(config.publicOrigin).toBe('https://mcp.example.com');
    expect(config.explicitPublicUrl).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.redirectPolicy.isAllowed('https://client.example.com/oauth/callback')).toBe(true);
  });

  it('treats blank/whitespace values as unset', () => {
    const config = resolveOAuthConfig({
      publicUrl: '',
      allowedRedirectUris: ' , ',
      trustProxy: '',
      port: 3000,
    });
    expect(config.publicOrigin).toBe('http://localhost:3000');
    expect(config.explicitPublicUrl).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.redirectPolicy.isAllowed('https://client.example.com/cb')).toBe(false);
  });

  it.each([
    [{ publicUrl: 'https://mcp.example.com/path' }, /PUBLIC_URL/],
    [{ allowedRedirectUris: 'http://a.com/cb' }, /OAUTH_ALLOWED_REDIRECT_URIS/],
    [{ trustProxy: 'yes' }, /TRUST_PROXY/],
  ] as const)('fails closed naming the variable for %j', (input, pattern) => {
    expect(() => resolveOAuthConfig({ port: 3000, ...input })).toThrowError(pattern);
  });

  it('propagates the http warning exactly once', () => {
    const warn = vi.fn();
    resolveOAuthConfig({ publicUrl: 'http://192.168.1.10:3000', port: 3000, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('PUBLIC_URL');
  });
});
