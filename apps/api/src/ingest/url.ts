const TRACKING = /^(utm_|fbclid$|gclid$|mc_)/i;
/** Canonical form used as the dedupe key: https, lowercase host without www, no fragment, tracking params removed, sorted query, no trailing slash. */
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol');
  u.protocol = 'https:'; u.hostname = u.hostname.toLowerCase().replace(/^www\./, ''); u.hash = '';
  if (u.port === '80' || u.port === '443') u.port = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}
