import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTemplates,
  upsertTemplate,
  deleteTemplate,
  listTemplates,
  filterByTime,
  upsertAlias,
  deleteAlias,
  listAliases,
  NamedTemplate,
} from './template-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-tmpl-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TMPL_A: NamedTemplate = {
  name: 'uob-debit-v1',
  pattern: 'spent\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
  amount_sign: 'debit',
  valid_until: '2025-02-28T23:59:59+07:00',
};
const TMPL_B: NamedTemplate = {
  name: 'uob-debit-v2',
  pattern: 'deducted\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
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
    const noRange: NamedTemplate = { name: 'open', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)' };
    expect(filterByTime([noRange], beforeCutover)).toEqual([noRange]);
    expect(filterByTime([noRange], afterCutover)).toEqual([noRange]);
  });

  it('treats unparseable valid_from as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)', valid_from: 'not-a-date' };
    expect(filterByTime([bad], beforeCutover)).toEqual([bad]);
  });

  it('treats unparseable valid_until as always-valid', () => {
    const bad: NamedTemplate = { name: 'bad', pattern: '(?<original_currency>THB) (?<original_amount>[\\d.]+)', valid_until: 'not-a-date' };
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

describe('loadTemplates migration', () => {
  it('migrates old (?<amount>) and (?<currency>) group names to new names on load', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'old-tmpl',
            pattern: 'spent\\s+(?<currency>THB)\\s+(?<amount>[\\d,.]+)',
            amount_sign: 'debit',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent\\s+(?<original_currency>THB)\\s+(?<original_amount>[\\d,.]+)',
    );
    expect(result.warning).toBeUndefined();
  });

  it('rewrites the file so subsequent loads return the migrated pattern', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [{ name: 'old', pattern: 'pay (?<currency>\\w+) (?<amount>[\\d.]+)' }],
      }),
    );

    loadTemplates('mid123', dir); // triggers migration + rewrite
    const reloaded = loadTemplates('mid123', dir);
    expect(reloaded.templates[0].pattern).toBe('pay (?<original_currency>\\w+) (?<original_amount>[\\d.]+)');
  });

  it('preserves other named groups during migration', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'complex',
            pattern: 'spent (?<currency>\\w+) (?<amount>[\\d.]+) at (?<merchant>.+)',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+) at (?<merchant>.+)',
    );
  });

  it('does not migrate patterns that already use new group names', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [
          {
            name: 'new-tmpl',
            pattern: 'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+)',
          },
        ],
      }),
    );

    const result = loadTemplates('mid123', dir);
    expect(result.templates[0].pattern).toBe(
      'spent (?<original_currency>\\w+) (?<original_amount>[\\d.]+)',
    );
  });
});

describe('loadTemplates currency_aliases', () => {
  it('returns empty object when key absent', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    expect(loadTemplates('mid123', dir).currency_aliases).toEqual({});
  });

  it('returns aliases stored in file', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({ templates: [], currency_aliases: { 'บาท': 'THB' } }),
    );
    expect(loadTemplates('mid123', dir).currency_aliases).toEqual({ 'บาท': 'THB' });
  });
});

describe('upsertAlias', () => {
  it('creates alias and persists to file', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });

  it('replaces existing alias with same key', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บาท', 'BAHT', dir);
    expect(listAliases('mid123', dir)['บาท']).toBe('BAHT');
  });

  it('does not erase existing templates', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertAlias('mid123', 'บาท', 'THB', dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });
});

describe('deleteAlias', () => {
  it('returns false when alias not found', () => {
    expect(deleteAlias('mid123', 'บาท', dir)).toBe(false);
  });

  it('removes alias and returns true', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บ', 'THB', dir);
    expect(deleteAlias('mid123', 'บาท', dir)).toBe(true);
    expect(listAliases('mid123', dir)).toEqual({ 'บ': 'THB' });
  });

  it('does not erase existing templates', () => {
    upsertTemplate('mid123', TMPL_A, dir);
    upsertAlias('mid123', 'บาท', 'THB', dir);
    deleteAlias('mid123', 'บาท', dir);
    expect(loadTemplates('mid123', dir).templates).toEqual([TMPL_A]);
  });
});

describe('listAliases', () => {
  it('returns empty object when no aliases saved', () => {
    expect(listAliases('mid123', dir)).toEqual({});
  });

  it('returns all aliases', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertAlias('mid123', 'บ', 'THB', dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB', 'บ': 'THB' });
  });
});

describe('upsertTemplate preserves aliases', () => {
  it('does not erase aliases when templates are updated', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertTemplate('mid123', TMPL_A, dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });
});

describe('deleteTemplate preserves aliases', () => {
  it('does not erase aliases when a template is removed', () => {
    upsertAlias('mid123', 'บาท', 'THB', dir);
    upsertTemplate('mid123', TMPL_A, dir);
    deleteTemplate('mid123', TMPL_A.name, dir);
    expect(listAliases('mid123', dir)).toEqual({ 'บาท': 'THB' });
  });
});

describe('migration preserves currency_aliases', () => {
  it('keeps aliases intact after pattern migration and rewrites file with them', () => {
    writeFileSync(
      join(dir, 'mid123.json'),
      JSON.stringify({
        templates: [{ name: 'old', pattern: 'pay (?<currency>\\w+) (?<amount>[\\d.]+)' }],
        currency_aliases: { 'บาท': 'THB' },
      }),
    );
    const result = loadTemplates('mid123', dir);
    expect(result.currency_aliases).toEqual({ 'บาท': 'THB' });
    const file = JSON.parse(readFileSync(join(dir, 'mid123.json'), 'utf8'));
    expect(file.currency_aliases).toEqual({ 'บาท': 'THB' });
  });
});
