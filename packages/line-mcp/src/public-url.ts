import * as net from 'net';

// ─── Public origin ──────────────────────────────────────────────────────────
//
// `PUBLIC_URL` names the origin users reach this server at (typically the
// TLS-terminating reverse proxy). It is deliberately an ORIGIN: the path
// belongs to `BASE_PATH`, so a path in `PUBLIC_URL` is rejected instead of
// being silently combined with it (which would duplicate the prefix).

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const PUBLIC_URL_HINT =
  'PUBLIC_URL must be an absolute http(s) origin such as https://mcp.example.com ' +
  '(no path, query, fragment or userinfo)';

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Normalizes and validates the externally visible origin.
 *
 * - unset/blank → `http://localhost:<port>`
 * - `https:` anywhere, or `http:` on loopback → the normalized origin
 * - `http:` on any other host → the origin plus one warning (existing http
 *   deployments keep starting; TLS is strongly recommended)
 * - anything else → throws, naming `PUBLIC_URL` (and `BASE_PATH` for a path)
 */
export function resolvePublicOrigin(
  raw: string | undefined,
  port: number,
  warn: (message: string) => void = message => process.stderr.write(`[config] ${message}\n`),
): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return `http://localhost:${port}`;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${PUBLIC_URL_HINT}; got ${JSON.stringify(trimmed)}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${PUBLIC_URL_HINT}; got ${JSON.stringify(trimmed)}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${PUBLIC_URL_HINT}; it must not contain userinfo`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${PUBLIC_URL_HINT}; it must not contain a query or fragment`);
  }
  if (url.pathname !== '/') {
    throw new Error(
      `${PUBLIC_URL_HINT}; it must not contain a path — put the path in BASE_PATH instead ` +
      `(got ${JSON.stringify(url.pathname)})`,
    );
  }

  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    warn(
      `PUBLIC_URL uses http for non-loopback host ${url.hostname}; ` +
      'tokens and authorization codes will travel unencrypted — use https behind a TLS proxy',
    );
  }

  return url.origin;
}

// ─── Proxy trust ────────────────────────────────────────────────────────────
//
// Express accepts `true`, a hop count, or a comma-separated list of named
// ranges/CIDRs. It throws unnamed errors for bad values, so every value is
// validated here first and reported as a TRUST_PROXY configuration error.

const TRUST_PROXY_HINT =
  'TRUST_PROXY must be true, false, a non-negative hop count, or a comma-separated list of ' +
  'loopback/linklocal/uniquelocal/IP/CIDR entries';

function isValidTrustProxyEntry(entry: string): boolean {
  if (entry === 'loopback' || entry === 'linklocal' || entry === 'uniquelocal') return true;
  if (net.isIP(entry) !== 0) return true;

  const slash = entry.indexOf('/');
  if (slash === -1) return false;
  const address = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  const family = net.isIP(address);
  if (family === 0) return false;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  const maxBits = family === 4 ? 32 : 128;
  return bits >= 0 && bits <= maxBits;
}

/**
 * Parses `TRUST_PROXY` into the value Express expects.
 *
 * Returns `false` for unset/blank/`false`/`0`, `true` for `true`
 * (case-insensitive), a number for a non-negative hop count, and the
 * normalized list string otherwise. Invalid values throw, naming
 * `TRUST_PROXY`.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return false;

  const lower = trimmed.toLowerCase();
  if (lower === 'false') return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return hops === 0 ? false : hops;
  }

  const entries = trimmed.split(',').map(entry => entry.trim());
  if (entries.some(entry => entry === '') || !entries.every(isValidTrustProxyEntry)) {
    throw new Error(`${TRUST_PROXY_HINT}; got ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}
