import { type Express, type Request as ExpressRequest } from 'express';
import { AuthData } from '@raidenyn/line-client';
import {
  type AuthProvider,
  type Principal,
  createTokenCodec,
  type TokenCodec,
} from '@raidenyn/mcp-runtime';
import {
  type CredentialStore,
  maskMid,
  persistAuthData,
} from './credential-store';
import {
  mountOAuthRoutes,
  makeWwwAuthenticate,
  type IssuedTokenPair,
} from './oauth-router';

// ─── Injected canonical endpoint configuration ──────────────────────────────
//
// Every externally-visible URL — the AS/PR metadata, the token claims'
// issuer/audience, the challenge metadata URL, redirect-scope decisions, and
// the import public base — derives from this ONE object. Nothing in the auth
// layer computes `http://localhost:PORT...` on its own.
export interface PublicEndpointConfig {
  issuer: URL;
  resource: URL;
  basePath: string;
  requiredScopes: readonly string[];
}

// Build the canonical endpoint configuration from a port + normalized base
// path, the way the executable derives it today (`http://localhost:PORT<base>`
// as issuer, `<issuer>/mcp` as the protected resource). Kept here so there is
// exactly one place that turns a port into the public URLs the whole auth layer
// keys off.
export function publicEndpointConfig(
  port: number,
  basePath: string,
  requiredScopes: readonly string[] = ['line'],
): PublicEndpointConfig {
  return {
    issuer: new URL(`http://localhost:${port}${basePath}`),
    resource: new URL(`http://localhost:${port}${basePath}/mcp`),
    basePath,
    requiredScopes,
  };
}

// ─── MID-only principal ─────────────────────────────────────────────────────

export interface LinePrincipal extends Principal {
  readonly provider: 'line';
  readonly mid: string;
}

export interface LineAuthProviderOptions {
  /** HMAC signing secret. Injected by the executable; never read from disk here. */
  secret: string;
  endpoints: PublicEndpointConfig;
  credentialStore: CredentialStore;
  /**
   * Directory the account selector / login persistence read and write auth
   * records in. Same directory the `credentialStore` closes over — passed
   * explicitly so the router's synchronous selector enumeration stays cheap.
   */
  authStoreDir: string;
  lineApiBaseUrl?: string;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Access-token lifetime in seconds. Default 24h. */
  accessTtlSeconds?: number;
  /** Refresh-token lifetime in seconds. Default 90 days. */
  refreshTtlSeconds?: number;
}

const DEFAULT_ACCESS_TTL_SECONDS = 86_400; // 24h
const DEFAULT_REFRESH_TTL_SECONDS = 90 * 86_400; // 90 days

function bearerToken(request: ExpressRequest): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * The concrete LINE authentication scheme: a real implementation of
 * mcp-runtime's `AuthProvider<LinePrincipal>`.
 *
 * Breaking cutover: tokens are finite-lived, MID-only, typed claims produced by
 * mcp-runtime's schema-checked codec. Neither access nor refresh tokens embed
 * any LINE credential (access/refresh token, certificate, nonce, KDF values).
 * The two historical embedded-auth payloads (`{ authData, expiresAt }` and
 * `{ authData }`) have no `version`/`kind` field and are rejected by the codec's
 * total schema check — never migrated — so every previously issued token
 * requires a one-time reauthorization.
 */
export class LineAuthProvider implements AuthProvider<LinePrincipal> {
  private readonly codec: TokenCodec;
  private readonly base: string;
  private readonly audience: string;
  private readonly scopes: readonly string[];
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  // e2e-only bearer bypass; never populated in production.
  private readonly testOverrides = new Map<string, AuthData>();
  // Freshest-known LINE credential per MID, owned by THIS provider instance —
  // never a module-level map. Two providers on the same MID but different
  // dataRoots (two independent LineAuthProvider instances in one process)
  // each get their own map, so neither can resolve the other's snapshot.
  private readonly freshness = new Map<string, AuthData>();

  constructor(private readonly options: LineAuthProviderOptions) {
    const { endpoints } = options;
    // Canonical issuer/audience strings, derived once from the injected config.
    // `new URL('http://localhost:3000').href` yields a trailing slash; strip it
    // so the emitted issuer matches the historical `http://localhost:PORT` form.
    this.base = endpoints.issuer.href.replace(/\/$/, '');
    this.audience = endpoints.resource.href.replace(/\/$/, '');
    this.scopes = [...endpoints.requiredScopes];
    this.accessTtlSeconds = options.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.refreshTtlSeconds = options.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
    this.codec = createTokenCodec({
      secret: options.secret,
      issuer: this.base,
      audience: this.audience,
      now: options.now,
    });
  }

  mountRoutes(app: Express): void {
    mountOAuthRoutes(app, {
      base: this.base,
      origin: this.options.endpoints.issuer.origin,
      basePath: this.options.endpoints.basePath,
      requiredScopes: this.scopes,
      authStoreDir: this.options.authStoreDir,
      credentialStore: this.options.credentialStore,
      lineApiBaseUrl: this.options.lineApiBaseUrl,
      issueTokens: (authData) => this.issueTokens(authData),
      issueFromRefresh: (token) => this.issueFromRefresh(token),
      recordRefreshedAuth: (authData) => this.recordRefreshedAuth(authData),
    });
  }

  async authenticate(request: ExpressRequest): Promise<LinePrincipal | null> {
    const token = bearerToken(request);
    if (!token) return null;

    // e2e bypass: a seeded token maps straight to its AuthData. Prime the
    // freshness cache ONLY if nothing is there yet, mirroring the priming-only
    // guard in issueTokens(). A mid-session LINE token rotation
    // (recordRefreshedAuth) updates the freshness map; an unconditional set
    // here on every request would stomp that fresher snapshot back to the
    // stale seeded snapshot and serve an already-superseded credential
    // downstream.
    const override = this.testOverrides.get(token);
    if (override) {
      if (!this.freshness.has(override.mid)) this.freshness.set(override.mid, override);
      return this.makePrincipal(override.mid, this.scopes);
    }

    const claims = this.codec.verifyAccessToken(token, { requiredScopes: this.scopes });
    if (!claims) return null;
    return this.makePrincipal(claims.subject, claims.scopes);
  }

  challenge(_request: ExpressRequest): string {
    return makeWwwAuthenticate(this.options.endpoints.issuer.origin, this.options.endpoints.basePath);
  }

  // Resolve the freshest LINE credential for an authenticated principal:
  // in-memory freshest-snapshot first, then a lazy load by MID from the store.
  // A missing record means the account must reauthorize.
  async resolveCredentials(principal: LinePrincipal): Promise<Readonly<AuthData> | null> {
    if (principal.subject !== principal.mid) return null;
    return this.freshestCredential(principal.mid);
  }

  /** e2e-only: register a bearer token that bypasses the codec. */
  seedTestToken(token: string, authData: AuthData): void {
    this.testOverrides.set(token, authData);
  }

  /**
   * Records the freshest known LINE credential for a MID — called both when a
   * LINE token rotates mid-request and right after a login completes. Updates
   * this provider's own in-memory snapshot FIRST (so it's served immediately,
   * even to the request that triggered the refresh), then attempts an atomic
   * disk replacement. Persistence failure is logged with a credential-free
   * message and swallowed: the LINE token-refresh callback that drives this is
   * synchronous and must never throw, and the fresh snapshot is still served
   * from memory until restart.
   */
  recordRefreshedAuth(authData: AuthData): void {
    this.freshness.set(authData.mid, authData);
    try {
      persistAuthData(authData, undefined, this.options.authStoreDir);
    } catch {
      process.stderr.write(
        `[OAuth] Refreshed LINE auth for ${maskMid(authData.mid)} but could not persist it\n`,
      );
    }
  }

  // Checks this provider's own in-memory freshness map first, then falls back
  // to a lazy disk load — priming the map on a disk hit so a later call
  // resolves from memory without a repeat disk round-trip. Re-checks the map
  // after the async load: a `recordRefreshedAuth()` call during the await may
  // have installed a fresher snapshot than whatever disk just returned, and
  // that fresher value wins (never overwrite it with stale disk data, never
  // return null when a fresh snapshot arrived mid-load).
  private async freshestCredential(mid: string): Promise<Readonly<AuthData> | null> {
    const cached = this.freshness.get(mid);
    if (cached) return cached;
    const loaded = await this.options.credentialStore.load(mid);
    const installedDuringLoad = this.freshness.get(mid);
    if (installedDuringLoad) return installedDuringLoad;
    if (loaded) this.freshness.set(mid, loaded);
    return loaded;
  }

  // ─── Token issuance (used by the OAuth router) ──────────────────────────

  private issueTokens(authData: AuthData): IssuedTokenPair {
    const mid = authData.mid;
    // Prime the freshest-known snapshot so a follow-up request resolves
    // credentials from memory without a disk round-trip.
    if (!this.freshness.has(mid)) this.freshness.set(mid, authData);
    return {
      access_token: this.codec.issueAccessToken({ subject: mid, scopes: this.scopes, ttlSeconds: this.accessTtlSeconds }),
      refresh_token: this.codec.issueRefreshToken({ subject: mid, scopes: this.scopes, ttlSeconds: this.refreshTtlSeconds }),
    };
  }

  private async issueFromRefresh(refreshToken: string): Promise<IssuedTokenPair | null> {
    const claims = this.codec.verifyRefreshToken(refreshToken, { requiredScopes: this.scopes });
    if (!claims) return null; // legacy or malformed refresh token → reauthorize
    // Reload credentials by MID: memory first, then the store. No record → the
    // account must reauthorize (the refresh token alone carries no credential).
    const authData = await this.freshestCredential(claims.subject);
    if (!authData) return null;
    return this.issueTokens(authData);
  }

  private makePrincipal(mid: string, scopes: readonly string[]): LinePrincipal {
    // The one identity invariant: a LINE principal's subject IS its MID.
    return { provider: 'line', subject: mid, mid, scopes: [...scopes] };
  }
}
