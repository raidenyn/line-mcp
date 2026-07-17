import * as crypto from 'crypto';

/**
 * A self-contained, HMAC-signed token codec for MCP-over-HTTP auth.
 *
 * Tokens are `base64url(JSON.stringify(claims)) + "." + base64url(HMAC-SHA256)`.
 * Claims are a discriminated version-1 shape (access vs refresh). Verification
 * is schema-checked and total: anything that is not this exact well-formed
 * shape — including the two historical `{ authData, expiresAt }` / `{ authData }`
 * payloads — is rejected, not migrated. There is intentionally no configured
 * global codec; callers build one from their own secret via the factory.
 */

export type TokenKind = 'access' | 'refresh';

export interface TokenClaims {
  readonly version: 1;
  readonly kind: TokenKind;
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface TokenCodecConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface IssueOptions {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds: number;
}

export interface VerifyOptions {
  readonly requiredScopes?: readonly string[];
}

export interface TokenCodec {
  issueAccessToken(options: IssueOptions): string;
  issueRefreshToken(options: IssueOptions): string;
  verifyAccessToken(token: string, options?: VerifyOptions): TokenClaims | null;
  verifyRefreshToken(token: string, options?: VerifyOptions): TokenClaims | null;
}

function sign(payload: object, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verifies the HMAC and returns the decoded JSON payload, or `null`. */
function verifySignature(token: string, secret: string): unknown {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Total, strict structural validation of a decoded payload. */
function parseClaims(raw: unknown): TokenClaims | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) return null;
  if (c.kind !== 'access' && c.kind !== 'refresh') return null;
  if (typeof c.subject !== 'string' || c.subject === '') return null;
  if (typeof c.issuer !== 'string' || c.issuer === '') return null;
  if (typeof c.audience !== 'string' || c.audience === '') return null;
  if (!Array.isArray(c.scopes) || !c.scopes.every((s) => typeof s === 'string')) return null;
  if (typeof c.issuedAt !== 'number' || !Number.isFinite(c.issuedAt)) return null;
  if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)) return null;
  return {
    version: 1,
    kind: c.kind,
    subject: c.subject,
    issuer: c.issuer,
    audience: c.audience,
    scopes: c.scopes as string[],
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
}

export function createTokenCodec(config: TokenCodecConfig): TokenCodec {
  const { secret, issuer, audience } = config;
  const now = config.now ?? Date.now;

  function issue(kind: TokenKind, options: IssueOptions): string {
    const issuedAt = now();
    const claims: TokenClaims = {
      version: 1,
      kind,
      subject: options.subject,
      issuer,
      audience,
      scopes: [...options.scopes],
      issuedAt,
      expiresAt: issuedAt + options.ttlSeconds * 1000,
    };
    return sign(claims, secret);
  }

  function verify(token: string, kind: TokenKind, options?: VerifyOptions): TokenClaims | null {
    const claims = parseClaims(verifySignature(token, secret));
    if (!claims) return null;
    if (claims.kind !== kind) return null;
    if (claims.issuer !== issuer) return null;
    if (claims.audience !== audience) return null;
    if (now() >= claims.expiresAt) return null;
    const required = options?.requiredScopes;
    if (required && !required.every((s) => claims.scopes.includes(s))) return null;
    return claims;
  }

  return {
    issueAccessToken: (options) => issue('access', options),
    issueRefreshToken: (options) => issue('refresh', options),
    verifyAccessToken: (token, options) => verify(token, 'access', options),
    verifyRefreshToken: (token, options) => verify(token, 'refresh', options),
  };
}
