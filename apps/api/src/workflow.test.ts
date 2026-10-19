import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from './app';
import { makePool, migrate } from './db';
import { hashPassword } from './auth';
import { importRecords, parseImport } from './ingest/import';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
let pool: pg.Pool; let app: ReturnType<typeof createApp>; let token = ''; let docId = 0;
const rec = (n: number, o: object = {}) => ({ sourceSlug: 'w-src', url: `https://example.org/import/${n}`, title: `Import doc ${n}`, headline: `Import headline number ${n}`, summary: 'Imported fixture summary text.', categoryCode: 'theft',
  eventDate: '2026-10-01T10:00:00+05:30', locality: 'Sitabuldi', ...o });
const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
const auth = () => ({ Authorization: `Bearer ${token}` });
async function candidate(o: object = {}) {
  const d = (await pool.query(`INSERT INTO source_documents (source_id, canonical_url, title) VALUES ((SELECT id FROM sources WHERE slug='w-src'), $1, 'cand doc') RETURNING id`, [`https://example.org/cand/${Math.random()}`])).rows[0].id;
  const payload = { kind: 'new_incident', headline: 'Chain snatching reported near Dharampeth square', categoryCode: 'robbery_burglary', summary: 'A chain snatching was reported near the square.', eventDate: '2026-10-05T05:00:00Z', locality: 'Dharampeth', extractionConfidence: 'low', ...o };
  return (await pool.query(`INSERT INTO extraction_candidates (document_id, kind, payload) VALUES ($1,$2,$3) RETURNING id`, [d, (payload as any).kind, JSON.stringify(payload)])).rows[0].id as number;
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_workflow_test WITH (FORCE)'); await admin.query('CREATE DATABASE crimelens_workflow_test'); await admin.end();
  pool = makePool(`${BASE}/crimelens_workflow_test`); await migrate(pool);
  await pool.query(`INSERT INTO areas (city_id,name,kind) VALUES (1,'Sitabuldi','locality'),(1,'Dharampeth','locality'),(1,'Alpha Area','locality')`);
  await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status) VALUES ('w-src','W','news','https://example.org/w','manual_import','manual_import')`);
  await pool.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('rev@example.org',$1,'reviewer')`, [hashPassword('reviewer-password-123')]);
  app = createApp(pool, { jwtSecret: 'test-secret-test-secret-test-secret-123', rateLimitPerMinute: 10_000, loginLimit: 50, connectors: [] });
  token = (await request(app).post('/api/admin/login').send({ email: 'rev@example.org', password: 'reviewer-password-123' })).body.token;
});
afterAll(async () => { await pool?.end(); });

describe('CSV/JSON import', () => {
  it('creates unpublished drafts only; bad rows are reported and never block good ones', async () => {
    const rows = [rec(1, { lat: 21.15, lng: 79.09, precision: 'street' }), rec(2, { categoryCode: 'women_children', lat: 21.15, lng: 79.09, precision: 'street' }), rec(3, { lat: 21.15 }),
      rec(4, { sourceSlug: 'nope' }), rec(5, { categoryCode: 'women_children', lat: 21.14, lng: 79.08, precision: 'neighbourhood' }), { headline: 'x' }];
    const r = await importRecords(pool, rows);
    expect(r.created).toBe(2); expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 6]);
    expect(r.errors[0].message).toMatch(/sensitive categories/); expect(r.errors[2].message).toMatch(/unknown sourceSlug/);
    const inc = (await pool.query(`SELECT publication_status, verification_status, location_precision FROM incidents ORDER BY created_at`)).rows;
    expect(inc).toEqual([{ publication_status: 'draft', verification_status: 'pending_review', location_precision: 'street' }, { publication_status: 'draft', verification_status: 'pending_review', location_precision: 'neighbourhood' }]);
    expect((await request(app).get('/api/incidents')).body.total).toBe(0);   // nothing is public until reviewed
    expect(await count('incident_sources')).toBe(2);
  });
  it('is repeatable: re-importing creates no duplicates', async () => {
    const r = await importRecords(pool, [rec(1), rec(5)]);
    expect(r).toMatchObject({ created: 0, skippedDuplicates: 2 }); expect(await count('incidents')).toBe(2);
    expect((await importRecords(pool, [rec(1, { url: 'http://WWW.example.org/import/1/?utm_source=x' })])).skippedDuplicates).toBe(1);   // same URL after normalisation
  });
  it('dry run validates and counts but writes nothing', async () => {
    const r = await importRecords(pool, [rec(10)], { dryRun: true }); expect(r.created).toBe(1);
    expect(await count('incidents')).toBe(2); expect(await count('source_documents')).toBe(2);
  });
  it('reads CSV with empty cells and coerces coordinates', async () => {
    const csv = 'sourceSlug,url,title,headline,summary,categoryCode,eventDate,locality,lat,lng,precision\nw-src,https://example.org/csv/1,CSV doc,CSV headline here,CSV fixture summary text.,theft,,Alpha Area,21.15,79.09,neighbourhood\n';
    const r = await importRecords(pool, parseImport(csv, 'csv')); expect(r).toMatchObject({ created: 1, errors: [] });
    expect((await pool.query(`SELECT ST_Y(location::geometry) AS lat, event_start FROM incidents WHERE headline='CSV headline here'`)).rows[0]).toEqual({ lat: 21.15, event_start: null });
  });
});

describe('candidate review workflow', () => {
  const accept = (id: number, body: object = {}) => request(app).post(`/api/admin/candidates/${id}/accept`).set(auth()).send(body);
  it('requires authentication and lists pending candidates', async () => {
    const id = await candidate();
    expect((await request(app).get('/api/admin/candidates')).status).toBe(401);
    expect((await request(app).get('/api/admin/candidates').set(auth())).body.items.map((x: any) => x.id)).toContain(id);
  });
  it('accepting creates a draft incident with no invented location, and cannot be repeated', async () => {
    const id = await candidate(); const r = await accept(id); expect(r.body.status).toBe('accepted');
    expect((await pool.query(`SELECT publication_status, location_precision, location IS NULL AS no_loc, area_id IS NOT NULL AS has_area FROM incidents WHERE id=$1`, [r.body.incidentId])).rows[0])
      .toEqual({ publication_status: 'draft', location_precision: 'unknown', no_loc: true, has_area: true });
    expect((await accept(id)).status).toBe(409);
    expect((await pool.query(`SELECT action FROM audit_events WHERE entity_id=$1`, [String(id)])).rows[0].action).toBe('candidate.accept');
  });
  it('blocks likely duplicates until the reviewer merges or confirms they are distinct', async () => {
    const first = await accept(await candidate({ headline: 'Two-wheeler stolen near Sitabuldi market', locality: 'Sitabuldi', eventDate: '2026-10-09T03:00:00Z', categoryCode: 'theft' }));
    const dup = await candidate({ headline: 'Two-wheeler stolen near Sitabuldi market area', locality: 'Sitabuldi', eventDate: '2026-10-09T05:00:00Z', categoryCode: 'theft' });
    const blocked = await accept(dup); expect(blocked.status).toBe(409); expect(blocked.body).toMatchObject({ error: 'possible_duplicate' }); expect(blocked.body.matches[0].id).toBe(first.body.incidentId);
    const merged = await accept(dup, { mergeIntoIncidentId: first.body.incidentId }); expect(merged.body.status).toBe('merged');
    expect((await pool.query(`SELECT role FROM incident_sources WHERE incident_id=$1 ORDER BY role`, [first.body.incidentId])).rows.map((x) => x.role)).toEqual(['corroboration', 'primary']);
    const dup2 = await candidate({ headline: 'Two-wheeler stolen near Sitabuldi market again', locality: 'Sitabuldi', eventDate: '2026-10-09T06:00:00Z', categoryCode: 'theft' });
    expect((await accept(dup2, { confirmDistinct: true })).body.status).toBe('accepted');
  });
  it('updates must merge; opinion/unrelated candidates cannot be accepted; reject records a reason', async () => {
    expect((await accept(await candidate({ kind: 'update' }))).body.error).toBe('update_requires_merge');
    const op = await candidate({ kind: 'opinion' }); expect((await accept(op)).body.error).toBe('not_an_incident');
    expect((await request(app).post(`/api/admin/candidates/${op}/reject`).set(auth()).send({ reason: 'Opinion piece, not an incident.' })).body.status).toBe('rejected');
    expect((await pool.query(`SELECT after FROM audit_events WHERE action='candidate.reject'`)).rows[0].after.reason).toMatch(/Opinion/);
    const target = (await pool.query(`SELECT id FROM incidents LIMIT 1`)).rows[0].id;
    const upd = await candidate({ kind: 'update', summary: 'Police later reported an arrest in the case.' });
    expect((await accept(upd, { mergeIntoIncidentId: target })).body.status).toBe('merged');
    expect((await pool.query(`SELECT kind, summary FROM incident_updates WHERE incident_id=$1`, [target])).rows[0]).toEqual({ kind: 'development', summary: 'Police later reported an arrest in the case.' });
  });
  it('rejects a stored payload that no longer validates', async () => {
    const id = await candidate({ extractionConfidence: 0.9 }); expect((await accept(id)).status).toBe(400);
  });
});
