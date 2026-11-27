import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LedgerError, type LedgerErrorCode } from '../ledger/errors';

/** The contract error codes, re-exported for tool modules. */
export type ToolErrorCode = LedgerErrorCode;

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  action?: string;
  details?: Record<string, unknown>;
}

/** The only text an unexpected failure ever puts in an answer. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error in the ledger.';

/** A successful bank tool answer: structured content plus the same JSON as text. */
export function okResult(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** A typed failure: `isError`, `{ error }` as structured content and as text. */
export function errorResult(error: ToolError): CallToolResult {
  const structured = { error };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Runs a tool handler inside the envelope. A `LedgerError` keeps its code,
 * message, action and details; anything else becomes a fixed `internal_error`
 * whose answer never contains the original text, which goes to stderr for
 * diagnosis.
 */
export async function runTool(
  fn: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    return okResult(await fn());
  } catch (error) {
    if (error instanceof LedgerError) {
      const toolError: ToolError = { code: error.code, message: error.message };
      if (error.action !== undefined) toolError.action = error.action;
      if (error.details !== undefined) toolError.details = error.details;
      return errorResult(toolError);
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`ledger tool internal error: ${detail}\n`);
    return errorResult({ code: 'internal_error', message: INTERNAL_ERROR_MESSAGE });
  }
}
