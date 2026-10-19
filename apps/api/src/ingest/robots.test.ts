import { describe, expect, it, vi } from 'vitest';
import { createRobotsGuard, isAllowed, parseRobots } from './robots';

const rules = (txt: string) => parseRobots(txt);
const guard = (status: number, body = '') => { const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })); return { f, g: createRobotsGuard({ fetchImpl: f as any, userAgent: 'CrimeLensBot/0.1' }) }; };

describe('robots.txt rules', () => {
  it('applies Disallow, Allow and the longest match', () => {
    const r = rules('User-agent: *\nDisallow: /private/\nDisallow: /a\nAllow: /a/b');
    expect(isAllowed(r, '/private/x')).toBe(false); expect(isAllowed(r, '/public')).toBe(true);
    expect(isAllowed(r, '/a/b/c')).toBe(true); expect(isAllowed(r, '/a/c')).toBe(false);
  });
  it('supports wildcards and end anchors', () => {
    const r = rules('User-agent: *\nDisallow: /*.pdf$');
    expect(isAllowed(r, '/x/y.pdf')).toBe(false); expect(isAllowed(r, '/x/y.pdf?v=1')).toBe(true); expect(isAllowed(r, '/x/y.html')).toBe(true);
  });
  it('prefers a group naming this crawler over the wildcard group, and ignores comments and empty Disallow', () => {
    expect(isAllowed(rules('User-agent: *\nDisallow: /\n\nUser-agent: CrimeLensBot\nAllow: /'), '/anything')).toBe(true);
    expect(isAllowed(rules('# hello\nUser-agent: *\nDisallow:   # nothing disallowed\n'), '/anything')).toBe(true);
    expect(isAllowed(rules('User-agent: otherbot\nDisallow: /'), '/anything')).toBe(true);
  });
});

describe('robots guard', () => {
  it('treats 404 (and other 4xx) as no restrictions, as the standard says', async () => {
    for (const status of [404, 403]) expect(await guard(status, 'Page Not Found').g.check('https://example.org/press-releases?page=2')).toBe('allowed');
  });
  it('obeys a real file and reports a disallowed path', async () => {
    const { g } = guard(200, 'User-agent: *\nDisallow: /uploads/');
    expect(await g.check('https://example.org/press-releases')).toBe('allowed'); expect(await g.check('https://example.org/uploads/a.pdf')).toBe('disallowed');
  });
  it('reads robots.txt once per origin and does not crawl when it is unreachable', async () => {
    const { f, g } = guard(200, ''); await g.check('https://example.org/a'); await g.check('https://example.org/b'); expect(f).toHaveBeenCalledTimes(1);
    expect(await guard(503).g.check('https://example.org/a')).toBe('unavailable');
    const down = createRobotsGuard({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any, userAgent: 'x' }); expect(await down.check('https://example.org/a')).toBe('unavailable');
  });
});
