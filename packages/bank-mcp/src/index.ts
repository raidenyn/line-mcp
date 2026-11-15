// Public entry point for @raidenyn/bank-mcp.
//
// Importing this module has no side effects: no filesystem reads, no database
// connections, no timers, no sockets. Stores only touch disk when constructed
// with an explicit path by the executable that owns the data root.

// ─── Domain: parsing, FX, filtering, categorization ─────────────────────────
export {
  parseTransaction,
  summarize,
  expandUntilBound,
  applyBalanceDiffs,
  categorize,
  validateFilters,
  filterTransactions,
  TransactionTemplateSchema,
  TransactionSchema,
  CategorySchema,
  TransactionFilterSchema,
  type TransactionTemplate,
  type Transaction,
  type Category,
  type TransactionFilter,
  type SummaryOutput,
} from './transaction-parser';

export { getHistoricalRate } from './fx-rates';

export { filterSampleMessages, parseSampleUntilBound } from './sample-messages';

// ─── Stores (explicit paths; trusted-tenant, shared across principals) ──────
export {
  loadTemplates,
  upsertTemplate,
  deleteTemplate,
  listTemplates,
  upsertAlias,
  deleteAlias,
  listAliases,
  filterByTime,
  NamedTemplateSchema,
  TemplateStore,
  type NamedTemplate,
} from './template-store';

export { CategoryStore } from './category-store';

export {
  loadAllPresets,
  getPreset,
  detectPresets,
  PresetStore,
  type Preset,
  type PresetSuggestion,
} from './preset-store';

// ─── Category migration primitive (issue #75, Task 10) ──────────────────────
export {
  readLegacyCategories,
  stageBankCategories,
  type LegacyCategoryRow,
  type BankCategoryStagingResult,
} from './category-migration';

// ─── Bounded regex worker executor (issue #61, Task 1) ──────────────────────
export {
  RegexExecutor,
  RegexExecutionError,
  normalizeRegexTimeoutMs,
  type RegexExecutorPort,
  type RegexErrorCode,
  type RegexMatch,
} from './regex-executor';

// ─── MCP tool + resource registrations ──────────────────────────────────────
export { type BankToolDeps, registerBankTools } from './tools';
export { type RegisterBankResourcesOptions, registerBankResources } from './resources';
