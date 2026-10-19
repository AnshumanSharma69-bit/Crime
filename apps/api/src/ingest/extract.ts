import type pg from 'pg';
import { IncidentCandidateSchema, type IncidentCandidate } from '@crimelens/shared';

/** Adapter for an LLM or rule-based extractor. Its output is untrusted until it passes the strict schema. */
export interface ExtractionAdapter { extract(doc: { title: string; bodyText: string }): Promise<unknown> }
export const validateExtraction = (raw: unknown): IncidentCandidate | null => { const r = IncidentCandidateSchema.safeParse(raw); return r.success ? r.data : null; };

/** Candidates always land in the review queue; nothing is published automatically. A document may yield several incidents (press notes list many cases). */
export async function extractCandidates(pool: pg.Pool, adapter: ExtractionAdapter | null, limit = 20) {
  if (!adapter) return { candidates: 0, errors: 0 };
  const docs = (await pool.query(`SELECT id, title, body_text FROM source_documents WHERE status IN ('new','updated') AND body_text IS NOT NULL ORDER BY id LIMIT $1`, [limit])).rows;
  let candidates = 0, errors = 0;
  for (const d of docs) {
    let raw: unknown; let failed = false;
    try { raw = await adapter.extract({ title: d.title, bodyText: d.body_text }); } catch { failed = true; }
    const list = failed ? [] : (Array.isArray(raw) ? raw : [raw]).slice(0, 50);   // capped so a runaway answer cannot flood the queue
    const valid = list.map(validateExtraction).filter((x): x is IncidentCandidate => x !== null);
    const bad = failed ? 1 : list.length - valid.length; errors += bad;
    if (valid.length === 0 && bad > 0) { await pool.query(`UPDATE source_documents SET status='error', error='invalid_extraction' WHERE id=$1`, [d.id]); continue; }
    for (const cand of valid) {
      if ((await pool.query(`SELECT 1 FROM extraction_candidates WHERE document_id=$1 AND payload->>'headline'=$2`, [d.id, cand.headline])).rowCount) continue;   // re-extraction of an updated document adds no duplicates
      await pool.query(`INSERT INTO extraction_candidates (document_id, kind, payload) VALUES ($1,$2,$3)`, [d.id, cand.kind, cand]); candidates++;
    }
    await pool.query(`UPDATE source_documents SET status='processed' WHERE id=$1`, [d.id]);
  }
  return { candidates, errors };
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 2));
type Cmp = { headline: string; eventDate: string | null; locality: string | null };
/** 'possible' goes to human review; only 'duplicate' may be auto-linked. */
export function compareCandidates(a: Cmp, b: Cmp): 'duplicate' | 'possible' | 'distinct' {
  const ta = tokens(a.headline), tb = tokens(b.headline); const inter = [...ta].filter((t) => tb.has(t)).length;
  const jac = inter / (ta.size + tb.size - inter || 1);
  const dayGap = a.eventDate && b.eventDate ? Math.abs(Date.parse(a.eventDate) - Date.parse(b.eventDate)) / 864e5 : null;
  if (dayGap !== null && dayGap > 1) return 'distinct';
  const sameLoc = a.locality && b.locality ? a.locality.toLowerCase() === b.locality.toLowerCase() : null;
  if (sameLoc === false) return 'distinct';
  if (jac >= 0.7 && dayGap !== null && sameLoc === true) return 'duplicate';
  return jac >= 0.4 ? 'possible' : 'distinct';
}
