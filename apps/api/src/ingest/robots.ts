/** Minimal robots.txt support (RFC 9309): groups by user-agent, Allow/Disallow with longest match, * and $ wildcards. */
export type RobotsVerdict = 'allowed' | 'disallowed' | 'unavailable';
export interface RobotsGuard { check(url: string): Promise<RobotsVerdict>; failure(url: string): string | undefined }
type Rule = { allow: boolean; pattern: string };
const TOKEN = 'crimelensbot';

export function parseRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = []; let cur: (typeof groups)[number] | null = null; let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim()); if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && cur && val) cur.rules.push({ allow: key === 'allow', pattern: val });   // an empty Disallow means "allow everything"
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && TOKEN.includes(a)));
  return (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}
function matches(pattern: string, target: string): boolean {
  const end = pattern.endsWith('$'), body = end ? pattern.slice(0, -1) : pattern;
  return new RegExp('^' + body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (end ? '$' : '')).test(target);
}
export function isAllowed(rules: Rule[], target: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) if (matches(r.pattern, target) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  return best ? best.allow : true;
}

/** Fetches each origin's robots.txt once per guard. 2xx: obey it. 4xx (including 404): no restrictions. 5xx or network failure: unavailable, so do not crawl this run. */
export function createRobotsGuard(o: { fetchImpl?: typeof fetch; userAgent: string }): RobotsGuard {
  const f = o.fetchImpl ?? fetch; const cache = new Map<string, Promise<Rule[] | 'unavailable'>>(); const failures = new Map<string, string>();
  const load = async (origin: string): Promise<Rule[] | 'unavailable'> => {
    try {
      const res = await f(`${origin}/robots.txt`, { headers: { 'User-Agent': o.userAgent }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return parseRobots(await res.text());
      if (res.status >= 400 && res.status < 500) return [];
      failures.set(origin, `HTTP ${res.status}`); return 'unavailable';
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      failures.set(origin, String(err.cause?.code ?? err.name).replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 60) || 'network_error'); return 'unavailable';   // an error code, never a stack trace
    }
  };
  return {
    failure: (url) => failures.get(new URL(url).origin),
    async check(url) {
      const u = new URL(url); if (!cache.has(u.origin)) cache.set(u.origin, load(u.origin));
      const rules = await cache.get(u.origin)!;
      return rules === 'unavailable' ? 'unavailable' : isAllowed(rules, u.pathname + u.search) ? 'allowed' : 'disallowed';
    },
  };
}
