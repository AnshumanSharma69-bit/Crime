import type pg from 'pg';
import { IncidentCandidateSchema, type IncidentCandidate } from '@crimelens/shared';
import { compareCandidates } from './extract';
import { insertDraftIncident } from './promote';

/**
 * Optional automatic mode (AUTO_PUBLISH=true). Extracted candidates from an OFFICIAL police source that pass every rule below become drafts, get an approximate
 * location, and are published with a public note saying no person reviewed them. Anything that fails a rule stays in the review queue for a human.
 * Never automatic: news sources, crimes against women and children, unknown categories, low-confidence extractions, likely duplicates, implausible dates.
 */
export type AutoPolicy = { minConfidence: 'medium' | 'high'; maxAgeDays: number };
export const autoEnabled = (env: NodeJS.ProcessEnv = process.env) => env.AUTO_PUBLISH === 'true';
export const policyFromEnv = (env: NodeJS.ProcessEnv = process.env): AutoPolicy => ({
  minConfidence: env.AUTO_MIN_CONFIDENCE === 'high' ? 'high' : 'medium', maxAgeDays: Number(env.AUTO_MAX_AGE_DAYS) > 0 ? Number(env.AUTO_MAX_AGE_DAYS) : 120,
});

export const AUTO_NOTE = 'Automatically extracted from an official Nagpur Police press note and published without review by a person. The position on the map is approximate and comes from a place-name match. Please report errors.';
const HELD_CATEGORIES = new Set(['women_children', 'unknown']);
const PLACEHOLDER = /\[(NAME|ADDRESS|NUMBER|ID|VEHICLE-NO|EMAIL)\]/;

/** Returns why a candidate must go to a person, or null if it may proceed automatically. */
export function reasonToHold(c: IncidentCandidate, sourceType: string, policy: AutoPolicy, now = new Date()): string | null {
  if (sourceType !== 'official_police') return 'not_official_source';
  if (HELD_CATEGORIES.has(c.categoryCode)) return 'sensitive_or_unknown_category';
  if (c.extractionConfidence === 'low' || (policy.minConfidence === 'high' && c.extractionConfidence !== 'high')) return 'low_confidence';
  if (!c.locality?.trim()) return 'no_locality';
  if (PLACEHOLDER.test(c.headline) || PLACEHOLDER.test(c.summary)) return 'placeholder_text';
  if (c.eventDate) {
    const t = Date.parse(c.eventDate);
    if (!Number.isFinite(t) || t > now.getTime() + 2 * 864e5 || t < now.getTime() - policy.maxAgeDays * 864e5) return 'implausible_date';
  }
  return null;
}

/** Candidates that pass become DRAFT incidents (linked to their source document). The rest stay pending for review. */
export async function autoAcceptCandidates(pool: pg.Pool, policy: AutoPolicy, o: { limit?: number; now?: Date } = {}) {
  const out = { accepted: 0, held: {} as Record<string, number> };
  const hold = (r: string) => { out.held[r] = (out.held[r] ?? 0) + 1; };
  const rows = (await pool.query(`SELECT ec.id, ec.payload, ec.document_id, s.type AS source_type FROM extraction_candidates ec
    JOIN source_documents d ON d.id = ec.document_id JOIN sources s ON s.id = d.source_id WHERE ec.status = 'pending_review' AND ec.kind = 'new_incident' ORDER BY ec.id LIMIT $1`, [o.limit ?? 20])).rows;
  for (const r of rows) {
    const parsed = IncidentCandidateSchema.safeParse(r.payload); if (!parsed.success) { hold('invalid_payload'); continue; }
    const c = parsed.data; const why = reasonToHold(c, r.source_type, policy, o.now); if (why) { hold(why); continue; }
    const existing = (await pool.query(`SELECT i.headline, i.event_start, COALESCE(a.name, i.locality_text) AS locality FROM incidents i LEFT JOIN areas a ON a.id = i.area_id
      WHERE i.city_id = (SELECT id FROM cities WHERE slug = 'nagpur') AND i.publication_status IN ('draft','published')
        AND ($1::timestamptz IS NULL OR i.event_start IS NULL OR abs(extract(epoch FROM i.event_start - $1::timestamptz)) < 3 * 86400) ORDER BY i.created_at DESC LIMIT 200`, [c.eventDate])).rows;
    const mine = { headline: c.headline, eventDate: c.eventDate, locality: c.locality };
    if (existing.some((e) => compareCandidates(mine, { headline: e.headline, eventDate: e.event_start ? new Date(e.event_start).toISOString() : null, locality: e.locality }) !== 'distinct')) { hold('possible_duplicate'); continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await client.query(`UPDATE extraction_candidates SET status = 'accepted' WHERE id = $1 AND status = 'pending_review' RETURNING id`, [r.id])).rowCount) { await client.query('ROLLBACK'); continue; }
      const id = await insertDraftIncident(client, { citySlug: 'nagpur', categoryCode: c.categoryCode, headline: c.headline, summary: c.summary, eventStart: c.eventDate, locality: c.locality, documentId: r.document_id, role: 'primary' });
      await client.query(`INSERT INTO audit_events (action, entity_type, entity_id, after) VALUES ('candidate.auto_accept','candidate',$1,$2), ('incident.auto_created','incident',$3,$4)`,
        [String(r.id), JSON.stringify({ incidentId: id }), id, JSON.stringify({ candidateId: r.id, confidence: c.extractionConfidence })]);
      await client.query('COMMIT'); out.accepted++;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  return out;
}

/**
 * Publishes ONLY drafts that automatic mode created itself, that nobody has touched, that have an official source and an approximate location.
 * Drafts from CSV import or from a person's own review are never auto-published.
 */
export async function autoPublishDrafts(pool: pg.Pool, o: { limit?: number } = {}) {
  const out = { published: 0, waitingForLocation: 0 };
  const rows = (await pool.query(`SELECT i.id, i.location IS NOT NULL AS located FROM incidents i
    WHERE i.publication_status = 'draft' AND i.last_reviewed_at IS NULL
      AND EXISTS (SELECT 1 FROM audit_events a WHERE a.action = 'incident.auto_created' AND a.entity_type = 'incident' AND a.entity_id = i.id::text)
      AND EXISTS (SELECT 1 FROM incident_sources x JOIN source_documents d ON d.id = x.document_id JOIN sources s ON s.id = d.source_id WHERE x.incident_id = i.id AND s.type = 'official_police')
    ORDER BY i.created_at LIMIT $1`, [o.limit ?? 50])).rows;
  for (const r of rows) {
    if (!r.located) { out.waitingForLocation++; continue; }
    const upd = await pool.query(`UPDATE incidents SET publication_status = 'published', verification_status = 'reported_by_official', verification_note = $2
      WHERE id = $1 AND publication_status = 'draft' AND last_reviewed_at IS NULL AND location IS NOT NULL`, [r.id, AUTO_NOTE]);
    if (upd.rowCount) { await pool.query(`INSERT INTO audit_events (action, entity_type, entity_id, after) VALUES ('incident.auto_publish','incident',$1,$2)`, [r.id, JSON.stringify({ note: 'published automatically, no human review' })]); out.published++; }
  }
  return out;
}

/** The undo button: takes every still-unedited automatic incident off the public map and marks it as touched so automation will not republish it. */
export async function revokeAutoPublished(pool: pg.Pool) {
  const { rows } = await pool.query(`UPDATE incidents i SET publication_status = 'draft', verification_status = 'pending_review', verification_note = '', last_reviewed_at = now()
    WHERE i.publication_status = 'published' AND i.last_reviewed_at IS NULL AND i.verification_note = $1
      AND EXISTS (SELECT 1 FROM audit_events a WHERE a.action = 'incident.auto_publish' AND a.entity_type = 'incident' AND a.entity_id = i.id::text) RETURNING i.id`, [AUTO_NOTE]);
  if (rows.length) await pool.query(`INSERT INTO audit_events (action, entity_type, entity_id) SELECT 'incident.auto_revoke', 'incident', unnest($1::text[])`, [rows.map((r) => r.id)]);
  return rows.length;
}
