/**
 * The six error codes of the frozen bank tool envelope contract
 * (`openspec/archived/design/expense-ledger/rfc-expense-ledger.md`, Tool
 * envelope). `line_session_expired` is defined now and used by the ingest
 * task; this task never raises it.
 */
export type LedgerErrorCode =
  | 'setup_required'
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'internal_error'
  | 'line_session_expired';

export interface LedgerErrorOptions {
  action?: string;
  details?: Record<string, unknown>;
}

/**
 * A typed ledger failure. `ledger/` throws this; the MCP-facing envelope
 * helper in `tools/envelope.ts` maps it to a structured error result, so
 * `ledger/` never imports from `tools/`.
 */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly action?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: LedgerErrorCode, message: string, options: LedgerErrorOptions = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (options.action !== undefined) this.action = options.action;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** An argument that failed validation, carrying the offending field name. */
export function invalidArgument(field: string, message: string): LedgerError {
  return new LedgerError('invalid_argument', message, { details: { field } });
}
