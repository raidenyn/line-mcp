export function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return '';
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
