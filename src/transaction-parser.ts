import { z } from 'zod';

export const TransactionTemplateSchema = z.object({
  pattern: z.string().describe('JS regex with named capture groups: original_amount, original_currency (required); amount, currency, merchant, date, balance, account (optional)'),
  amount_sign: z.enum(['debit', 'credit']).optional().describe('Sign to apply to original_amount when not already signed in the captured value'),
  date_format: z.string().optional().describe('Format hint for the captured date group, e.g. "DD/MM" or "DD/MM/YYYY HH:mm"'),
});
export type TransactionTemplate = z.infer<typeof TransactionTemplateSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  original_amount: z.number(),
  original_currency: z.string(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  account: z.string().optional(),
  merchant: z.string().optional(),
  balance: z.number().optional(),
  rawText: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

function parseNumeric(str: string): number {
  return parseFloat(str.replace(/,/g, ''));
}

// Matches a group containing an unbounded quantifier that is itself unbounded-quantified,
// e.g. (\w+\s*)+ — the primary source of catastrophic backtracking (ReDoS).
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*]/;

const regexCache = new Map<string, RegExp | null>();
function getRegex(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    try {
      if (NESTED_QUANTIFIER_RE.test(pattern)) {
        regexCache.set(pattern, null);
      } else {
        // 's' flag: dot matches newlines — needed for bilingual messages (Thai + English in one blob)
        regexCache.set(pattern, new RegExp(pattern, 's'));
      }
    } catch {
      regexCache.set(pattern, null);
    }
  }
  return regexCache.get(pattern)!;
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

export function parseTransaction(
  message: { id: string; createdTime: string; text?: string; contentType: number },
  templates: TransactionTemplate[],
): Transaction | null {
  if (message.contentType !== 0 || !message.text) return null;

  for (const tmpl of templates) {
    const regex = getRegex(tmpl.pattern);
    if (!regex) continue;

    const match = regex.exec(message.text);
    if (!match?.groups) continue;

    const g = match.groups;
    if (!g.original_amount || !g.original_currency) continue;

    let original_amount = parseNumeric(g.original_amount);
    if (tmpl.amount_sign && !/^[\s]*[+\-−]/.test(g.original_amount)) {
      if (tmpl.amount_sign === 'debit') original_amount = -Math.abs(original_amount);
      else if (tmpl.amount_sign === 'credit') original_amount = Math.abs(original_amount);
    }

    const tx: Transaction = {
      id: message.id,
      date: parseDate(g.date, tmpl.date_format, message.createdTime),
      original_amount,
      original_currency: g.original_currency.trim(),
      rawText: message.text,
    };

    if (g.currency) tx.currency = g.currency.trim();
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
}

export function summarize(
  transactions: Transaction[],
  groupBy: 'month' | 'merchant',
  since?: string,
  until?: string,
): SummaryOutput {
  let filtered = transactions;
  if (since) filtered = filtered.filter((tx) => tx.date >= since);
  if (until) {
    filtered = filtered.filter((tx) => tx.date <= expandUntilBound(until));
  }

  const byGroup: Record<string, { debit: number; credit: number; count: number }> = {};
  let total_debit = 0;
  let total_credit = 0;

  for (const tx of filtered) {
    const key =
      groupBy === 'month'
        ? tx.date.slice(0, 7) // "YYYY-MM"
        : (tx.merchant ?? 'unknown');

    const effectiveAmount = tx.amount !== undefined ? tx.amount : tx.original_amount;

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
      filtered.map((tx) =>
        tx.amount !== undefined
          ? (tx.currency ?? tx.original_currency)
          : tx.original_currency,
      ),
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
  };
}

export function applyBalanceDiffs(transactions: Transaction[]): void {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = tx.account ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }
  for (const group of groups.values()) {
    let prevBalance: number | undefined;
    for (const tx of group) {
      if (tx.amount === undefined && tx.balance !== undefined && prevBalance !== undefined) {
        tx.amount = tx.balance - prevBalance;
      }
      if (tx.balance !== undefined) prevBalance = tx.balance;
    }
  }
}
