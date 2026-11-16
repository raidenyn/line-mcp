import { describe, it, expect } from 'vitest';
import { createRedirectPolicy } from './redirect-policy';

describe('createRedirectPolicy — loopback default', () => {
  it.each([undefined, '', ' , '])('allows loopback only for %j', raw => {
    const policy = createRedirectPolicy(raw);
    expect(policy.isAllowed('http://localhost:8123/callback')).toBe(true);
    expect(policy.isAllowed('https://127.0.0.1/x')).toBe(true);
    expect(policy.isAllowed('https://client.example.com/cb')).toBe(false);
    expect(policy.isAllowed('javascript://localhost/evil')).toBe(false);
    expect(policy.isAllowed('data://localhost')).toBe(false);
    expect(policy.isAllowed('file://127.0.0.1/x')).toBe(false);
    expect(policy.isAllowed('not a url')).toBe(false);
    expect(policy.isAllowed('http://[::1]/cb')).toBe(false);
  });
});

describe('createRedirectPolicy — origin entry', () => {
  const policy = createRedirectPolicy('https://client.example.com');

  it('allows any URL on the configured origin', () => {
    expect(policy.isAllowed('https://client.example.com/oauth/callback?x=1')).toBe(true);
  });

  it.each([
    'https://client.example.com.evil.test/cb',
    'https://client.example.com@evil.test/cb',
    'https://client.example.com:8443/cb',
    'http://client.example.com/cb',
    'https://client.example.com/cb#x',
    'https://u@client.example.com/cb',
  ])('rejects look-alike or decorated %s', uri => {
    expect(policy.isAllowed(uri)).toBe(false);
  });
});

describe('createRedirectPolicy — exact entry', () => {
  it('allows exactly the configured URL', () => {
    const policy = createRedirectPolicy('https://client.example.com/oauth/callback');
    expect(policy.isAllowed('https://client.example.com/oauth/callback')).toBe(true);
    expect(policy.isAllowed('https://client.example.com/other')).toBe(false);
  });

  it('supports several comma-separated entries with surrounding spaces', () => {
    const policy = createRedirectPolicy(' https://a.example.com/cb , https://b.example.com/cb ');
    expect(policy.isAllowed('https://a.example.com/cb')).toBe(true);
    expect(policy.isAllowed('https://b.example.com/cb')).toBe(true);
    expect(policy.isAllowed('https://c.example.com/cb')).toBe(false);
  });

  it('keeps loopback allowed when an allowlist is configured', () => {
    const policy = createRedirectPolicy('https://client.example.com');
    expect(policy.isAllowed('http://127.0.0.1:53682/callback')).toBe(true);
  });
});

describe('createRedirectPolicy — invalid entries fail closed', () => {
  it.each([
    'http://a.com/cb',
    'https://*.example.com',
    'https://a.com/*',
    'javascript:alert(1)',
    'https://a.com/cb#frag',
    'https://u:p@a.com',
    'garbage',
  ])('throws for %s naming OAUTH_ALLOWED_REDIRECT_URIS', entry => {
    expect(() => createRedirectPolicy(entry)).toThrowError(/OAUTH_ALLOWED_REDIRECT_URIS/);
  });
});
