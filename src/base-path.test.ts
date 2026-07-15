import { describe, it, expect, afterEach } from 'vitest';
import { normalizeBasePath, getPublicOrigin } from './base-path';

describe('normalizeBasePath', () => {
  it('returns empty string for undefined', () => {
    expect(normalizeBasePath(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(normalizeBasePath('')).toBe('');
  });

  it('returns empty string for root slash', () => {
    expect(normalizeBasePath('/')).toBe('');
  });

  it('strips a single trailing slash', () => {
    expect(normalizeBasePath('/line-mcp/')).toBe('/line-mcp');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeBasePath('/line-mcp///')).toBe('/line-mcp');
  });

  it('returns empty string for an all-slash input', () => {
    expect(normalizeBasePath('///')).toBe('');
  });

  it('adds a leading slash when missing', () => {
    expect(normalizeBasePath('line-mcp')).toBe('/line-mcp');
  });

  it('preserves a nested path', () => {
    expect(normalizeBasePath('/tools/line-mcp')).toBe('/tools/line-mcp');
  });

  it('leaves an already-normalized path unchanged', () => {
    expect(normalizeBasePath('/line-mcp')).toBe('/line-mcp');
  });
});

describe('getPublicOrigin', () => {
  const ORIGINAL = process.env.PUBLIC_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = ORIGINAL;
  });

  it('uses PUBLIC_URL when set', () => {
    process.env.PUBLIC_URL = 'https://mcp.example.test';
    expect(getPublicOrigin(3000)).toBe('https://mcp.example.test');
  });

  it('strips a trailing slash from PUBLIC_URL', () => {
    process.env.PUBLIC_URL = 'https://mcp.example.test/';
    expect(getPublicOrigin(3000)).toBe('https://mcp.example.test');
  });

  it('falls back to localhost when PUBLIC_URL is unset', () => {
    delete process.env.PUBLIC_URL;
    expect(getPublicOrigin(3000)).toBe('http://localhost:3000');
  });
});
