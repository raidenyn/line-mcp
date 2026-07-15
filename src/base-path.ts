export function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// Single validated public origin for OAuth metadata, WWW-Authenticate, and upload
// URLs. Resolution order:
//   1. PUBLIC_URL env (set this to your https proxy origin in remote deployments)
//   2. http://localhost:<port> (direct, dev, and test fallback)
// No request-derived origin (req.protocol/req.get('host')) is used, so proxied
// HTTPS deployments no longer fall back to the caller's own localhost.
export function getPublicOrigin(fallbackPort: number): string {
  const configured = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  return `http://localhost:${fallbackPort}`;
}
