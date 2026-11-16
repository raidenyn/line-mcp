import { describe, it, expect, vi } from 'vitest';
import { parseTrustProxy, resolvePublicOrigin } from './public-url';

describe('resolvePublicOrigin', () => {
  it('falls back to localhost when unset or blank', () => {
    expect(resolvePublicOrigin(undefined, 3000)).toBe('http://localhost:3000');
    expect(resolvePublicOrigin('', 3000)).toBe('http://localhost:3000');
    expect(resolvePublicOrigin('   ', 3000)).toBe('http://localhost:3000');
  });

  it('normalizes an https origin (trailing slash, case, default port)', () => {
    expect(resolvePublicOrigin('https://mcp.example.com/', 3000)).toBe('https://mcp.example.com');
    expect(resolvePublicOrigin('https://MCP.Example.com:443', 3000)).toBe('https://mcp.example.com');
    expect(resolvePublicOrigin('https://mcp.example.com:8443', 3000)).toBe('https://mcp.example.com:8443');
  });

  it('accepts loopback http without warning', () => {
    const warn = vi.fn();
    expect(resolvePublicOrigin('http://localhost:8080', 3000, warn)).toBe('http://localhost:8080');
    expect(resolvePublicOrigin('http://127.0.0.1:8080', 3000, warn)).toBe('http://127.0.0.1:8080');
    expect(resolvePublicOrigin('http://[::1]:8080', 3000, warn)).toBe('http://[::1]:8080');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts non-loopback http with exactly one warning naming PUBLIC_URL', () => {
    const warn = vi.fn();
    expect(resolvePublicOrigin('http://192.168.1.10:3000', 3000, warn)).toBe('http://192.168.1.10:3000');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('PUBLIC_URL');
  });

  it('rejects a path and points at BASE_PATH', () => {
    expect(() => resolvePublicOrigin('https://mcp.example.com/line-mcp', 3000))
      .toThrowError(/PUBLIC_URL/);
    expect(() => resolvePublicOrigin('https://mcp.example.com/line-mcp', 3000))
      .toThrowError(/BASE_PATH/);
  });

  it.each([
    'https://u:p@mcp.example.com',
    'https://mcp.example.com?x=1',
    'https://mcp.example.com#f',
    'not a url',
    'ftp://x',
  ])('rejects %s naming PUBLIC_URL', raw => {
    expect(() => resolvePublicOrigin(raw, 3000)).toThrowError(/PUBLIC_URL/);
  });
});

describe('parseTrustProxy', () => {
  it('treats unset, blank, false and zero as off', () => {
    for (const raw of [undefined, '', ' ', 'false', 'FALSE', '0']) {
      expect(parseTrustProxy(raw)).toBe(false);
    }
  });

  it('parses case-insensitive true and hop counts', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('returns validated range lists', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(parseTrustProxy('::1')).toBe('::1');
  });

  it.each(['-3', '1.5', 'yes', '10.0.0.0/99', 'loopback,,x'])('rejects %s naming TRUST_PROXY', raw => {
    expect(() => parseTrustProxy(raw)).toThrowError(/TRUST_PROXY/);
  });
});
