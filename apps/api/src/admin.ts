import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type pg from 'pg';
import { z } from 'zod';
import { CATEGORY_CODES, VERIFICATION_STATUSES } from '@crimelens/shared';
import { DUMMY_HASH, requireRole, signToken, verifyPassword, type Actor } from './auth';
import { HttpError } from './errors';
import { runPipeline } from './ingest/pipeline';
import type { ExtractionAdapter } from './ingest/extract';
import type { Geocoder } from './ingest/geocode';
import type { Connector } from './ingest/types';
import { compareCandidates } from './ingest/extract';
import { insertDraftIncident } from './ingest/promote';
import { IncidentCandidateSchema } from '@crimelens/shared';
import { FROM_SQL, SELECT_INCIDENT, toDTO } from './query';

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const Uuid = z.string().uuid();
const note = z.string().trim().min(10).max(1000);
const actorOf = (req: express.Request) => (req as any).actor as Actor;

async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const audit = (c: pg.PoolClient, actor: string, action: string, type: string, id: string, before: unknown, after: unknown) =>
  c.query('INSERT INTO audit_events (actor_id, action, entity_type, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)', [actor, action, type, id, JSON.stringify(before), JSON.stringify(after)]);
const SNAP = 'id, headline, summary, category_code, verification_status, verification_note, publication_status';
async function lockIncident(c: pg.PoolClient, id: string) {
  const r = (await c.query(`SELECT ${SNAP} FROM incidents WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'not_found'); return r;
}

export function adminRouter(pool: pg.Pool, o: { secret?: string; connectors: Connector[]; loginLimit: number; extractor: ExtractionAdapter | null; geocoder: Geocoder | null }) {
  const r = express.Router();
  const any = requireRole(pool, o.secret, ['admin', 'reviewer']), adminOnly = requireRole(pool, o.secret, ['admin']);

  r.post('/login', rateLimit({ windowMs: 15 * 60_000, limit: o.loginLimit, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
    if (!o.secret || o.secret.length < 32) return void res.status(503).json({ error: 'admin_not_configured' });
    const b = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).strict().parse(req.body);
    const u = (await pool.query('SELECT id, password_hash, role FROM admin_users WHERE email = $1 AND disabled_at IS NULL', [b.email.toLowerCase()])).rows[0];
    const ok = verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH) && !!u;   // same work whether or not the user exists
    if (!ok) return void res.status(401).json({ error: 'invalid_credentials' });
    await tx(pool, (c) => audit(c, u.id, 'admin.login', 'admin_user', u.id, null, null));
    res.json({ token: signToken(o.secret, { id: u.id, role: u.role }), role: u.role });
  }));

  r.get('/ingestion-runs', any, wrap(async (req, res) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(req.query);
    const { rows } = await pool.query(`SELECT r.id, s.slug, r.started_at, r.finished_at, r.outcome, r.attempt, r.items_found, r.items_new, r.items_updated, r.triggered_by, r.error
      FROM source_fetch_runs r JOIN sources s ON s.id = r.source_id ORDER BY r.started_at DESC, r.id DESC LIMIT $1 OFFSET $2`, [q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ items: rows.map((x) => ({ id: x.id, source: x.slug, startedAt: x.started_at, finishedAt: x.finished_at, outcome: x.outcome, attempts: x.attempt, found: x.items_found, created: x.items_new, updated: x.items_updated, triggeredBy: x.triggered_by, error: x.error })), page: q.page });
  }));

  r.post('/ingest', adminOnly, wrap(async (req, res) => {
    const b = z.object({ slug: z.string().max(80).optional() }).strict().parse(req.body ?? {});
    const list = o.connectors.filter((c) => !b.slug || c.slug === b.slug);
    if (!list.length) throw new HttpError(404, 'unknown_source');
    const out = await runPipeline(pool, list, {}, o.extractor, 'manual', o.geocoder);
    await tx(pool, (c) => audit(c, actorOf(req).id, 'ingest.manual', 'source', b.slug ?? 'all', null, out));
    res.json(out);
  }));

  r.post('/incidents/:id/review', any, wrap(async (req, res) => {
    const id = Uuid.parse(req.params.id);
    const b = z.object({ status: z.enum(VERIFICATION_STATUSES).exclude(['archived']), explanation: note, publish: z.boolean().optional() }).strict().parse(req.body);
    const out = await tx(pool, async (c) => {
      const before = await lockIncident(c, id);
      const ev = (await c.query(`SELECT count(DISTINCT src.id)::int AS n, COALESCE(bool_or(src.type IN ('official_police','official_dataset')), false) AS official, COALESCE(bool_or(src.type = 'news'), false) AS news
        FROM incident_sources x JOIN source_documents d ON d.id = x.document_id JOIN sources src ON src.id = d.source_id WHERE x.incident_id = $1`, [id])).rows[0];
      // A status may only claim what the linked evidence supports.
      const need = (b.status === 'corroborated' && ev.n < 2 && 'needs two or more independent sources')
        || (b.status === 'reported_by_official' && !ev.official && 'needs a linked official source')
        || (b.status === 'reported_by_news' && !ev.news && 'needs a linked news source')
        || (b.publish && ev.n < 1 && 'cannot publish an incident with no linked source');
      if (need) throw new HttpError(409, 'insufficient_evidence', need);
      const after = (await c.query(`UPDATE incidents SET verification_status=$2, verification_note=$3, last_reviewed_at=now(), publication_status = CASE WHEN $4 THEN 'published' ELSE publication_status END WHERE id=$1 RETURNING ${SNAP}`, [id, b.status, b.explanation, !!b.publish])).rows[0];
      await c.query('INSERT INTO verification_reviews (incident_id, reviewer_id, from_status, to_status, explanation) VALUES ($1,$2,$3,$4,$5)', [id, actorOf(req).id, before.verification_status, b.status, b.explanation]);
      await audit(c, actorOf(req).id, 'incident.review', 'incident', id, before, after);
      return after;
    });
    res.json({ id, verificationStatus: out.verification_status, publicationStatus: out.publication_status });
  }));

  r.post('/incidents/:id/correct', any, wrap(async (req, res) => {
    const id = Uuid.parse(req.params.id);
    const b = z.object({ headline: z.string().trim().min(5).max(200).optional(), summary: z.string().trim().min(10).max(800).optional(), categoryCode: z.enum(CATEGORY_CODES).optional(), note })
      .strict().refine((v) => v.headline || v.summary || v.categoryCode, 'nothing to correct').parse(req.body);
    const out = await tx(pool, async (c) => {
      const before = await lockIncident(c, id);
      const after = (await c.query(`UPDATE incidents SET headline=COALESCE($2,headline), summary=COALESCE($3,summary), category_code=COALESCE($4,category_code), verification_status='corrected', last_reviewed_at=now() WHERE id=$1 RETURNING ${SNAP}`,
        [id, b.headline ?? null, b.summary ?? null, b.categoryCode ?? null])).rows[0];
      await c.query(`INSERT INTO incident_updates (incident_id, occurred_at, kind, summary) VALUES ($1, now(), 'correction', $2)`, [id, b.note]);
      await c.query('INSERT INTO verification_reviews (incident_id, reviewer_id, from_status, to_status, explanation) VALUES ($1,$2,$3,$4,$5)', [id, actorOf(req).id, before.verification_status, 'corrected', b.note]);
      await audit(c, actorOf(req).id, 'incident.correct', 'incident', id, before, after);
      return after;
    });
    res.json({ id, verificationStatus: out.verification_status });
  }));

  /** Merges a duplicate record into another incident: its source links and timeline move across, and the duplicate is archived (never deleted). */
  r.post('/incidents/:id/merge', any, wrap(async (req, res) => {
    const id = Uuid.parse(req.params.id);
    const b = z.object({ intoIncidentId: Uuid, reason: note }).strict().parse(req.body);
    if (b.intoIncidentId === id) throw new HttpError(400, 'cannot_merge_into_itself');
    const moved = await tx(pool, async (c) => {
      const rows = (await c.query(`SELECT ${SNAP} FROM incidents WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[id, b.intoIncidentId]])).rows;   // stable lock order
      const src = rows.find((x) => x.id === id), dst = rows.find((x) => x.id === b.intoIncidentId);
      if (!src || !dst) throw new HttpError(404, 'not_found');
      if (!['draft', 'published'].includes(src.publication_status)) throw new HttpError(409, 'source_not_active');
      if (!['draft', 'published'].includes(dst.publication_status)) throw new HttpError(409, 'target_not_active');
      const m = await c.query(`UPDATE incident_sources SET incident_id = $2, role = CASE WHEN role = 'primary' THEN 'corroboration' ELSE role END
        WHERE incident_id = $1 AND document_id NOT IN (SELECT document_id FROM incident_sources WHERE incident_id = $2)`, [id, b.intoIncidentId]);
      await c.query('DELETE FROM incident_sources WHERE incident_id = $1', [id]);
      await c.query('UPDATE incident_updates SET incident_id = $2 WHERE incident_id = $1', [id, b.intoIncidentId]);
      await c.query(`INSERT INTO incident_updates (incident_id, occurred_at, kind, summary) VALUES ($1, now(), 'note', 'A duplicate record was merged into this incident.')`, [b.intoIncidentId]);   // fixed public wording; the reviewer's reason stays internal
      const after = (await c.query(`UPDATE incidents SET publication_status='archived', verification_status='archived', verification_note=$2, last_reviewed_at=now() WHERE id=$1 RETURNING ${SNAP}`, [id, `Merged into incident ${b.intoIncidentId}: ${b.reason}`])).rows[0];
      await audit(c, actorOf(req).id, 'incident.merge', 'incident', id, { source: src, target: dst }, { source: after, targetId: dst.id, sourcesMoved: m.rowCount });
      return m.rowCount;
    });
    res.json({ id, mergedInto: b.intoIncidentId, publicationStatus: 'archived', sourcesMoved: moved });
  }));

  r.post('/incidents/:id/archive', any, wrap(async (req, res) => {
    const id = Uuid.parse(req.params.id);
    const b = z.object({ reason: note, remove: z.boolean().optional() }).strict().parse(req.body);
    if (b.remove && actorOf(req).role !== 'admin') throw new HttpError(403, 'forbidden');   // only admins may remove outright
    await tx(pool, async (c) => {
      const before = await lockIncident(c, id);
      const after = (await c.query(`UPDATE incidents SET publication_status=$2, verification_status='archived', verification_note=$3, last_reviewed_at=now() WHERE id=$1 RETURNING ${SNAP}`, [id, b.remove ? 'removed' : 'archived', b.reason])).rows[0];
      await audit(c, actorOf(req).id, b.remove ? 'incident.remove' : 'incident.archive', 'incident', id, before, after);
    });
    res.json({ id, publicationStatus: b.remove ? 'removed' : 'archived' });
  }));
  /** Lists incidents by publication status (default: drafts) so reviewers can see what is waiting. Public endpoints never show these. */
  r.get('/incidents', any, wrap(async (req, res) => {
    const q = z.object({ status: z.enum(['draft', 'published', 'archived', 'removed']).default('draft'), page: z.coerce.number().int().min(1).default(1) }).strict().parse(req.query);
    const { rows } = await pool.query(`${SELECT_INCIDENT}, i.publication_status, COUNT(*) OVER() AS total ${FROM_SQL} WHERE i.publication_status = $1 ORDER BY i.created_at DESC, i.id LIMIT 25 OFFSET $2`, [q.status, (q.page - 1) * 25]);
    res.json({ items: rows.map((x) => ({ ...toDTO(x), publicationStatus: x.publication_status })), total: rows.length ? Number(rows[0].total) : 0, page: q.page });
  }));

  r.get('/candidates', any, wrap(async (req, res) => {
    const q = z.object({ status: z.enum(['pending_review', 'accepted', 'rejected', 'merged']).default('pending_review'), page: z.coerce.number().int().min(1).default(1) }).strict().parse(req.query);
    const { rows } = await pool.query(`SELECT ec.id, ec.kind, ec.status, ec.payload, ec.created_at, d.title, d.canonical_url FROM extraction_candidates ec JOIN source_documents d ON d.id = ec.document_id
      WHERE ec.status = $1 ORDER BY ec.id LIMIT 50 OFFSET $2`, [q.status, (q.page - 1) * 50]);
    res.json({ items: rows.map((x) => ({ id: x.id, kind: x.kind, status: x.status, candidate: x.payload, document: { title: x.title, url: x.canonical_url }, createdAt: x.created_at })) });
  }));

  r.post('/candidates/:id/reject', any, wrap(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id); const b = z.object({ reason: note }).strict().parse(req.body);
    await tx(pool, async (c) => {
      const cur = (await c.query('SELECT status FROM extraction_candidates WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found'); if (cur.status !== 'pending_review') throw new HttpError(409, 'already_resolved');
      await c.query(`UPDATE extraction_candidates SET status = 'rejected' WHERE id = $1`, [id]);
      await audit(c, actorOf(req).id, 'candidate.reject', 'candidate', String(id), { status: cur.status }, { status: 'rejected', reason: b.reason });
    });
    res.json({ id, status: 'rejected' });
  }));

  /** Accept = create a DRAFT incident, or merge into an existing one. Likely duplicates must be resolved explicitly. */
  r.post('/candidates/:id/accept', any, wrap(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = z.object({ mergeIntoIncidentId: Uuid.optional(), confirmDistinct: z.boolean().optional() }).strict().parse(req.body ?? {});
    const out = await tx(pool, async (c) => {
      const cand = (await c.query('SELECT id, kind, status, payload, document_id FROM extraction_candidates WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cand) throw new HttpError(404, 'not_found'); if (cand.status !== 'pending_review') throw new HttpError(409, 'already_resolved');
      if (cand.kind !== 'new_incident' && cand.kind !== 'update') throw new HttpError(400, 'not_an_incident', 'Reject candidates that are opinion, historical or unrelated.');
      if (cand.kind === 'update' && !b.mergeIntoIncidentId) throw new HttpError(400, 'update_requires_merge');
      const p = IncidentCandidateSchema.parse(cand.payload);   // re-validated; stored text is still untrusted
      if (b.mergeIntoIncidentId) {
        await lockIncident(c, b.mergeIntoIncidentId);
        await c.query(`INSERT INTO incident_sources (incident_id, document_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [b.mergeIntoIncidentId, cand.document_id, cand.kind === 'update' ? 'update' : 'corroboration']);
        if (cand.kind === 'update') await c.query(`INSERT INTO incident_updates (incident_id, occurred_at, kind, summary, document_id) VALUES ($1,$2,'development',$3,$4)`, [b.mergeIntoIncidentId, p.eventDate, p.summary, cand.document_id]);
        await c.query(`UPDATE extraction_candidates SET status = 'merged' WHERE id = $1`, [id]);
        await audit(c, actorOf(req).id, 'candidate.merge', 'candidate', String(id), { status: 'pending_review' }, { status: 'merged', incidentId: b.mergeIntoIncidentId });
        return { status: 'merged', incidentId: b.mergeIntoIncidentId };
      }
      const existing = (await c.query(`SELECT i.id, i.headline, i.event_start, COALESCE(a.name, i.locality_text) AS locality FROM incidents i LEFT JOIN areas a ON a.id = i.area_id
        WHERE i.city_id = (SELECT id FROM cities WHERE slug = 'nagpur') AND i.publication_status IN ('draft','published')
          AND ($1::timestamptz IS NULL OR i.event_start IS NULL OR abs(extract(epoch FROM i.event_start - $1::timestamptz)) < 3 * 86400)
        ORDER BY i.created_at DESC LIMIT 200`, [p.eventDate])).rows;
      const matches = existing.map((e) => ({ id: e.id, headline: e.headline, match: compareCandidates({ headline: p.headline, eventDate: p.eventDate, locality: p.locality },
        { headline: e.headline, eventDate: e.event_start ? new Date(e.event_start).toISOString() : null, locality: e.locality }) })).filter((m) => m.match !== 'distinct');
      if (matches.length && !b.confirmDistinct) throw new HttpError(409, 'possible_duplicate', 'Merge into a listed incident, or resend with confirmDistinct:true.', { matches });
      const incidentId = await insertDraftIncident(c, { citySlug: 'nagpur', categoryCode: p.categoryCode, headline: p.headline, summary: p.summary, eventStart: p.eventDate, locality: p.locality, documentId: cand.document_id, role: 'primary' });
      await c.query(`UPDATE extraction_candidates SET status = 'accepted' WHERE id = $1`, [id]);
      await audit(c, actorOf(req).id, 'candidate.accept', 'candidate', String(id), { status: 'pending_review' }, { status: 'accepted', incidentId });
      return { status: 'accepted', incidentId };
    });
    res.json({ id, ...out });
  }));
  return r;
}
