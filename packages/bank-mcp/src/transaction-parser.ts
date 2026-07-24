import { z } from 'zod';
import { getHistoricalRate } from './fx-rates';
import { type RegexExecutorPort, RegexExecutionError } from './regex-executor';

export const TransactionTemplateSchema = z.object({
  pattern: z.string().describe('JS regex with named capture groups: original_amount, original_currency (required); amount, currency, merchant, date, balance, account (optional)'),
  amount_sign: z.enum(['debit', 'credit']).optional().describe('Sign to apply to original_amount when not already signed in the captured value'),
  date_format: z.string().optional().describe('Format hint for the captured date group, e.g. "DD/MM" or "DD/MM/YYYY HH:mm"'),
});
export type TransactionTemplate = z.infer<typeof TransactionTemplateSchema>;

export const CategorySchema = z.object({
  name: z.string().min(1).describe('Unique category name, e.g. "Groceries"'),
  pattern: z.string().describe(
    'JS regex tested against merchant (falls back to rawText if merchant is absent). Compiled case-insensitively.'
  ),
});
export type Category = z.infer<typeof CategorySchema>;

export const TransactionFilterSchema = z.object({
  categories: z.array(z.string()).min(1).optional().describe(
    'Match if tx.category equals any of these (exact, case-sensitive; "uncategorized" is a valid value)'
  ),
  original_currencies: z.array(z.string()).min(1).optional().describe(
    'Match if tx.original_currency equals any of these (case-insensitive)'
  ),
  merchants: z.array(z.string()).min(1).optional().describe(
    'JS regex patterns (case-insensitive, dotAll); match if any pattern tests true against merchant, falling back to rawText when merchant is absent'
  ),
  amount_min: z.number().optional().describe('Inclusive lower bound on abs(amount ?? original_amount)'),
  amount_max: z.number().optional().describe('Inclusive upper bound on abs(amount ?? original_amount)'),
});
export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  original_amount: z.number(),
  original_currency: z.string(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  amount_estimated: z.boolean().optional(),
  amount_gap_suspected: z.boolean().optional(),
  account: z.string().optional(),
  merchant: z.string().optional(),
  balance: z.number().optional(),
  category: z.string().optional(),
  rawText: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

function parseNumeric(str: string): number {
  return parseFloat(str.replace(/,/g, ''));
}

function parseDate(captured: string | undefined, format: string | undefined, fallbackMs: string): string {
  const fallback = () => {
    const ms = parseInt(fallbackMs, 10);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
  };

  if (!captured) return fallback();

  if (!format) {
    const d = new Date(captured);
    return Number.isFinite(d.getTime()) ? d.toISOString() : fallback();
  }

  if (format === 'DD/MM') {
    const parts = captured.split('/');
    if (parts.length < 2) return fallback();
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const msgMs = parseInt(fallbackMs, 10);
    if (!Number.isFinite(msgMs)) return fallback();
    const msgDate = new Date(msgMs);
    let year = msgDate.getFullYear();
    if (!Number.isFinite(day) || !Number.isFinite(month)) return fallback();
    const diff = month - (msgDate.getMonth() + 1);
    if (diff >= 6) year--;
    else if (diff < -6) year++;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
  }

  if (format === 'DD/MM/YYYY' || format === 'DD/MM/YYYY HH:mm') {
    const [datePart, timePart] = captured.split(' ');
    const dateParts = datePart.split('/');
    if (dateParts.length < 3) return fallback();
    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    const year = parseInt(dateParts[2], 10);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return fallback();
    const [hour, minute] = timePart ? timePart.split(':').map(Number) : [0, 0];
    return new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString();
  }

  const d = new Date(captured);
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback();
}

export async function parseTransaction(
  regex: RegexExecutorPort,
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
  aliases: Record<string, string> = {},
): Promise<Transaction | null> {
  if (message.contentType !== 0 || !message.text) return null;

  for (const [index, tmpl] of templates.entries()) {
    const name = 'name' in tmpl && typeof tmpl.name === 'string' ? ` "${tmpl.name}"` : ` #${index + 1}`;
    const match = await regex.exec(tmpl.pattern, 's', message.text, `transaction template${name}`);
    if (!match?.groups) continue;

    const g = match.groups;
    if (!g.original_amount || !g.original_currency) continue;

    let original_amount = parseNumeric(g.original_amount);
    if (tmpl.amount_sign && !/^[\s]*[+\-−]/.test(g.original_amount)) {
      if (tmpl.amount_sign === 'debit') original_amount = -Math.abs(original_amount);
      else if (tmpl.amount_sign === 'credit') original_amount = Math.abs(original_amount);
    }

    const rawCurrency = g.original_currency.trim();
    const tx: Transaction = {
      id: message.id,
      date: parseDate(g.date, tmpl.date_format, message.createdTime),
      original_amount,
      original_currency: aliases[rawCurrency] ?? rawCurrency,
      rawText: message.text,
    };

    if (g.currency) tx.currency = aliases[g.currency.trim()] ?? g.currency.trim();
    if (g.amount) {
      let amount = parseNumeric(g.amount);
      if (tmpl.amount_sign && !/^[\s]*[+\-−]/.test(g.amount)) {
        if (tmpl.amount_sign === 'debit') amount = -Math.abs(amount);
        else if (tmpl.amount_sign === 'credit') amount = Math.abs(amount);
      }
      tx.amount = amount;
    }
    if (g.merchant) tx.merchant = g.merchant.trim();
    if (g.account) tx.account = g.account.trim();
    if (g.balance) tx.balance = parseNumeric(g.balance);

    return tx;
  }

  return null;
}

export function expandUntilBound(until: string): string {
  if (until.length === 10) return until + 'T23:59:59.999Z';
  // YYYY-MM: expand to end of month (day 31 is lexicographically ≥ any real day)
  if (until.length === 7) return until + '-31T23:59:59.999Z';
  return until;
}

export interface SummaryOutput {
  total_debit: number;
  total_credit: number;
  net: number;
  by_group: Record<string, { debit: number; credit: number; count: number }>;
  currency: string;
  transactions_count: number;
  unknown_currency: {
    total_debit: number;
    total_credit: number;
    net: number;
    transactions_count: number;
  };
  unknown_by_group: Record<string, { debit: number; credit: number; count: number }>;
}

export function summarize(
  transactions: Transaction[],
  groupBy: 'month' | 'merchant' | 'category',
  since?: string,
  until?: string,
): SummaryOutput {
  let filtered = transactions;
  if (since) filtered = filtered.filter((tx) => tx.date >= since);
  if (until) {
    filtered = filtered.filter((tx) => tx.date <= expandUntilBound(until));
  }

  const byGroup: Record<string, { debit: number; credit: number; count: number }> = {};
  const unknownByGroup: Record<string, { debit: number; credit: number; count: number }> = {};
  let total_debit = 0;
  let total_credit = 0;
  let unknownDebit = 0;
  let unknownCredit = 0;
  let unknownCount = 0;

  for (const tx of filtered) {
    const key =
      groupBy === 'month'
        ? tx.date.slice(0, 7)
        : groupBy === 'merchant'
        ? (tx.merchant ?? 'unknown')
        : (tx.category ?? 'uncategorized');
    const hasUnknownCurrency = tx.amount !== undefined && tx.currency === undefined;
    const effectiveAmount = tx.amount !== undefined ? tx.amount : tx.original_amount;

    if (hasUnknownCurrency) {
      if (!unknownByGroup[key]) unknownByGroup[key] = { debit: 0, credit: 0, count: 0 };
      if (effectiveAmount < 0) {
        const abs = Math.abs(effectiveAmount);
        unknownByGroup[key].debit += abs;
        unknownDebit += abs;
      } else {
        unknownByGroup[key].credit += effectiveAmount;
        unknownCredit += effectiveAmount;
      }
      unknownByGroup[key].count++;
      unknownCount++;
      continue;
    }

    if (!byGroup[key]) byGroup[key] = { debit: 0, credit: 0, count: 0 };
    if (effectiveAmount < 0) {
      const abs = Math.abs(effectiveAmount);
      byGroup[key].debit += abs;
      total_debit += abs;
    } else {
      byGroup[key].credit += effectiveAmount;
      total_credit += effectiveAmount;
    }
    byGroup[key].count++;
  }

  const currencies = [
    ...new Set(
      filtered
        .filter((tx) => tx.amount === undefined || tx.currency !== undefined)
        .map((tx) => tx.amount !== undefined ? tx.currency! : tx.original_currency),
    ),
  ];
  const currency =
    currencies.length === 0 ? 'none' : currencies.length === 1 ? currencies[0] : 'mixed';

  return {
    total_debit,
    total_credit,
    net: total_credit - total_debit,
    by_group: byGroup,
    currency,
    transactions_count: filtered.length,
    unknown_currency: {
      total_debit: unknownDebit,
      total_credit: unknownCredit,
      net: unknownCredit - unknownDebit,
      transactions_count: unknownCount,
    },
    unknown_by_group: unknownByGroup,
  };
}

type RateFetcher = (date: string, from: string, to: string) => Promise<number | null>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface FxCandidate {
  tx: Transaction;
  diff: number | undefined;
  date: string;
  from: string;
  to: string;
}

export async function applyBalanceDiffs(
  transactions: Transaction[],
  rateFetcher: RateFetcher = getHistoricalRate,
): Promise<void> {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = tx.account ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  const candidates: FxCandidate[] = [];

  for (const group of groups.values()) {
    // Infer balance currency: the dominant original_currency in the group.
    // If two currencies tie, we cannot determine balance currency → leave undefined → 'mixed' in summarize.
    const counts = new Map<string, number>();
    for (const tx of group) counts.set(tx.original_currency, (counts.get(tx.original_currency) ?? 0) + 1);
    let balanceCurrency: string | undefined;
    if (counts.size === 1) {
      balanceCurrency = counts.keys().next().value as string;
    } else {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > sorted[1][1]) balanceCurrency = sorted[0][0];
    }

    let prevBalance: number | undefined;
    for (const tx of group) {
      if (tx.amount === undefined && balanceCurrency !== undefined) {
        if (tx.original_currency === balanceCurrency) {
          // Exact — no inference needed, so no untracked gap can be absorbed into it.
          tx.amount = tx.original_amount;
          tx.currency = balanceCurrency;
        } else {
          const diff =
            tx.balance !== undefined && prevBalance !== undefined ? tx.balance - prevBalance : undefined;
          candidates.push({ tx, diff, date: tx.date.slice(0, 10), from: tx.original_currency, to: balanceCurrency });
        }
      }
      if (tx.balance !== undefined) prevBalance = tx.balance;
    }
  }

  if (candidates.length === 0) return;

  const uniqueLookups = new Map<string, { date: string; from: string; to: string }>();
  for (const c of candidates) {
    const key = `${c.date}|${c.from}|${c.to}`;
    if (!uniqueLookups.has(key)) uniqueLookups.set(key, { date: c.date, from: c.from, to: c.to });
  }
  const keys = [...uniqueLookups.keys()];
  const fetched = await Promise.all(
    keys.map((k) => {
      const { date, from, to } = uniqueLookups.get(k)!;
      return rateFetcher(date, from, to);
    }),
  );
  const rates = new Map<string, number | null>();
  keys.forEach((k, i) => rates.set(k, fetched[i]));

  for (const c of candidates) {
    const rate = rates.get(`${c.date}|${c.from}|${c.to}`) ?? null;
    if (rate !== null) {
      const amount = round2(c.tx.original_amount * rate);
      c.tx.amount = amount;
      c.tx.currency = c.to;
      c.tx.amount_estimated = true;
      if (c.diff !== undefined && Math.abs(amount) > 0) {
        const deviation = Math.abs(Math.abs(c.diff) - Math.abs(amount)) / Math.abs(amount);
        if (deviation > 0.15) c.tx.amount_gap_suspected = true;
      }
    } else if (c.diff !== undefined) {
      c.tx.amount = c.diff;
      c.tx.currency = c.to;
      c.tx.amount_estimated = true;
    }
  }
}

export async function categorize(regex: RegexExecutorPort, transactions: Transaction[], categories: Category[]): Promise<void> {
  for (const tx of transactions) {
    const text = tx.merchant ?? tx.rawText;
    let matchedName: string | undefined;
    for (const cat of categories) {
      if (await regex.test(cat.pattern, 'is', text, `category "${cat.name}"`)) {
        matchedName = cat.name;
        break;
      }
    }
    tx.category = matchedName ?? 'uncategorized';
  }
}

export async function validateFilters(regex: RegexExecutorPort, filters: TransactionFilter): Promise<string | null> {
  if (!filters.merchants) return null;
  for (const pattern of filters.merchants) {
    try {
      await regex.validate(pattern, 'is', `merchant filter "${pattern}"`);
    } catch (err) {
      if (err instanceof RegexExecutionError && err.code === 'invalid') return err.message;
      throw err;
    }
  }
  return null;
}

export async function filterTransactions(regex: RegexExecutorPort, transactions: Transaction[], filters: TransactionFilter): Promise<Transaction[]> {
  const result: Transaction[] = [];
  for (const tx of transactions) {
    if (filters.categories && !filters.categories.includes(tx.category ?? '')) {
      continue;
    }
    if (filters.original_currencies) {
      const match = filters.original_currencies.some(
        (c) => c.toLowerCase() === tx.original_currency.toLowerCase(),
      );
      if (!match) continue;
    }
    if (filters.merchants) {
      const text = tx.merchant ?? tx.rawText;
      let matched = false;
      for (const pattern of filters.merchants) {
        if (await regex.test(pattern, 'is', text, `merchant filter "${pattern}"`)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
    }
    if (filters.amount_min !== undefined || filters.amount_max !== undefined) {
      const effectiveAmount = Math.abs(tx.amount !== undefined ? tx.amount : tx.original_amount);
      if (filters.amount_min !== undefined && effectiveAmount < filters.amount_min) continue;
      if (filters.amount_max !== undefined && effectiveAmount > filters.amount_max) continue;
    }
    result.push(tx);
  }
  return result;
}
