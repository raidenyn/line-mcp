import { describe, it, expect } from 'vitest';
import { parseTransaction, summarize, expandUntilBound, TransactionTemplate, applyBalanceDiffs, Transaction } from './transaction-parser';

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
  it('parses a UOB debit message', () => {
    const tx = parseTransaction(UOB_DEBIT_MSG, UOB_TEMPLATES);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-241.5);
    expect(tx!.original_currency).toBe('THB');
    expect(tx!.merchant).toBe('@7-11CHAREONKUNG109YAEK1');
    expect(tx!.account).toBe('UOB-7268');
    expect(tx!.balance).toBe(979546.0);
    expect(tx!.id).toBe('m1');
  });

  it('captures currency and amount from optional groups', () => {
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
    const tx = parseTransaction(msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.original_amount).toBe(-50);
    expect(tx!.original_currency).toBe('USD');
    expect(tx!.currency).toBe('THB');
    expect(tx!.amount).toBe(-1750);
    expect(tx!.balance).toBe(50000);
  });

  it('returns null for a promotional message', () => {
    expect(parseTransaction(PROMO_MSG, UOB_TEMPLATES)).toBeNull();
  });

  it('returns null for a non-text message', () => {
    expect(parseTransaction(IMAGE_MSG, UOB_TEMPLATES)).toBeNull();
  });

  it('returns null when pattern is missing required original_amount group', () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns null when pattern is missing required original_currency group', () => {
    const badTemplates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d.]+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns null for an invalid regex pattern', () => {
    const badTemplates: TransactionTemplate[] = [{ pattern: '([invalid' }];
    expect(parseTransaction(UOB_DEBIT_MSG, badTemplates)).toBeNull();
  });

  it('returns result (not throw) for DD/MM format with non-numeric date capture', () => {
    const msg = { ...UOB_DEBIT_MSG, text: 'spent 100 THB on ab/cd' };
    const templates: TransactionTemplate[] = [
      { pattern: 'spent (?<original_amount>[\\d]+) (?<original_currency>\\w+) on (?<date>.+)', date_format: 'DD/MM' },
    ];
    expect(() => parseTransaction(msg, templates)).not.toThrow();
    const tx = parseTransaction(msg, templates);
    expect(tx).not.toBeNull();
    expect(tx!.date).toBe(new Date(parseInt(UOB_DEBIT_MSG.createdTime, 10)).toISOString());
  });

  it('returns null for a pattern with nested quantifiers (ReDoS guard)', () => {
    const dangerous: TransactionTemplate[] = [
      { pattern: '(\\w+\\s*)+(end)?(?<original_amount>\\d+) (?<original_currency>\\w+)', amount_sign: 'debit' },
    ];
    expect(parseTransaction(UOB_DEBIT_MSG, dangerous)).toBeNull();
  });

  it('tries subsequent templates when first does not match', () => {
    const templates: TransactionTemplate[] = [
      { pattern: 'NOMATCH (?<original_amount>[\\d]+) (?<original_currency>\\w+)', amount_sign: 'debit' },
      ...UOB_TEMPLATES,
    ];
    const tx = parseTransaction(UOB_DEBIT_MSG, templates);
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
});

describe('applyBalanceDiffs', () => {
  it('leaves first transaction amount undefined when no prior balance', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[1].amount).toBe(-200);
  });

  it('does not overwrite an explicit amount', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -50, original_currency: 'USD', amount: -1750, balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -100, original_currency: 'USD', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBe(-1750);
    expect(txs[1].amount).toBe(-200);
  });

  it('skips diff when current tx has no balance; uses last known balance for later txs', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -50, original_currency: 'THB', rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[1].amount).toBeUndefined();
    expect(txs[2].amount).toBe(-200);
  });

  it('groups by account to avoid cross-account balance diffs', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', account: 'acc-A', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', account: 'acc-B', balance: 5000, rawText: '' },
      { id: 'm3', date: '2026-06-03T00:00:00.000Z', original_amount: -300, original_currency: 'THB', account: 'acc-A', balance: 9700, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[0].amount).toBeUndefined();
    expect(txs[1].amount).toBeUndefined();
    expect(txs[2].amount).toBe(-300);
  });

  it('groups transactions with no account together (empty-string key)', () => {
    const txs: Transaction[] = [
      { id: 'm1', date: '2026-06-01T00:00:00.000Z', original_amount: -100, original_currency: 'THB', balance: 10000, rawText: '' },
      { id: 'm2', date: '2026-06-02T00:00:00.000Z', original_amount: -200, original_currency: 'THB', balance: 9800, rawText: '' },
    ];
    applyBalanceDiffs(txs);
    expect(txs[1].amount).toBe(-200);
  });
});
