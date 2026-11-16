import { createRedirectPolicy, type RedirectPolicy } from './auth/redirect-policy';
import { parseTrustProxy, resolvePublicOrigin } from './public-url';

/** The validated OAuth-facing configuration both servers derive at start-up. */
export interface ResolvedOAuthConfig {
  /** Normalized public origin, e.g. `https://mcp.example.com` (no trailing slash). */
  publicOrigin: string;
  /** True when `PUBLIC_URL` was set to a non-blank value. */
  explicitPublicUrl: boolean;
  redirectPolicy: RedirectPolicy;
  /** Exactly what Express should receive for `trust proxy`. */
  trustProxy: boolean | number | string;
}

export interface ResolveOAuthConfigInput {
  publicUrl?: string;
  allowedRedirectUris?: string;
  trustProxy?: string;
  port: number;
  /** Test seam for the non-loopback-http warning; defaults to stderr. */
  warn?: (message: string) => void;
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Validates every OAuth-related environment variable in one place. Called as
 * the FIRST statement of `start()` in both servers, before any persistence,
 * database, secret or worker is created, so a bad value aborts with the data
 * root untouched.
 */
export function resolveOAuthConfig(input: ResolveOAuthConfigInput): ResolvedOAuthConfig {
  const publicUrl = blankToUndefined(input.publicUrl);
  const allowedRedirectUris = blankToUndefined(input.allowedRedirectUris);
  const trustProxyRaw = blankToUndefined(input.trustProxy);

  const publicOrigin = resolvePublicOrigin(publicUrl, input.port, input.warn);
  const redirectPolicy = createRedirectPolicy(allowedRedirectUris);
  const trustProxy = parseTrustProxy(trustProxyRaw);

  return {
    publicOrigin,
    explicitPublicUrl: publicUrl !== undefined,
    redirectPolicy,
    trustProxy,
  };
}
