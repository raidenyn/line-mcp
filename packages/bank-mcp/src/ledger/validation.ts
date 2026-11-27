/**
 * Input validation for the ledger tools. Every rule of `manage_accounts`
 * lives here and throws `LedgerError` with `invalid_argument`, so the MCP
 * input schema can stay permissive (`z.unknown()`) without any argument
 * escaping the structured envelope.
 */
import { invalidArgument } from './errors';

export const LABEL_MAX = 200;
export const IDEMPOTENCY_KEY_MAX = 200;
export const LINE_SOURCE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * A string with no lone UTF-16 surrogate. SQLite replaces a lone surrogate
 * with U+FFFD when binding, which would silently change a label and could make
 * two caller-supplied idempotency keys compare equal.
 */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalidArgument(field, `${field} must be a string, got ${describe(value)}`);
  }
  if (!isWellFormed(value)) {
    throw invalidArgument(field, `${field} must be valid Unicode text`);
  }
  return value;
}

/**
 * An ISO 4217 code known to the runtime, uppercased (`thb` → `THB`).
 * A three-letter pattern alone would accept `ABC`, which no currency table
 * knows.
 */
export function normalizeCurrency(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const code = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !CURRENCIES.has(code)) {
    throw invalidArgument(field, `${field} must be an ISO 4217 currency code, got ${JSON.stringify(raw)}`);
  }
  return code;
}

/**
 * A canonical IANA timezone name. Fixed offsets such as `+07:00` are refused,
 * and every stored value is the runtime's canonical spelling (`asia/bangkok` →
 * `Asia/Bangkok`, `Asia/Kolkata` → `Asia/Calcutta`), so equality checks
 * normalise both sides.
 */
export function normalizeTimezone(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw invalidArgument(field, `${field} must be an IANA timezone name, got ${JSON.stringify(raw)}`);
  }
  if (resolved !== 'UTC' && !TIME_ZONES.has(resolved)) {
    throw invalidArgument(field, `${field} must be an IANA timezone name, got ${JSON.stringify(raw)}`);
  }
  return resolved;
}

/** A real calendar date written `YYYY-MM-DD`. */
export function parseReviewFrom(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    throw invalidArgument(field, `${field} must be a date written YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC remaps years 0-99 to 1900-1999, so set the calendar fields on a
  // fixed instant instead; the parts check below then rejects impossible days.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw invalidArgument(field, `${field} must be a real calendar date, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** A LINE chat MID that a template can address. */
export function parseLineSourceId(value: unknown): string {
  const raw = requireString(value, 'source_id');
  if (!LINE_SOURCE_ID_RE.test(raw)) {
    throw invalidArgument('source_id', 'source_id must match ^[a-zA-Z0-9_-]{1,100}$');
  }
  return raw;
}

export function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const raw = requireString(value, field);
  if (raw.length > maxLength) {
    throw invalidArgument(field, `${field} must be at most ${maxLength} characters`);
  }
  return raw;
}

/** For `label`/`timezone` on update, where `null` clears the stored value. */
export function optionalNullableString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalString(value, field, maxLength);
}

export function optionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidArgument('expected_revision', 'expected_revision must be an integer of at least 1');
  }
  return value;
}

export function optionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > IDEMPOTENCY_KEY_MAX) {
    throw invalidArgument(
      'idempotency_key',
      `idempotency_key must be a string of 1 to ${IDEMPOTENCY_KEY_MAX} characters`,
    );
  }
  if (!isWellFormed(value)) {
    throw invalidArgument('idempotency_key', 'idempotency_key must be valid Unicode text');
  }
  return value;
}

/** Today's calendar date in `timezone`, as `[year, month, day]`. */
function todayIn(timezone: string, nowMs: number): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return [get('year'), get('month'), get('day')];
}

/** Days in a month, with leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Today in `timezone` minus three calendar months, with the day clamped to
 * the target month's end (31 May → 28/29 February).
 */
export function defaultReviewFrom(nowMs: number, timezone: string): string {
  const [year, month, day] = todayIn(timezone, nowMs);
  let targetYear = year;
  let targetMonth = month - 3;
  if (targetMonth <= 0) {
    targetMonth += 12;
    targetYear -= 1;
  }
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${targetYear}-${pad(targetMonth)}-${pad(clampedDay)}`;
}
