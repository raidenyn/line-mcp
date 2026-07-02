export function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
