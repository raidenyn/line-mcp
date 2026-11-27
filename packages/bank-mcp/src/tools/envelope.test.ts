import { describe, expect, it, vi } from 'vitest';
import { LedgerError } from '../ledger/errors';
import { INTERNAL_ERROR_MESSAGE, errorResult, okResult, runTool } from './envelope';

describe('envelope', () => {
  it('puts a success in structuredContent and the same JSON in text', () => {
    const result = okResult({ settings: { base_currency: 'THB' }, sources: [] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ settings: { base_currency: 'THB' }, sources: [] });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it('puts a typed error in structuredContent and the same JSON in text', () => {
    const result = errorResult({
      code: 'conflict',
      message: 'm',
      details: { a: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: 'conflict', message: 'm', details: { a: 1 } } });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(result.structuredContent).not.toHaveProperty('error.action');
  });

  it('maps a LedgerError to its code and fields', async () => {
    const result = await runTool(() => {
      throw new LedgerError('not_found', 'No such source.', {
        action: 'Try another id.',
        details: { source_id: 'c-x' },
      });
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'not_found',
        message: 'No such source.',
        action: 'Try another id.',
        details: { source_id: 'c-x' },
      },
    });
  });

  it('answers an unexpected exception as a fixed internal_error and logs the original', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runTool(() => {
        throw new Error('SQLITE secret table name');
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: 'internal_error', message: INTERNAL_ERROR_MESSAGE },
      });
      expect(JSON.stringify(result.content)).not.toContain('SQLITE');
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('SQLITE secret table name');
    } finally {
      stderr.mockRestore();
    }
  });
});
