import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseTransaction, summarize, expandUntilBound, TransactionTemplate, applyBalanceDiffs, categorize, Transaction, Category, filterTransactions, validateFilters, TransactionFilter } from './transaction-parser';
import { RegexExecutor } from './regex-executor';

let regex: RegexExecutor;
beforeAll(() => { regex = new RegexExecutor(); });
afterAll(async () => { await regex.close(); });

const UOB_DEBIT_MSG = {
  id: 'm1',
  createdTime: '1749999600000', // 2025-06-15T11:00:00.000Z
  contentType: 0,
  text: 'มีการใช้บัตร UOB-7268 @7-11CHAREONKUNG109YAEK1 241.5 THB วันที่ 15/06 วงเงินคงเหลือใช้ได้ 979,546.00 THB\n\nYou have spent THB 241.5 using UOB card (ending UOB-7268) at @7-11CHAREONKUNG109YAEK1 on 15/06. Available credit: THB 979,546.00',
};

const UOB_TEMPLATES: TransactionTemplate[] = [
  {
    pattern:
      'You have spent (?<original_currency>\\w+) (?<original_amount>[\\d,]+\\.?\\d*) using UOB card \\(ending (?<account>[^)]+)\\) at (?<merchant>.+?) on (?<date>\\d{2}/\\d{2})\\. Available credit: THB (?<balance>[\\d,]+\\.?\\d*)',
    amount_sign: 'debit',
    date_format: 'DD/MM',
  },
];

const PROMO_MSG = {
  id: 'm2',
  createdTime: '1749999600000',
  contentType: 0,
  text: 'UOB Special! Get 10% cashback on all dining this weekend. T&Cs apply.',
};

const IMAGE_MSG = {
  id: 'm3',
  createdTime: '1749999600000',
  contentType: 1,
  text: undefined,
};

describe('parseTransaction', () => {
  it('parses a UOB debit message', async () => {
    const tx = await parseTransaction(regex, UOB_DEBIT_MSG, UOB_TEMPLATES);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-241.5);
    expect(tx!.original_currency).toBe('THB');
    expect(tx!.merchant).toBe('@7-11CHAREONKUNG109YAEK1');
    expect(tx!.account).toBe('UOB-7268');
    expect(tx!.balance).toBe(979546.0);
    expect(tx!.id).toBe('m1');
  });

  it('captures currency and amount from optional groups', async () => {
    const msg = {
      id: 'fx1',
      createdTime: '1749999600000',
      contentType: 0,
      text: 'FX spend USD 50 (THB 1750) at Starbucks. Balance: THB 50000',
    };
    const templates: TransactionTemplate[] = [
      {
        pattern:
          'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>\\w+) (?<amount>[\\d.]+)\\) at (?<merchant>.+?)\\. Balance: \\w+ (?<balance>[\\d.]+)',
        amount_sign: 'debit',
      },
    ];
    const tx = await parseTransaction(regex, msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-50);
    expect(tx!.original_currency).toBe('USD');
    expect(tx!.currency).toBe('THB');
    expect(tx!.amount).toBe(-1750);
    expect(tx!.balance).toBe(50000);
  });

  it('returns null for a promotional message', async () => {
    await expect(parseTransaction(regex, PROMO_MSG, UOB_TEMPLATES)).resolves.toBeNull();
  });

  it('returns null for a non-text message', async () => {
    await expect(parseTransaction(regex, IMAGE_MSG, UOB_TEMPLATES)).resolves.toBeNull();
  });

  it('returns null when pattern is missing required original_amount group', async () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    await expect(parseTransaction(regex, UOB_DEBIT_MSG, badTemplates)).resolves.toBeNull();
  });

  it('returns null when pattern is missing required original_currency group', async () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d.]+)', amount_sign: 'debit' },
    ];
    await expect(parseTransaction(regex, UOB_DEBIT_MSG, badTemplates)).resolves.toBeNull();
  });

  it('rejects an invalid regex pattern with code "invalid"', async () => {
    const badTemplates: TransactionTemplate[] = [{ pattern: '([invalid' }];
    await expect(parseTransaction(regex, UOB_DEBIT_MSG, badTemplates))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('returns result (not throw) for DD/MM format with non-numeric date capture', async () => {
    const msg = { ...UOB_DEBIT_MSG, text: 'spent 100 THB on ab/cd' };
    const templates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d]+) (?<original_currency>\\w+) on (?<date>.+)', date_format: 'DD/MM' },
    ];
    await expect(parseTransaction(regex, msg, templates)).resolves.not.toThrow();
    const tx = await parseTransaction(regex, msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.date).toBe(new Date(parseInt(UOB_DEBIT_MSG.createdTime, 10)).toISOString());
  });

  it('runs native-JS regex features (lookahead + backreferences) through the worker', async () => {
    const templates: TransactionTemplate[] = [
      { pattern: 'spend (?=\\d)(?<original_amount>\\d+) (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    const msg = { ...UOB_DEBIT_MSG, text: 'spend 241 THB' };
    const tx = await parseTransaction(regex, msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-241);
    expect(tx!.original_currency).toBe('THB');
  });

  it('tries subsequent templates when first does not match', async () => {
    const templates: TransactionTemplate[] = [
      { pattern: 'NOMATCH (?<original_amount>[\\d]+) (?<original_currency>\\w+)', amount_sign: 'debit' },
      ...UOB_TEMPLATES,
    ];
    const tx = await parseTransaction(regex, UOB_DEBIT_MSG, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('THB');
  });
});

describe('summarize', () => {
  const txs = [
    {
      id: 'm1', date: '2026-06-01T00:00:00.000Z',
      original_amount: -100, original_currency: 'THB', merchant: '7-Eleven', rawText: '',
    },
    {
      id: 'm2', date: '2026-06-15T00:00:00.000Z',
      original_amount: -200, original_currency: 'THB', merchant: 'Grab', rawText: '',
    },
    {
      id: 'm3', date: '2026-06-20T00:00:00.000Z',
      original_amount: 50, original_currency: 'THB', merchant: '7-Eleven', rawText: '',
    },
    {
      id: 'm4', date: '2026-07-01T00:00:00.000Z',
      original_amount: -300, original_currency: 'THB', merchant: 'Grab', rawText: '',
    },
  ];

  it('groups by month', () => {
    const result = summarize(txs, 'month');
    expect(result.transactions_count).toBe(4);
    expect(result.by_group['2026-06'].debit).toBe(300);
    expect(result.by_group['2026-06'].credit).toBe(50);
    expect(result.by_group['2026-07'].debit).toBe(300);
    expect(result.currency).toBe('THB');
    expect(result.unknown_currency).toEqual({
      total_debit: 0,
      total_credit: 0,
      net: 0,
      transactions_count: 0,
    });
    expect(result.unknown_by_group).toEqual({});
  });

  it('groups by merchant', () => {
    const result = summarize(txs, 'merchant');
    expect(result.by_group['7-Eleven'].debit).toBe(100);
    expect(result.by_group['7-Eleven'].credit).toBe(50);
    expect(result.by_group['Grab'].debit).toBe(500);
  });

  it('filters by since/until', () => {
    const result = summarize(txs, 'month', '2026-06-10T00:00:00.000Z', '2026-06-30T00:00:00.000Z');
    expect(result.transactions_count).toBe(2);
    expect(Object.keys(result.by_group)).toEqual(['2026-06']);
  });

  it('reports mixed currency when transactions span multiple currencies', () => {
    const mixed = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -10, original_currency: 'USD', rawText: '' },
    ];
    const result = summarize(mixed, 'month');
    expect(result.currency).toBe('mixed');
  });

  it('computes correct net', () => {
    const result = summarize(txs, 'month');
    expect(result.total_debit).toBe(600);
    expect(result.total_credit).toBe(50);
    expect(result.net).toBe(-550);
  });

  it('returns currency "none" when no transactions match the filter', () => {
    const result = summarize(txs, 'month', '2030-01-01T00:00:00.000Z', '2030-12-31T23:59:59.999Z');
    expect(result.transactions_count).toBe(0);
    expect(result.currency).toBe('none');
  });

  it('expandUntilBound handles YYYY-MM by expanding to end of month', () => {
    expect(expandUntilBound('2026-06')).toBe('2026-06-31T23:59:59.999Z');
    expect(expandUntilBound('2026-06-15')).toBe('2026-06-15T23:59:59.999Z');
    expect(expandUntilBound('2026-06-15T12:00:00.000Z')).toBe('2026-06-15T12:00:00.000Z');
  });

  it('filters correctly when until is a YYYY-MM string', () => {
    const result = summarize(txs, 'month', undefined, '2026-06');
    expect(result.transactions_count).toBe(3);
    expect(Object.keys(result.by_group)).toEqual(['2026-06']);
  });

  it('uses amount and currency fields when present', () => {
    const fxTxs = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', amount: -3500, currency: 'THB', rawText: '' },
    ];
    const result = summarize(fxTxs, 'month');
    expect(result.total_debit).toBe(5250);
    expect(result.currency).toBe('THB');
  });

  it('falls back to original_amount when amount is absent', () => {
    const domTxs = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', rawText: '' },
    ];
    const result = summarize(domTxs, 'month');
    expect(result.total_debit).toBe(100);
    expect(result.currency).toBe('THB');
  });

  it('reports mixed when amount-present and amount-absent transactions have different effective currencies', () => {
    const mixed = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, currency: 'THB', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', rawText: '' },
    ];
    const result = summarize(mixed, 'month');
    expect(result.currency).toBe('mixed');
  });

  it('groups by category', () => {
    const categorized = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', category: 'Food', rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', category: 'Transport', rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'THB', rawText: '' },
    ];
    const result = summarize(categorized, 'category');
    expect(result.by_group['Food'].debit).toBe(100);
    expect(result.by_group['Transport'].debit).toBe(200);
    expect(result.by_group['uncategorized'].debit).toBe(50);
  });

  it('separates an unlabelled amount even when it equals original_amount', () => {
    const result = summarize([
      {
        id: 'm1',
        date: '2026-06-01T00:00:00.000Z',
        original_amount: -100,
        original_currency: 'THB',
        amount: -100,
        rawText: '',
      },
    ], 'month');

    expect(result.total_debit).toBe(0);
    expect(result.by_group).toEqual({});
    expect(result.currency).toBe('none');
    expect(result.transactions_count).toBe(1);
    expect(result.unknown_currency).toEqual({
      total_debit: 100,
      total_credit: 0,
      net: -100,
      transactions_count: 1,
    });
    expect(result.unknown_by_group).toEqual({
      '2026-06': { debit: 100, credit: 0, count: 1 },
    });
  });

  it('keeps unlabelled converted amounts out of original-currency totals', () => {
    const result = summarize([
      {
        id: 'm1',
        date: '2026-06-01T00:00:00.000Z',
        original_amount: -50,
        original_currency: 'USD',
        amount: -1750,
        merchant: 'Store',
        rawText: '',
      },
    ], 'merchant');

    expect(result.total_debit).toBe(0);
    expect(result.currency).toBe('none');
    expect(result.unknown_currency.total_debit).toBe(1750);
    expect(result.unknown_currency.net).toBe(-1750);
    expect(result.unknown_by_group).toEqual({
      Store: { debit: 1750, credit: 0, count: 1 },
    });
  });

  it('aggregates known and unknown amounts independently within groups', () => {
    const result = summarize([
      {
        id: 'm1', date: '2026-06-01T00:00:00.000Z',
        original_amount: -100, original_currency: 'THB', rawText: '',
      },
      {
        id: 'm2', date: '2026-06-02T00:00:00.000Z',
        original_amount: -50, original_currency: 'USD',
        amount: -1750, rawText: '',
      },
      {
        id: 'm3', date: '2026-06-03T00:00:00.000Z',
        original_amount: 20, original_currency: 'THB',
        amount: 700, rawText: '',
      },
    ], 'month');

    expect(result).toMatchObject({
      total_debit: 100,
      total_credit: 0,
      net: -100,
      by_group: {
        '2026-06': { debit: 100, credit: 0, count: 1 },
      },
      currency: 'THB',
      transactions_count: 3,
      unknown_currency: {
        total_debit: 1750,
        total_credit: 700,
        net: -1050,
        transactions_count: 2,
      },
      unknown_by_group: {
        '2026-06': { debit: 1750, credit: 700, count: 2 },
      },
    });
  });

  it.each([
    ['month', '2026-06'],
    ['merchant', 'Cafe'],
    ['category', 'Food'],
  ] as const)('routes unknown amounts through %s grouping after date filtering', (groupBy, key) => {
    const result = summarize([
      {
        id: 'old', date: '2026-05-01T00:00:00.000Z',
        original_amount: -1, original_currency: 'USD', amount: -35,
        merchant: 'Cafe', category: 'Food', rawText: '',
      },
      {
        id: 'included', date: '2026-06-01T00:00:00.000Z',
        original_amount: -2, original_currency: 'USD', amount: -70,
        merchant: 'Cafe', category: 'Food', rawText: '',
      },
    ], groupBy, '2026-06-01', '2026-06-30');

    expect(result.transactions_count).toBe(1);
    expect(result.unknown_by_group).toEqual({
      [key]: { debit: 70, credit: 0, count: 1 },
    });
  });

  it('uses original pair when amount is absent even if currency is orphaned', () => {
    const result = summarize([
      {
        id: 'm1', date: '2026-06-01T00:00:00.000Z',
        original_amount: -100, original_currency: 'THB',
        currency: 'USD', rawText: '',
      },
    ], 'month');

    expect(result.total_debit).toBe(100);
    expect(result.currency).toBe('THB');
    expect(result.unknown_currency.transactions_count).toBe(0);
    expect(result.unknown_by_group).toEqual({});
  });
});

describe('applyBalanceDiffs', () => {
  it('uses original_amount directly for same-currency transactions (no diff needed, including the first transaction in a group)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-100);
    expect(txs[0].currency).toBe('THB');
    expect(txs[0].amount_estimated).toBeUndefined();
    expect(txs[1].amount).toBe(-200);
    expect(txs[1].currency).toBe('THB');
  });

  it('does not overwrite an explicit amount', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 9800, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-1750);
    expect(txs[1].amount).toBe(-100); // same-currency passthrough (both USD), not a diff
    expect(txs[1].currency).toBe('USD');
  });

  it('leaves amount undefined when cross-currency, no prior balance, and rate lookup fails', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 9700, rawText: '' },
    ];
    const failingFetcher = async () => null;
    await applyBalanceDiffs(txs, failingFetcher);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[0].amount_estimated).toBeUndefined();
  });

  it('uses last known balance across a gap when computing the FX diagnostic diff', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', rawText: '' }, // no balance captured
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8250, rawText: '' },
    ];
    const stubFetcher = async () => 33; // 1 USD = 33 THB
    await applyBalanceDiffs(txs, stubFetcher);
    // API-derived amount: -50 * 33 = -1650. Diff uses last known balance (10000, from tx1,
    // since tx2 has none): 8250 - 10000 = -1750. |1750-1650|/1650 ≈ 6% — within tolerance.
    expect(txs[2].amount).toBe(-1650);
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined();
  });

  it('groups by account to avoid cross-account balance diffs', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', account: 'acc-A', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'USD', account: 'acc-B', balance: 5000, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -20, original_currency: 'THB', account: 'acc-A', balance: 9700, rawText: '' },
      { id: 'm4', date: '2026-06-04T00:00:00.000Z', original_amount: -50, original_currency: 'USD', account: 'acc-A', balance: 8050, rawText: '' },
    ];
    const stubFetcher = async () => 33;
    await applyBalanceDiffs(txs, stubFetcher);
    // acc-A's diff for m4 must use acc-A's own prevBalance (9700), not acc-B's (5000):
    // 8050 - 9700 = -1650, matching the API amount (-50 * 33 = -1650) exactly — no gap flag.
    expect(txs[3].amount).toBe(-1650);
    expect(txs[3].amount_estimated).toBe(true);
    expect(txs[3].amount_gap_suspected).toBeUndefined();
  });

  it('computes FX amount via the rate fetcher for a foreign spend on a domestic-currency account', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8150, rawText: '' },
    ];
    const stubFetcher = async (date: string, from: string, to: string) => {
      expect(date).toBe('2026-06-03');
      expect(from).toBe('USD');
      expect(to).toBe('THB');
      return 33;
    };
    await applyBalanceDiffs(txs, stubFetcher);
    expect(txs[1].currency).toBe('THB');
    expect(txs[2].currency).toBe('THB');
    expect(txs[2].amount).toBe(-1650); // -50 * 33
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined(); // diff (9800-8150=1650) matches exactly
  });

  it('does not stamp currency when currencies tie (truly mixed account)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'EUR', balance: 9900, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[1].currency).toBeUndefined();
    expect(txs[1].amount).toBeUndefined();
  });

  it('does not stamp currency on transactions with an explicit amount', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 8250, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 8050, rawText: '' },
    ];
    await applyBalanceDiffs(txs);
    expect(txs[1].currency).toBeUndefined(); // explicit amount — not touched
    expect(txs[2].currency).toBe('THB'); // same-currency passthrough
  });

  it('flags amount_gap_suspected when the balance diff disagrees with the FX-converted amount by more than 15% (mirrors the real UOB bug)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 960114, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 960014, rawText: '' },
      { id: 'm3', date: '2026-06-23T00:00:00.000Z', original_amount: -21.4, original_currency: 'USD', balance: 958014, rawText: '' },
    ];
    const stubFetcher = async () => 33; // published rate for the date
    await applyBalanceDiffs(txs, stubFetcher);
    // API-derived amount: -21.4 * 33 = -706.20 — trustworthy, independent of the balance sequence.
    expect(txs[2].amount).toBeCloseTo(-706.2, 2);
    expect(txs[2].amount_estimated).toBe(true);
    // Observed diff (960014 - 958014 = 2000) is wildly off from 706.20 — an untracked balance
    // change happened between these readings, exactly like the real bug report's evidence.
    expect(txs[2].amount_gap_suspected).toBe(true);
  });

  it('falls back to diff-based amount when the rate fetcher returns null (API unavailable)', async () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'THB', balance: 9950, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -50, original_currency: 'USD', balance: 8450, rawText: '' },
    ];
    const failingFetcher = async () => null;
    await applyBalanceDiffs(txs, failingFetcher);
    expect(txs[2].amount).toBe(-1500); // 8450 - 9950, diff fallback
    expect(txs[2].currency).toBe('THB');
    expect(txs[2].amount_estimated).toBe(true);
    expect(txs[2].amount_gap_suspected).toBeUndefined(); // no rate to compare against, no gap-check performed
  });
});

describe('categorize', () => {
  function tx(overrides: Partial<Transaction>): Transaction {
    return {
      id: 'm1',
      date: '2026-06-01T00:00:00.000Z',
      original_amount: -100,
      original_currency: 'THB',
      rawText: 'Spent at Starbucks',
      ...overrides,
    };
  }

  it('matches against the merchant field', async () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ merchant: 'Starbucks Siam' })];
    await categorize(regex, txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });

  it('falls back to rawText when merchant is absent', async () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ rawText: 'You spent THB 120 at Starbucks Siam' })];
    expect(txs[0].merchant).toBeUndefined();
    await categorize(regex, txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });

  it('picks the first matching category in list order', async () => {
    const categories: Category[] = [
      { name: 'Food', pattern: 'starbucks' },
      { name: 'Coffee', pattern: 'starbucks' },
    ];
    const txs = [tx({ merchant: 'Starbucks Siam' })];
    await categorize(regex, txs, categories);
    expect(txs[0].category).toBe('Food');
  });

  it('sets uncategorized when no category matches', async () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'starbucks' }];
    const txs = [tx({ merchant: 'Grab' })];
    await categorize(regex, txs, categories);
    expect(txs[0].category).toBe('uncategorized');
  });

  it('sets uncategorized when no categories are configured', async () => {
    const txs = [tx({ merchant: 'Grab' })];
    await categorize(regex, txs, []);
    expect(txs[0].category).toBe('uncategorized');
  });

  it('matches case-insensitively', async () => {
    const categories: Category[] = [{ name: 'Coffee', pattern: 'STARBUCKS' }];
    const txs = [tx({ merchant: 'starbucks siam' })];
    await categorize(regex, txs, categories);
    expect(txs[0].category).toBe('Coffee');
  });
});

describe('validateFilters', () => {
  it('returns null when merchants is absent', async () => {
    const filters: TransactionFilter = {};
    await expect(validateFilters(regex, filters)).resolves.toBeNull();
  });

  it('returns null when all merchant patterns compile', async () => {
    await expect(validateFilters(regex, { merchants: ['starbucks', 'grab.*'] })).resolves.toBeNull();
  });

  it('returns an error naming the bad pattern', async () => {
    await expect(validateFilters(regex, { merchants: ['starbucks', '(unclosed'] })).resolves.toContain('(unclosed');
  });
});

describe('filterTransactions', () => {
  function tx(overrides: Partial<Transaction>): Transaction {
    return {
      id: 'm1',
      date: '2026-06-01T00:00:00.000Z',
      original_amount: -100,
      original_currency: 'THB',
      rawText: 'Spent at Starbucks',
      ...overrides,
    };
  }

  it('returns all transactions when no filters are given', async () => {
    const txs = [tx({}), tx({ id: 'm2' })];
    expect(await filterTransactions(regex, txs, {})).toHaveLength(2);
  });

  it('filters by a single category', async () => {
    const txs = [tx({ category: 'Coffee' }), tx({ id: 'm2', category: 'Transport' })];
    const result = await filterTransactions(regex, txs, { categories: ['Coffee'] });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('Coffee');
  });

  it('ORs multiple categories', async () => {
    const txs = [
      tx({ id: 'm1', category: 'Coffee' }),
      tx({ id: 'm2', category: 'Transport' }),
      tx({ id: 'm3', category: 'Dining' }),
    ];
    const result = await filterTransactions(regex, txs, { categories: ['Coffee', 'Dining'] });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm3']);
  });

  it('matches the literal "uncategorized" category', async () => {
    const txs = [tx({ category: 'uncategorized' }), tx({ id: 'm2', category: 'Coffee' })];
    const result = await filterTransactions(regex, txs, { categories: ['uncategorized'] });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('uncategorized');
  });

  it('category match is case-sensitive', async () => {
    const txs = [tx({ category: 'Coffee' })];
    expect(await filterTransactions(regex, txs, { categories: ['coffee'] })).toHaveLength(0);
  });

  it('filters by original_currencies case-insensitively', async () => {
    const txs = [
      tx({ id: 'm1', original_currency: 'USD' }),
      tx({ id: 'm2', original_currency: 'THB' }),
    ];
    const result = await filterTransactions(regex, txs, { original_currencies: ['usd'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('filters by merchant regex against the merchant field', async () => {
    const txs = [
      tx({ id: 'm1', merchant: 'Starbucks Siam' }),
      tx({ id: 'm2', merchant: 'Grab' }),
    ];
    const result = await filterTransactions(regex, txs, { merchants: ['starbucks'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('merchant filter falls back to rawText when merchant is absent', async () => {
    const txs = [tx({ rawText: 'You spent THB 120 at Starbucks Siam' })];
    expect(txs[0].merchant).toBeUndefined();
    const result = await filterTransactions(regex, txs, { merchants: ['starbucks'] });
    expect(result).toHaveLength(1);
  });

  it('ORs multiple merchant patterns', async () => {
    const txs = [
      tx({ id: 'm1', merchant: 'Starbucks Siam' }),
      tx({ id: 'm2', merchant: 'Grab' }),
      tx({ id: 'm3', merchant: 'Netflix' }),
    ];
    const result = await filterTransactions(regex, txs, { merchants: ['starbucks', 'grab'] });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm2']);
  });

  it('filters by amount range using absolute value, matching debits and credits alike', async () => {
    const txs = [
      tx({ id: 'm1', amount: -500 }),
      tx({ id: 'm2', amount: 500 }),
      tx({ id: 'm3', amount: -50 }),
      tx({ id: 'm4', amount: 5000 }),
    ];
    const result = await filterTransactions(regex, txs, { amount_min: 100, amount_max: 1000 });
    expect(result.map((t) => t.id)).toEqual(['m1', 'm2']);
  });

  it('falls back to original_amount when amount is absent', async () => {
    const txs = [tx({ original_amount: -300, amount: undefined })];
    const result = await filterTransactions(regex, txs, { amount_min: 200, amount_max: 400 });
    expect(result).toHaveLength(1);
  });

  it('amount_min alone means "at least"', async () => {
    const txs = [tx({ id: 'm1', amount: -50 }), tx({ id: 'm2', amount: -500 })];
    const result = await filterTransactions(regex, txs, { amount_min: 100 });
    expect(result.map((t) => t.id)).toEqual(['m2']);
  });

  it('amount_max alone means "at most"', async () => {
    const txs = [tx({ id: 'm1', amount: -50 }), tx({ id: 'm2', amount: -500 })];
    const result = await filterTransactions(regex, txs, { amount_max: 100 });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('ANDs across filter types', async () => {
    const txs = [
      tx({ id: 'm1', category: 'Coffee', original_currency: 'THB', amount: -100 }),
      tx({ id: 'm2', category: 'Coffee', original_currency: 'USD', amount: -100 }),
      tx({ id: 'm3', category: 'Transport', original_currency: 'THB', amount: -100 }),
    ];
    const result = await filterTransactions(regex, txs, { categories: ['Coffee'], original_currencies: ['THB'] });
    expect(result.map((t) => t.id)).toEqual(['m1']);
  });

  it('rejects a pattern with catastrophic-backtracking risk via timeout', async () => {
    const timeoutRegex = new RegexExecutor({ timeoutMs: 10 });
    try {
      const txs = [tx({ rawText: `${'a'.repeat(40)}!` })];
      await expect(filterTransactions(timeoutRegex, txs, { merchants: ['(a|aa)+$'] }))
        .rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await timeoutRegex.close();
    }
  });
});

describe('parseTransaction currency aliases', () => {
  const SCB_MSG = {
    id: 'scb1',
    createdTime: '1749999600000',
    contentType: 0,
    text: '[รายการเงินออก 100.00 บาท จากบัญชี X-1139 วันที่ 15/06/2025 @10:00 ยอดเงินที่ใช้ได้ 1000.00 บาท]',
  };
  const SCB_TEMPLATE: TransactionTemplate[] = [{
    pattern: '\\[รายการเงินออก\\s+(?<original_amount>[\\d,]+\\.?\\d*)\\s+(?<original_currency>บาท)\\s+จากบัญชี\\s+(?<account>\\S+)\\s+วันที่\\s+(?<date>\\d{2}/\\d{2}/\\d{4})\\s+@\\d{2}:\\d{2}\\s+ยอดเงินที่ใช้ได้\\s+(?<balance>[\\d,]+\\.?\\d*)\\s+บาท\\]',
    amount_sign: 'debit',
    date_format: 'DD/MM/YYYY',
  }];

  it('normalises original_currency via aliases', async () => {
    const tx = await parseTransaction(regex, SCB_MSG, SCB_TEMPLATE, { 'บาท': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('THB');
  });

  it('passes through unrecognised currency unchanged', async () => {
    const tx = await parseTransaction(regex, SCB_MSG, SCB_TEMPLATE, { 'บ': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('บาท');
  });

  it('applies no aliases when aliases param is omitted', async () => {
    const tx = await parseTransaction(regex, SCB_MSG, SCB_TEMPLATE);
    expect(tx).not.toBeNull();
    expect(tx!.original_currency).toBe('บาท');
  });

  it('aliases empty string aliases map leaves currency unchanged', async () => {
    const tx = await parseTransaction(regex, SCB_MSG, SCB_TEMPLATE, {});
    expect(tx!.original_currency).toBe('บาท');
  });

  it('normalises currency group via aliases', async () => {
    const msg = {
      id: 'fx2',
      createdTime: '1749999600000',
      contentType: 0 as const,
      text: 'FX spend USD 50 (บาท 1750) at Starbucks',
    };
    const tmpl: TransactionTemplate[] = [{
      pattern: 'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>บาท) (?<amount>[\\d.]+)\\) at .+',
      amount_sign: 'debit',
    }];
    const tx = await parseTransaction(regex, msg, tmpl, { 'บาท': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.currency).toBe('THB');
  });

  it('passes through unrecognised currency group unchanged', async () => {
    const msg = {
      id: 'fx3',
      createdTime: '1749999600000',
      contentType: 0 as const,
      text: 'FX spend USD 50 (บาท 1750) at Starbucks',
    };
    const tmpl: TransactionTemplate[] = [{
      pattern: 'FX spend (?<original_currency>\\w+) (?<original_amount>[\\d.]+) \\((?<currency>บาท) (?<amount>[\\d.]+)\\) at .+',
      amount_sign: 'debit',
    }];
    const tx = await parseTransaction(regex, msg, tmpl, { 'บ': 'THB' });
    expect(tx).not.toBeNull();
    expect(tx!.currency).toBe('บาท');
  });
});
