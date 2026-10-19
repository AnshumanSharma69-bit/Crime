import { parse } from 'csv-parse/sync';
import type pg from 'pg';
import { z } from 'zod';
import { CATEGORY_CODES, LOCATION_PRECISIONS } from '@crimelens/shared';
import { insertDraftIncident } from './promote';
import { normalizeUrl } from './url';

const SENSITIVE = new Set(['women_children']);   // never mapped more precisely than a neighbourhood
const iso = z.string().datetime({ offset: true });
export const ImportRecord = z.object({
  city: z.string().default('nagpur'), sourceSlug: z.string().min(1), url: z.string().url(), title: z.string().min(3).max(300), publishedAt: iso.optional(),
  headline: z.string().min(5).max(200), summary: z.string().min(10).max(800), categoryCode: z.enum(CATEGORY_CODES), eventDate: iso.optional(), locality: z.string().max(120).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
  precision: z.enum(LOCATION_PRECISIONS).optional(), confidence: z.enum(['low', 'medium', 'high']).optional(),
}).strict().superRefine((r, ctx) => {
  const add = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
  if ((r.lat == null) !== (r.lng == null)) add('lat and lng must be given together', 'lat');
  if (r.lat != null && (!r.precision || r.precision === 'unknown')) add('coordinates need a stated precision', 'precision');
  if (r.precision === 'street' && SENSITIVE.has(r.categoryCode)) add('street-level locations are not allowed for sensitive categories', 'precision');
});

export function parseImport(text: string, format: 'csv' | 'json'): unknown[] {
  if (format === 'json') { const v = JSON.parse(text); return Array.isArray(v) ? v : [v]; }
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}
const clean = (o: unknown) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null)) : o);

/** Loads permitted records as unpublished drafts linked to their original source URL. A bad row never blocks the others. */
export async function importRecords(pool: pg.Pool, rows: unknown[], opts: { dryRun?: boolean } = {}) {
  const out = { created: 0, skippedDuplicates: 0, errors: [] as { row: number; message: string }[] };
  for (const [i, raw] of rows.entries()) {
    const p = ImportRecord.safeParse(clean(raw));
    if (!p.success) { out.errors.push({ row: i + 1, message: p.error.issues.map((x) => `${x.path.join('.') || 'record'}: ${x.message}`).join('; ') }); continue; }
    const r = p.data; const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const src = (await c.query('SELECT id FROM sources WHERE slug = $1', [r.sourceSlug])).rows[0];
      if (!src) throw new Error(`unknown sourceSlug "${r.sourceSlug}"`);
      const doc = (await c.query(
        `INSERT INTO source_documents (source_id, canonical_url, title, published_at, status) VALUES ($1,$2,$3,$4,'processed')
         ON CONFLICT (source_id, canonical_url) DO UPDATE SET last_fetched_at = now() RETURNING id`, [src.id, normalizeUrl(r.url), r.title, r.publishedAt ?? null])).rows[0].id;
      if ((await c.query('SELECT 1 FROM incident_sources WHERE document_id = $1', [doc])).rowCount) { out.skippedDuplicates++; await c.query('ROLLBACK'); continue; }
      const id = await insertDraftIncident(c, { citySlug: r.city, categoryCode: r.categoryCode, headline: r.headline, summary: r.summary, eventStart: r.eventDate ?? null, locality: r.locality ?? null,
        lat: r.lat, lng: r.lng, precision: r.precision, confidence: r.confidence, documentId: doc, role: 'primary' });
      await c.query(`INSERT INTO audit_events (action, entity_type, entity_id, after) VALUES ('import.incident','incident',$1,$2)`, [id, JSON.stringify({ sourceSlug: r.sourceSlug, url: r.url })]);
      await c.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT'); out.created++;
    } catch (e) { await c.query('ROLLBACK'); out.errors.push({ row: i + 1, message: (e as Error).message }); } finally { c.release(); }
  }
  return out;
}
