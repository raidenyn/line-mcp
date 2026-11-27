import { createHash } from 'crypto';

/** Sorts object keys recursively so JSON canonicalises regardless of member order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonical(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 (hex) of the canonical arguments of a `manage_accounts` write,
 * without `idempotency_key` — so a retry after a lost answer matches the
 * first request even though the key itself differs from nothing else. The
 * caller passes the arguments exactly as the handler received them, before
 * any server-side default or normalisation.
 */
export function requestHash(args: Record<string, unknown>): string {
  const { idempotency_key: _idempotencyKey, ...rest } = args;
  void _idempotencyKey;
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex');
}
