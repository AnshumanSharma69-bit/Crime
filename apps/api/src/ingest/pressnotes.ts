import * as cheerio from 'cheerio';
import { parseDmyAsIst } from '@crimelens/shared';
import { createRobotsGuard } from './robots';
import { normalizeUrl } from './url';
import { FetchError, type Connector, type RunDeps, type SourceItem } from './types';

const LISTING = 'https://nagpurpolice.gov.in/press-releases';

/**
 * UNVERIFIED: written from the rendered text of the listing page (title | date shown twice | PDF link),
 * not from its raw HTML. Rows without a PDF ("file not available") are skipped; only titles containing
 * "Pressnote" or "Press Conference" are treated as incident-bearing, other rows (e.g. notifications) are stored but ignored.
 */
export function parsePressNoteListing(html: string, base = LISTING) {
  const $ = cheerio.load(html); const items: SourceItem[] = []; let skipped = 0;
  $('table tr').each((_, tr) => {
    const td = $(tr).find('td'); if (td.length < 3) return;
    const title = $(td[0]).text().replace(/\s+/g, ' ').trim();
    // Join child nodes with spaces so adjacent short/long date spans cannot fuse into one digit run; ambiguous text yields no date.
    const dateText = $(td[1]).contents().map((_, n) => $(n).text()).get().join(' ');
    const date = /(?<![\d/])(\d{2}\/\d{2}\/\d{4})(?![\d/])/.exec(dateText);
    const href = $(td[2]).find('a[href]').first().attr('href');
    if (!title || !href) { skipped++; return; }
    let url: string; try { url = normalizeUrl(new URL(href, base).toString()); } catch { skipped++; return; }
    items.push({ canonicalUrl: url, externalId: url.split('/').pop() ?? null, title, publishedAt: date ? parseDmyAsIst(date[1]) : null,
      language: null, bodyText: null, incidentBearing: /press\s*(note|conference)/i.test(title) });
  });
  return { items, skipped };
}

/** Polite listing fetch: identifies itself, pauses between pages, never retries 4xx (other than 429). */
export function createPressNoteConnector(opts: { maxPages?: number; pageDelayMs?: number } = {}): Connector {
  return {
    slug: 'nagpur-police-press-notes',
    async fetchItems(deps: RunDeps) {
      const f = deps.fetchImpl ?? fetch; const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const ua = `CrimeLensBot/0.1 (+${process.env.CRAWLER_CONTACT || 'contact-not-configured'})`;
      const robots = createRobotsGuard({ fetchImpl: f, userAgent: ua }); const all: SourceItem[] = [];
      for (let page = 1; page <= (opts.maxPages ?? 1); page++) {
        if (page > 1) await sleep(opts.pageDelayMs ?? 2000);
        const url = `${LISTING}?page=${page}`; const verdict = await robots.check(url);
        if (verdict === 'disallowed') throw new FetchError('blocked_by_robots', false);
        if (verdict === 'unavailable') { const why = robots.failure(url) ?? 'unknown'; throw new FetchError(`robots_unavailable (${why})`, !/^(UNABLE_TO_|CERT_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME)/.test(why)); }   // certificate problems are not transient
        const res = await f(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new FetchError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429);
        all.push(...parsePressNoteListing(await res.text()).items);
      }
      return all;
    },
  };
}
