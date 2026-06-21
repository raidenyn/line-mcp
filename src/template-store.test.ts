import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTemplates,
  upsertTemplate,
  deleteTemplate,
  listTemplates,
  filterByTime,
  NamedTemplate,
} from './template-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-tmpl-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TMPL_A: NamedTemplate = {
  name: 'uob-debit-v1',
  pattern: 'spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_until: '2025-02-28T23:59:59+07:00',
};
const TMPL_B: NamedTemplate = {
  name: 'uob-debit-v2',
  pattern: 'deducted\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_from: '2025-03-01T00:00:00+07:00',
};

describe('loadTemplates', () => {
  it('returns empty array for missing file', () => {
    const result = loadTemplates('mid123', dir);
    expect(result.templates).toEqual([]);
    expect(result.warning).toBeUndefined();
  });
});

describe('upsertTemplate', () => {
  it('creates file and inserts template', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });

  it('replaces template with same name', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    const updated = { ...TMPL_A, valid_until: '2025-03-31T23:59:59+07:00' };
    upsertTemplate('mid123', updated, dir);
    const result = loadTemplates('mid123', dir).templates;
    expect(result).toHaveLength(1);
    expect(result[0].valid_until).toBe('2025-03-31T23:59:59+07:00');
  });

  it('inserts second template without replacing first', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(loadTemplates('mid123', dir).templates).toHaveLength(2);
  });
});

describe('deleteTemplate', () => {
  it('returns false when name not found', () => {
    expect(deleteTemplate('mid123', 'nonexistent', dir)).toBe(false);
  });

  it('removes template and returns true', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(deleteTemplate('mid123', 'uob-debit-v1', dir)).toBe(true);
    const remaining = loadTemplates('mid123', dir).templates;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('uob-debit-v2');
  });
});

describe('listTemplates', () => {
  it('returns full objects in insertion order', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertTemplate('mid123', TMPL_B, dir);
    expect(listTemplates('mid123', dir)).toEqual([TMPL_A, TMPL_B]);
  });

  it('returns empty array when no file exists', () => {
    expect(listTemplates('mid123', dir)).toEqual([]);
  });
});

describe('filterByTime', () => {
  // TMPL_A valid until 2025-02-28T23:59:59+07:00 = 2025-02-28T16:59:59.000Z = 1740761999000 ms UTC
  // TMPL_B valid from 2025-03-01T00:00:00+07:00  = 2025-02-28T17:00:00.000Z = 1740762000000 ms UTC
  const beforeCutover = new Date('2025-02-15T00:00:00.000Z').getTime();
  const afterCutover = new Date('2025-03-15T00:00:00.000Z').getTime();

  it('returns only template valid before cutover', () => {
    const result = filterByTime([TMPL_A, TMPL_B], beforeCutover);
    expect(result.map(t => t.name)).toEqual(['uob-debit-v1']);
  });

  it('returns only template valid after cutover', () => {
    const result = filterByTime([TMPL_A, TMPL_B], afterCutover);
    expect(result.map(t => t.name)).toEqual(['uob-debit-v2']);
  });

  it('returns all templates when no validity range set', () => {
    const noRange: NamedTemplate = { name: 'open', pattern: '(?<currency>THB) (?<amount>[\\d.]+)' };
    expect(filterByTime([noRange], beforeCutover)).toEqual([noRange]);
    expect(filterByTime([noRange], afterCutover)).toEqual([noRange]);
  });

  it('treats unparseable valid_from as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<currency>THB) (?<amount>[\\d.]+)', valid_from: 'not-a-date' };
    expect(filterByTime([bad], beforeCutover)).toEqual([bad]);
  });

  it('treats unparseable valid_until as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<currency>THB) (?<amount>[\\d.]+)', valid_until: 'not-a-date' };
    expect(filterByTime([bad], afterCutover)).toEqual([bad]);
  });
});

describe('path traversal guard', () => {
  it('throws for chatMid with slash', () => {
    expect(() => loadTemplates('../etc/passwd', dir)).toThrow('Invalid chatMid');
  });

  it('throws for chatMid with dot', () => {
    expect(() => loadTemplates('mid.123', dir)).toThrow('Invalid chatMid');
  });
});
