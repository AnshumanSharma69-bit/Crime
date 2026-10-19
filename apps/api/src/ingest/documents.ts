import type pg from 'pg';
import { normalizeDocumentText } from './legacy-font';
import { extractPdfText, MAX_PDF_BYTES } from './pdf';
import { createRobotsGuard } from './robots';
import type { RunDeps } from './types';

const PERMANENT = new Set(['not_a_pdf', 'pdf_too_large', 'pdf_too_many_pages', 'pdf_no_text', 'legacy_font_unconverted']);
const script = (t: string) => ((t.match(/[\u0900-\u097F]/g)?.length ?? 0) / Math.max(1, t.replace(/\s/g, '').length) > 0.3 ? 'devanagari' : 'latin');

/** Downloads PDFs for documents that still have no text. Same gate as listing fetches: only for enabled sources with a recorded robots/terms review. */
export async function fetchDocumentBodies(pool: pg.Pool, deps: RunDeps = {}, o: { limit?: number } = {}) {
  const f = deps.fetchImpl ?? fetch; const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const ua = `CrimeLensBot/0.1 (+${process.env.CRAWLER_CONTACT || 'contact-not-configured'})`;
  const docs = (await pool.query(`SELECT d.id, d.canonical_url FROM source_documents d JOIN sources s ON s.id = d.source_id
    WHERE d.status IN ('new','updated') AND d.body_text IS NULL AND d.canonical_url ~* '\\.pdf$' AND s.enabled AND s.robots_checked_at IS NOT NULL ORDER BY d.id LIMIT $1`, [o.limit ?? 10])).rows;
  const robots = createRobotsGuard({ fetchImpl: f, userAgent: ua }); const out = { fetched: 0, failed: 0, unreadable: 0, converted: 0, blocked: 0 };
  for (const [i, d] of docs.entries()) {
    if (i > 0) await sleep(1500);   // polite pacing
    const verdict = await robots.check(d.canonical_url);
    if (verdict === 'disallowed') { out.blocked++; continue; }   // left untouched; robots.txt is re-read on the next run
    if (verdict === 'unavailable') { out.failed++; continue; }
    try {
      const res = await f(d.canonical_url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { if (res.status >= 500 || res.status === 429) throw new Error('transient'); throw new Error(`http_${res.status}`); }
      if (!/pdf/i.test(res.headers.get('content-type') ?? '')) throw new Error('not_a_pdf');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) throw new Error('pdf_too_large');
      const norm = normalizeDocumentText((await extractPdfText(buf)).text);
      if (norm.legacy && !norm.converted) throw new Error('legacy_font_unconverted');   // never hand garbled text to the extractor
      await pool.query(`UPDATE source_documents SET body_text=$2, language=$3, error=NULL WHERE id=$1`, [d.id, norm.text, script(norm.text)]); out.fetched++; if (norm.converted) out.converted++;
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'transient' || /fetch failed|timeout|abort|network/i.test(m) || (e as Error).name === 'TimeoutError') { out.failed++; continue; }   // left untouched, retried next run
      await pool.query(`UPDATE source_documents SET status='error', error=$2 WHERE id=$1`, [d.id, PERMANENT.has(m) || m.startsWith('http_') ? m : 'pdf_unreadable']); out.unreadable++;
    }
  }
  return out;
}
