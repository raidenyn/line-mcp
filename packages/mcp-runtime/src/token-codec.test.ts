import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { createTokenCodec } from './token-codec';

const SECRET = 'test-secret-0123456789';
const ISSUER = 'https://issuer.example';
const AUDIENCE = 'https://issuer.example/mcp';

function makeCodec(overrides: Partial<{ secret: string; issuer: string; audience: string; now: () => number }> = {}) {
  return createTokenCodec({
    secret: overrides.secret ?? SECRET,
    issuer: overrides.issuer ?? ISSUER,
    audience: overrides.audience ?? AUDIENCE,
    now: overrides.now,
  });
}

// Mirrors the codec's on-the-wire format so tests can forge validly-signed
// payloads of arbitrary (including legacy / malformed) shape.
function forge(payload: unknown, secret = SECRET): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

describe('token codec — happy path', () => {
  it('round-trips an access token', () => {
    const codec = makeCodec();
    const token = codec.issueAccessToken({ subject: 'user-1', scopes: ['line'], ttlSeconds: 3600 });
    const claims = codec.verifyAccessToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.kind).toBe('access');
    expect(claims!.subject).toBe('user-1');
    expect(claims!.scopes).toEqual(['line']);
    expect(claims!.issuer).toBe(ISSUER);
    expect(claims!.audience).toBe(AUDIENCE);
    expect(Number.isFinite(claims!.expiresAt)).toBe(true);
  });

  it('round-trips a refresh token', () => {
    const codec = makeCodec();
    const token = codec.issueRefreshToken({ subject: 'user-1', scopes: ['line'], ttlSeconds: 3600 });
    const claims = codec.verifyRefreshToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.kind).toBe('refresh');
  });

  it('accepts a token whose scopes cover the required scopes', () => {
    const codec = makeCodec();
    const token = codec.issueAccessToken({ subject: 'u', scopes: ['line', 'admin'], ttlSeconds: 3600 });
    expect(codec.verifyAccessToken(token, { requiredScopes: ['line'] })).not.toBeNull();
  });
});

describe('token codec — rejections', () => {
  it('rejects an access token presented to the refresh verifier and vice versa', () => {
    const codec = makeCodec();
    const access = codec.issueAccessToken({ subject: 'u', scopes: [], ttlSeconds: 3600 });
    const refresh = codec.issueRefreshToken({ subject: 'u', scopes: [], ttlSeconds: 3600 });
    expect(codec.verifyRefreshToken(access)).toBeNull();
    expect(codec.verifyAccessToken(refresh)).toBeNull();
  });

  it('rejects a token signed for a different issuer', () => {
    const issuing = makeCodec({ issuer: 'https://evil.example' });
    const token = issuing.issueAccessToken({ subject: 'u', scopes: [], ttlSeconds: 3600 });
    const verifying = makeCodec(); // same secret, correct issuer
    expect(verifying.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a token minted for a different audience', () => {
    const issuing = makeCodec({ audience: 'https://other.example/mcp' });
    const token = issuing.issueAccessToken({ subject: 'u', scopes: [], ttlSeconds: 3600 });
    const verifying = makeCodec();
    expect(verifying.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a token lacking a required scope', () => {
    const codec = makeCodec();
    const token = codec.issueAccessToken({ subject: 'u', scopes: ['line'], ttlSeconds: 3600 });
    expect(codec.verifyAccessToken(token, { requiredScopes: ['admin'] })).toBeNull();
  });

  it('rejects a token with a tampered signature', () => {
    const codec = makeCodec();
    const token = codec.issueAccessToken({ subject: 'u', scopes: [], ttlSeconds: 3600 });
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(codec.verifyAccessToken(tampered)).toBeNull();
  });

  it('rejects a token signed with the wrong secret', () => {
    const codec = makeCodec();
    const forged = forge(
      { version: 1, kind: 'access', subject: 'u', issuer: ISSUER, audience: AUDIENCE, scopes: [], issuedAt: Date.now(), expiresAt: Date.now() + 10_000 },
      'wrong-secret',
    );
    expect(codec.verifyAccessToken(forged)).toBeNull();
  });

  it('rejects a structurally malformed token (no separator)', () => {
    const codec = makeCodec();
    expect(codec.verifyAccessToken('not-a-token')).toBeNull();
    expect(codec.verifyAccessToken('')).toBeNull();
  });

  it('rejects a validly-signed token missing expiresAt', () => {
    const codec = makeCodec();
    const token = forge({ version: 1, kind: 'access', subject: 'u', issuer: ISSUER, audience: AUDIENCE, scopes: [], issuedAt: Date.now() });
    expect(codec.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a validly-signed token whose expiresAt is not finite', () => {
    const codec = makeCodec();
    const nullExp = forge({ version: 1, kind: 'access', subject: 'u', issuer: ISSUER, audience: AUDIENCE, scopes: [], issuedAt: Date.now(), expiresAt: null });
    const strExp = forge({ version: 1, kind: 'access', subject: 'u', issuer: ISSUER, audience: AUDIENCE, scopes: [], issuedAt: Date.now(), expiresAt: 'soon' });
    expect(codec.verifyAccessToken(nullExp)).toBeNull();
    expect(codec.verifyAccessToken(strExp)).toBeNull();
  });

  it('rejects an expired token', () => {
    let clock = 1_000_000;
    const codec = makeCodec({ now: () => clock });
    const token = codec.issueAccessToken({ subject: 'u', scopes: [], ttlSeconds: 10 });
    expect(codec.verifyAccessToken(token)).not.toBeNull();
    clock += 11_000; // advance past expiry
    expect(codec.verifyAccessToken(token)).toBeNull();
  });

  it('rejects the legacy { authData, expiresAt } payload shape', () => {
    const codec = makeCodec();
    const legacy = forge({ authData: { mid: 'u123', accessToken: 'a' }, expiresAt: Date.now() + 100_000 });
    expect(codec.verifyAccessToken(legacy)).toBeNull();
    expect(codec.verifyRefreshToken(legacy)).toBeNull();
  });

  it('rejects the legacy { authData } refresh payload shape', () => {
    const codec = makeCodec();
    const legacy = forge({ authData: { mid: 'u123', refreshToken: 'r' } });
    expect(codec.verifyAccessToken(legacy)).toBeNull();
    expect(codec.verifyRefreshToken(legacy)).toBeNull();
  });
});
