// ─── redirect_uri policy ────────────────────────────────────────────────────
//
// Loopback redirect URIs are always allowed (RFC 8252 §7.3): a native MCP
// client listens on an ephemeral local port and cannot be pre-registered.
// Everything else must match the operator's `OAUTH_ALLOWED_REDIRECT_URIS`
// allowlist exactly — there are no wildcards and no pattern matching.

export interface RedirectPolicy {
  /** True when `/authorize` or `/register` may use this redirect URI. */
  isAllowed(uri: string): boolean;
}

const ALLOWED_URIS_VARIABLE = 'OAUTH_ALLOWED_REDIRECT_URIS';

// An entry with no path (or only `/`) is an origin entry: it authorizes every
// URL on that origin. Anything with a path is an exact-URL entry.
const ORIGIN_ENTRY_PATTERN = /^https:\/\/[^/?#]+\/?$/i;

// The scheme MUST be http(s): a `//localhost` authority parses under any
// scheme, so checking only the hostname would let `javascript:`/`data:`/`file:`
// URIs through and the authorize page would then navigate the browser to
// attacker-controlled JavaScript (reflected-XSS / token-exfiltration vector).
function isLoopback(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function entryError(entry: string, reason: string): Error {
  return new Error(
    `${ALLOWED_URIS_VARIABLE} entry ${JSON.stringify(entry)} ${reason}; ` +
    'entries must be absolute https URLs without wildcards, userinfo or fragments',
  );
}

/**
 * Builds the redirect policy from a comma-separated allowlist. Unset or blank
 * means loopback-only. Invalid entries throw at start-up, naming the variable.
 */
export function createRedirectPolicy(raw: string | undefined): RedirectPolicy {
  const origins = new Set<string>();
  const exact = new Set<string>();

  if (raw !== undefined && raw.trim() !== '') {
    for (const rawEntry of raw.split(',')) {
      const entry = rawEntry.trim();
      if (entry === '') continue;
      if (entry.includes('*')) {
        throw entryError(entry, 'must not contain a wildcard');
      }

      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw entryError(entry, 'is not a valid absolute URL');
      }
      if (url.protocol !== 'https:') {
        throw entryError(entry, 'must use https');
      }
      if (url.username !== '' || url.password !== '') {
        throw entryError(entry, 'must not contain userinfo');
      }
      if (url.hash !== '') {
        throw entryError(entry, 'must not contain a fragment');
      }

      if (ORIGIN_ENTRY_PATTERN.test(entry)) origins.add(url.origin);
      else exact.add(url.href);
    }
  }

  return {
    isAllowed(uri: string): boolean {
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        return false;
      }
      if (isLoopback(url)) return true;
      if (url.protocol !== 'https:') return false;
      if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
      return origins.has(url.origin) || exact.has(url.href);
    },
  };
}
