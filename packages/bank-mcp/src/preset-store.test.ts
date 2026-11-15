import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAllPresets, getPreset, detectPresets, Preset } from './preset-store';
import { RegexExecutor } from './regex-executor';

const FAKE_PRESET: Preset = {
  description: 'Test Bank notifications',
  templates: [
    { name: 'test-debit', pattern: 'TESTBANK debit (?<original_amount>[\\d.]+) (?<original_currency>THB)', amount_sign: 'debit' },
  ],
  currency_aliases: { 'THB': 'THB' },
};

const OTHER_PRESET: Preset = {
  description: 'Other Bank',
  templates: [
    { name: 'other-credit', pattern: 'OTHERBANK credit (?<original_amount>[\\d.]+) (?<original_currency>USD)', amount_sign: 'credit' },
  ],
  currency_aliases: {},
};

let dir: string;
let regex: RegexExecutor;
beforeAll(() => { regex = new RegexExecutor(); });
afterAll(async () => { await regex.close(); });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'line-presets-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadAllPresets', () => {
  it('returns empty object when directory has no json files', () => {
    expect(loadAllPresets(dir)).toEqual({});
  });

  it('loads a single preset keyed by filename stem', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    const result = loadAllPresets(dir);
    expect(result['testbank']).toBeDefined();
    expect(result['testbank'].description).toBe('Test Bank notifications');
    expect(result['testbank'].templates).toHaveLength(1);
  });

  it('loads multiple presets', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    writeFileSync(join(dir, 'other.json'), JSON.stringify(OTHER_PRESET));
    const result = loadAllPresets(dir);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['testbank']).toBeDefined();
    expect(result['other']).toBeDefined();
  });

  it('ignores non-json files', () => {
    writeFileSync(join(dir, 'readme.txt'), 'ignore me');
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    expect(Object.keys(loadAllPresets(dir))).toHaveLength(1);
  });

  it('skips files that fail to parse', () => {
    writeFileSync(join(dir, 'broken.json'), 'not valid json {{{');
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    expect(Object.keys(loadAllPresets(dir))).toHaveLength(1);
  });
});

describe('getPreset', () => {
  it('returns the preset for a known name', () => {
    writeFileSync(join(dir, 'testbank.json'), JSON.stringify(FAKE_PRESET));
    const p = getPreset('testbank', dir);
    expect(p).not.toBeNull();
    expect(p!.description).toBe('Test Bank notifications');
  });

  it('returns null for an unknown name', () => {
    expect(getPreset('nonexistent', dir)).toBeNull();
  });
});

describe('detectPresets', () => {
  const presets: Record<string, Preset> = {
    testbank: FAKE_PRESET,
    other: OTHER_PRESET,
  };

  it('suggests a preset when a message matches preset but no saved template', async () => {
    const messages = [{ text: 'TESTBANK debit 100.00 THB' }];
    const result = await detectPresets(regex, messages, [], presets);
    expect(result).toHaveLength(1);
    expect(result[0].preset_name).toBe('testbank');
    expect(result[0].matched_count).toBe(1);
    expect(result[0].description).toBe('Test Bank notifications');
  });

  it('does not suggest preset when message already matched by saved template', async () => {
    const messages = [{ text: 'TESTBANK debit 100.00 THB' }];
    const savedTemplates = [{ pattern: 'TESTBANK debit (?<original_amount>[\\d.]+) (?<original_currency>THB)' }];
    const result = await detectPresets(regex, messages, savedTemplates, presets);
    expect(result).toHaveLength(0);
  });

  it('counts multiple unmatched messages', async () => {
    const messages = [
      { text: 'TESTBANK debit 50.00 THB' },
      { text: 'TESTBANK debit 200.00 THB' },
      { text: 'Some promo message' },
    ];
    const result = await detectPresets(regex, messages, [], presets);
    expect(result).toHaveLength(1);
    expect(result[0].matched_count).toBe(2);
  });

  it('suggests multiple presets when different messages match different presets', async () => {
    const messages = [
      { text: 'TESTBANK debit 50.00 THB' },
      { text: 'OTHERBANK credit 99.00 USD' },
    ];
    const result = await detectPresets(regex, messages, [], presets);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.preset_name).sort();
    expect(names).toEqual(['other', 'testbank']);
  });

  it('does not suggest preset when message has no text', async () => {
    const messages = [{ text: undefined }];
    const result = await detectPresets(regex, messages, [], presets);
    expect(result).toHaveLength(0);
  });

  it('rejects an invalid preset pattern with code "invalid"', async () => {
    const badPresets: Record<string, Preset> = {
      bad: {
        description: 'Bad preset',
        templates: [{ name: 'bad', pattern: '(?<original_amount>[[[)', amount_sign: 'debit' }],
        currency_aliases: {},
      },
    };
    const messages = [{ text: 'anything' }];
    await expect(detectPresets(regex, messages, [], badPresets))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('times out on a catastrophic-backtracking saved template', async () => {
    const timeoutRegex = new RegexExecutor({ timeoutMs: 10 });
    try {
      await expect(detectPresets(
        timeoutRegex,
        [{ text: `${'a'.repeat(40)}!` }],
        [{ name: 'saved-bad', pattern: '(a|aa)+$' }],
        presets,
      )).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await timeoutRegex.close();
    }
  });

  it('times out on a catastrophic-backtracking built-in preset template', async () => {
    const timeoutRegex = new RegexExecutor({ timeoutMs: 10 });
    const badPresets: Record<string, Preset> = {
      'preset-bad': {
        description: 'Bad preset',
        templates: [{ name: 'preset-bad', pattern: '(a|aa)+$', amount_sign: 'debit' }],
        currency_aliases: {},
      },
    };
    try {
      await expect(detectPresets(
        timeoutRegex,
        [{ text: `${'a'.repeat(40)}!` }],
        [],
        badPresets,
      )).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await timeoutRegex.close();
    }
  });
});
