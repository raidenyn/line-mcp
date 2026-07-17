import * as crypto from 'crypto';
import { signForAccount } from '@raidenyn/line-client';
import { VALID_STORAGE_KEY } from './fixtures';
import type { ExpectedRejectionKind } from './state';

export const REQUIRED_LINE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US',
  'content-type': 'application/json',
  origin: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'x-lal': 'en_US',
  'x-line-chrome-version': '3.7.2',
} as const;

export const REQUIRED_LINE_HEADER_KEYS = Object.keys(REQUIRED_LINE_HEADERS);

export const LINE_ROUTES = {
  createSession: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
  createQrCode: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode',
  checkQr: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
  verifyCertificate: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate',
  createPin: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode',
  checkPin: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified',
  login: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
  identity: '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
  profile: '/api/talk/thrift/Talk/TalkService/getProfile',
  allChatMids: '/api/talk/thrift/Talk/TalkService/getAllChatMids',
  allContactIds: '/api/talk/thrift/Talk/TalkService/getAllContactIds',
  chats: '/api/talk/thrift/Talk/TalkService/getChats',
  contacts: '/api/talk/thrift/Talk/TalkService/getContactsV2',
  recent: '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2',
  previous: '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
  refresh: '/api/auth/tokenRefresh',
} as const;

export type LineRouteKey = keyof typeof LINE_ROUTES;

export const PRE_AUTH_ROUTES: ReadonlySet<string> = new Set<string>([
  LINE_ROUTES.createSession,
  LINE_ROUTES.createQrCode,
  LINE_ROUTES.checkQr,
  LINE_ROUTES.verifyCertificate,
  LINE_ROUTES.createPin,
  LINE_ROUTES.checkPin,
  LINE_ROUTES.login,
  LINE_ROUTES.identity,
  LINE_ROUTES.refresh,
]);

export const LONG_POLL_ROUTES: ReadonlySet<string> = new Set<string>([
  LINE_ROUTES.checkQr,
  LINE_ROUTES.checkPin,
]);

export interface MockRawRequest {
  pathname: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface MockValidationResult {
  ok: boolean;
  status: number;
  body: unknown;
  rejectionKind?: ExpectedRejectionKind;
}

export function lineOk<T>(data: T) {
  return { code: 0 as const, message: 'OK' as const, data };
}

export function lineApiError(code: number, message: string, data: unknown = null) {
  return { code, message, data };
}

export function lineHttpStatus(rejection: ExpectedRejectionKind): number {
  switch (rejection) {
    case 'unknown_route': return 404;
    case 'unknown_access_token':
    case 'expired_access_token':
    case 'superseded_access_token': return 401;
    default: return 400;
  }
}

export function lineApiCode(rejection: ExpectedRejectionKind): { code: number; message: string } {
  switch (rejection) {
    case 'missing_hmac': return { code: 10005, message: 'REQUEST_MISSING_HMAC' };
    case 'invalid_hmac': return { code: 10005, message: 'REQUEST_INVALID_HMAC' };
    case 'invalid_body': return { code: 10002, message: 'REQUEST_INVALID_BODY' };
    case 'missing_auth_header': return { code: 10003, message: 'REQUEST_MISSING_AUTH' };
    case 'unknown_access_token': return { code: 10006, message: 'REQUEST_UNKNOWN_ACCESS_TOKEN' };
    case 'expired_access_token': return { code: 10007, message: 'REQUEST_EXPIRED_ACCESS_TOKEN' };
    case 'superseded_access_token': return { code: 10008, message: 'REQUEST_SUPERSEDED_ACCESS_TOKEN' };
    case 'unknown_refresh_token': return { code: 10009, message: 'REQUEST_UNKNOWN_REFRESH_TOKEN' };
    case 'invalid_session': return { code: 10010, message: 'REQUEST_INVALID_SESSION' };
    case 'illegal_transition': return { code: 10011, message: 'REQUEST_ILLEGAL_TRANSITION' };
    case 'unknown_boundary': return { code: 10012, message: 'REQUEST_UNKNOWN_BOUNDARY' };
    case 'unknown_route': return { code: 10004, message: 'REQUEST_UNKNOWN_ROUTE' };
    default: return { code: 10000, message: 'REQUEST_INVALID' };
  }
}

function lowerHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function isPreAuth(pathname: string): boolean {
  return PRE_AUTH_ROUTES.has(pathname);
}

function isLongPoll(pathname: string): boolean {
  return LONG_POLL_ROUTES.has(pathname);
}

export function readRawBody(request: import('http').IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    request.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

export interface HeaderValidationResult {
  ok: boolean;
  rejection?: ExpectedRejectionKind;
  accessToken: string;
  longPoll: boolean;
  sessionId?: string;
  diagnostic?: unknown;
}

export function validateHeaders(req: MockRawRequest): HeaderValidationResult {
  const h = lowerHeaders(req.headers);
  for (const key of REQUIRED_LINE_HEADER_KEYS) {
    if (h[key] == null) {
      return { ok: false, rejection: 'invalid_body', accessToken: '', longPoll: false, diagnostic: { missingHeader: key } };
    }
  }
  const hmacHeader = singleString(h['x-hmac']);
  if (hmacHeader == null) {
    return { ok: false, rejection: 'missing_hmac', accessToken: '', longPoll: false };
  }
  const preAuth = isPreAuth(req.pathname);
  const access = singleString(h['x-line-access']) ?? '';
  if (!preAuth) {
    if (!access) {
      return { ok: false, rejection: 'missing_auth_header', accessToken: '', longPoll: false };
    }
  }
  const longPoll = isLongPoll(req.pathname);
  if (longPoll) {
    const lst = singleString(h['x-lst']);
    if (lst == null) {
      return { ok: false, rejection: 'invalid_body', accessToken: access, longPoll: true, diagnostic: { missingHeader: 'x-lst' } };
    }
    const sessionId = singleString(h['x-line-session-id']);
    if (sessionId == null) {
      return { ok: false, rejection: 'invalid_body', accessToken: access, longPoll: true, diagnostic: { missingHeader: 'x-line-session-id' } };
    }
    return { ok: true, accessToken: access, longPoll: true, sessionId };
  }
  return { ok: true, accessToken: access, longPoll: false };
}

function singleString(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export interface HmacValidationResult {
  ok: boolean;
  rejection?: ExpectedRejectionKind;
}

export async function validateHmac(req: MockRawRequest, accessToken: string): Promise<HmacValidationResult> {
  const h = lowerHeaders(req.headers);
  const actual = singleString(h['x-hmac']);
  if (actual == null) {
    return { ok: false, rejection: 'missing_hmac' };
  }
  try {
    const expected = await signForAccount(VALID_STORAGE_KEY, {
      accessToken,
      path: req.pathname,
      body: req.rawBody.toString('utf8'),
    });
    const expectedBytes = Buffer.from(expected, 'base64');
    const actualBytes = Buffer.from(actual, 'base64');
    const valid = expectedBytes.length === 32 && actualBytes.length === 32 &&
      crypto.timingSafeEqual(expectedBytes, actualBytes);
    if (!valid) return { ok: false, rejection: 'invalid_hmac' };
    return { ok: true };
  } catch {
    return { ok: false, rejection: 'invalid_hmac' };
  }
}

export interface JsonBodyResult {
  ok: boolean;
  value?: unknown;
  rejection?: ExpectedRejectionKind;
}

export function parseJsonBody(raw: Buffer): JsonBodyResult {
  if (raw.length === 0) {
    return { ok: false, rejection: 'invalid_body' };
  }
  try {
    const value = JSON.parse(raw.toString('utf8'));
    return { ok: true, value };
  } catch {
    return { ok: false, rejection: 'invalid_body' };
  }
}

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|token|certificate|nonce|kdf|hmac|secret|mid/i.test(k)) {
        const fingerprint = crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
        out[k] = `redacted:${fingerprint}`;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}