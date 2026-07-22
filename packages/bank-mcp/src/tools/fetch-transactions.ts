import type { Principal } from '@raidenyn/mcp-runtime';
import {
  parseTransaction,
  expandUntilBound,
  applyBalanceDiffs,
  categorize,
  validateFilters,
  filterTransactions,
  type Transaction,
  type TransactionFilter,
} from '../transaction-parser';
import { filterByTime } from '../template-store';
import type { BankToolDeps } from './deps';

export function buildAmountWarnings(transactions: Transaction[]): string[] {
  const warnings: string[] = [];
  const estimatedCount = transactions.filter((t) => t.amount_estimated).length;
  if (estimatedCount > 0) {
    warnings.push(
      `${estimatedCount} transaction(s) have amount estimated via FX conversion or balance diff — may not match the bank's own applied rate/fees. See amount_estimated field.`,
    );
  }
  const gapSuspectedCount = transactions.filter((t) => t.amount_gap_suspected).length;
  if (gapSuspectedCount > 0) {
    warnings.push(
      `${gapSuspectedCount} transaction(s) show a balance change that doesn't reconcile with their FX-converted amount — there may be other untracked activity nearby. See amount_gap_suspected field.`,
    );
  }
  const unknownCurrencyCount = transactions.filter(
    (t) => t.amount !== undefined && t.currency === undefined,
  ).length;
  if (unknownCurrencyCount > 0) {
    warnings.push(
      `${unknownCurrencyCount} transaction(s) have an amount with unknown currency; summaries report these amounts separately under unknown_currency and unknown_by_group.`,
    );
  }
  return warnings;
}

/**
 * Loads saved templates for `chatMid`, fetches the matching messages through
 * the principal's cache-backed reader, parses/normalizes/categorizes/filters
 * them, and returns the transactions plus any human-readable warnings. Shared
 * by get_transactions (saved-templates path) and summarize_transactions.
 */
export async function fetchParsedTransactions<P extends Principal>(
  deps: BankToolDeps<P>,
  principal: P,
  chatMid: string,
  since?: string,
  until?: string,
  filters: TransactionFilter = {},
): Promise<
  | { transactions: Transaction[]; warnings: string[]; rangeNote: string }
  | { error: string }
> {
  if (since && !Number.isFinite(new Date(since).getTime())) {
    return { error: `Invalid 'since' date: "${since}". Use ISO 8601 format, e.g. "2026-05-01".` };
  }
  if (until && !Number.isFinite(new Date(until).getTime())) {
    return { error: `Invalid 'until' date: "${until}". Use ISO 8601 format, e.g. "2026-05-31".` };
  }

  const filterError = validateFilters(filters);
  if (filterError) {
    return { error: filterError };
  }

  const warnings: string[] = [];
  const loaded = deps.templates.load(chatMid);
  const savedTemplates = loaded.templates;
  const savedAliases = loaded.currency_aliases;

  if (savedTemplates.length === 0) {
    return {
      error:
        'No templates provided and none saved for this chat. ' +
        'Call sample_messages to inspect messages, then manage_templates (action: upsert) to save patterns.',
    };
  }

  for (const t of savedTemplates) {
    if (t.valid_from && !Number.isFinite(new Date(t.valid_from).getTime())) {
      warnings.push(`Template "${t.name}": valid_from "${t.valid_from}" could not be parsed — treating as always-valid.`);
    }
    if (t.valid_until && !Number.isFinite(new Date(t.valid_until).getTime())) {
      warnings.push(`Template "${t.name}": valid_until "${t.valid_until}" could not be parsed — treating as always-valid.`);
    }
  }

  const reader = await deps.createMessageReader(principal);
  const messages = since
    ? await reader.getMessagesInRange(chatMid, new Date(since).getTime())
    : await reader.getMessages(chatMid, 200);

  let transactions = messages
    .map((msg) => {
      const templatesForMsg = filterByTime(savedTemplates, parseInt(msg.createdTime, 10));
      return parseTransaction(msg, templatesForMsg, savedAliases);
    })
    .filter((tx): tx is Transaction => tx !== null);

  if (since) transactions = transactions.filter((tx) => tx.date >= since);
  if (until) transactions = transactions.filter((tx) => tx.date <= expandUntilBound(until));
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  await applyBalanceDiffs(transactions);
  categorize(transactions, deps.categories.list());
  transactions = filterTransactions(transactions, filters);
  warnings.push(...buildAmountWarnings(transactions));

  const rangeNote = since
    ? ''
    : '\n\nNote: Only the latest 200 messages were checked. Pass `since` to fetch the complete history for a time range.';

  return { transactions, warnings, rangeNote };
}
