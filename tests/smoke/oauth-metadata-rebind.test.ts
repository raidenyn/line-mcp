import { describe, it, expect } from 'vitest';
import { validateAndRebindEndpoints } from '../support/smoke-helpers';

describe('validateAndRebindEndpoints', () => {
  const appOrigin = 'http://127.0.0.1:3000';

  it('rebinds localhost-advertised endpoints to the app origin while preserving paths', () => {
    const result = validateAndRebindEndpoints(
      {
        authorization_endpoint: 'http://localhost:3000/authorize',
        token_endpoint: 'http://localhost:3000/token',
        registration_endpoint: 'http://localhost:3000/register',
      },
      appOrigin,
    );
    expect(result).toEqual({
      authorizationEndpoint: 'http://127.0.0.1:3000/authorize',
      tokenEndpoint: 'http://127.0.0.1:3000/token',
      registrationEndpoint: 'http://127.0.0.1:3000/register',
    });
  });

  it('accepts 127.0.0.1-advertised endpoints that match the app port', () => {
    const result = validateAndRebindEndpoints(
      {
        authorization_endpoint: 'http://127.0.0.1:3000/authorize',
        token_endpoint: 'http://127.0.0.1:3000/token',
        registration_endpoint: 'http://127.0.0.1:3000/register',
      },
      appOrigin,
    );
    expect(result.authorizationEndpoint).toBe('http://127.0.0.1:3000/authorize');
    expect(result.registrationEndpoint).toBe('http://127.0.0.1:3000/register');
  });

  it('preserves multi-segment advertised paths', () => {
    const result = validateAndRebindEndpoints(
      {
        authorization_endpoint: 'http://localhost:3000/oauth/authorize',
        token_endpoint: 'http://localhost:3000/oauth/token',
        registration_endpoint: 'http://localhost:3000/oauth/register',
      },
      appOrigin,
    );
    expect(result.authorizationEndpoint).toBe('http://127.0.0.1:3000/oauth/authorize');
    expect(result.tokenEndpoint).toBe('http://127.0.0.1:3000/oauth/token');
    expect(result.registrationEndpoint).toBe('http://127.0.0.1:3000/oauth/register');
  });

  it('throws on a registration_endpoint advertised on a hostile origin without performing network I/O', () => {
    expect(() =>
      validateAndRebindEndpoints(
        {
          authorization_endpoint: 'http://localhost:3000/authorize',
          token_endpoint: 'http://localhost:3000/token',
          registration_endpoint: 'https://attacker.example/register',
        },
        appOrigin,
      ),
    ).toThrowError(/registration_endpoint advertised origin https:\/\/attacker\.example/);
  });

  it('throws on an authorization_endpoint advertised on a hostile origin', () => {
    expect(() =>
      validateAndRebindEndpoints(
        {
          authorization_endpoint: 'https://attacker.example/authorize',
          token_endpoint: 'http://localhost:3000/token',
          registration_endpoint: 'http://localhost:3000/register',
        },
        appOrigin,
      ),
    ).toThrowError(/authorization_endpoint advertised origin https:\/\/attacker\.example/);
  });

  it('throws on a token_endpoint advertised on a foreign port', () => {
    expect(() =>
      validateAndRebindEndpoints(
        {
          authorization_endpoint: 'http://localhost:3000/authorize',
          token_endpoint: 'http://localhost:9999/token',
          registration_endpoint: 'http://localhost:3000/register',
        },
        appOrigin,
      ),
    ).toThrowError(/token_endpoint advertised origin http:\/\/localhost:9999/);
  });

  it('throws on a non-loopback app origin', () => {
    expect(() =>
      validateAndRebindEndpoints(
        {
          authorization_endpoint: 'http://example.com/authorize',
          token_endpoint: 'http://example.com/token',
          registration_endpoint: 'http://example.com/register',
        },
        'http://example.com:3000',
      ),
    ).toThrowError(/expects a loopback appOrigin/);
  });
});