import { describe, it, expect } from 'vitest';
import { normalizeBasePath } from './base-path';

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
