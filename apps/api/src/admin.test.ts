import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp } from './app';
import { makePool, migrate } from './db';
import { hashPassword } from './auth';
import type { Connector } from './ingest/types';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
const SECRET = 'test-secret-test-secret-test-secret-123';
let pool: pg.Pool; let app: ReturnType<typeof createApp>; const T: Record<string, string> = {}; const I: Record<string, string> = {};
const docs: number[] = [];
const auth = (who: string) => ({ Authorization: `Bearer ${T[who]}` });

async function mk(key: string, o: { cat?: string; status?: string; link?: number[]; event?: string; area?: boolean } = {}) {
  const { rows } = await pool.query(`INSERT INTO incidents (city_id,category_code,headline,summary,event_start,area_id,verification_status,publication_status)
    VALUES (1,$1,$2,'Fixture summary text here.',$3,${o.area === false ? 'NULL' : `(SELECT id FROM areas WHERE name='Beta Area')`},'pending_review',$4) RETURNING id`,
    [o.cat ?? 'theft', `Fixture ${key}`, o.event ?? null, o.status ?? 'draft']);
  I[key] = rows[0].id;
  for (const d of o.link ?? []) await pool.query(`INSERT INTO incident_sources (incident_id,document_id,role) VALUES ($1,$2,'primary')`, [rows[0].id, docs[d]]);
}
const login = async (email: string, password: string) => request(app).post('/api/admin/login').send({ email, password });

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_admin_test WITH (FORCE)'); await admin.query('CREATE DATABASE crimelens_admin_test'); await admin.end();
  pool = makePool(`${BASE}/crimelens_admin_test`); await migrate(pool);
  await pool.query(`INSERT INTO areas (city_id,name,kind) VALUES (1,'Beta Area','locality'),(1,'Alpha Area','locality')`);
  await pool.query(`INSERT INTO admin_users (email,password_hash,role) VALUES ('boss@example.org',$1,'admin'),('rev@example.org',$2,'reviewer'),('gone@example.org',$2,'reviewer')`, [hashPassword('admin-password-123'), hashPassword('reviewer-password-123')]);
  await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status,enabled,robots_checked_at) VALUES
    ('x-police','Police X','official_police','https://example.org/p','html_listing','connected',true,now()),
    ('x-news','News X','news','https://example.org/n','rss','connected',true,now()),
    ('x-fake','Fake','news','https://example.org/f','rss','connected',true,now())`);
  for (const [s, u] of [['x-police', 'p1'], ['x-news', 'n1'], ['x-news', 'n2']])
    docs.push((await pool.query(`INSERT INTO source_documents (source_id,canonical_url,title) VALUES ((SELECT id FROM sources WHERE slug=$1),$2,$2) RETURNING id`, [s, `https://example.org/${u}`])).rows[0].id);
  await mk('multi', { link: [0, 1], status: 'published', cat: 'theft', event: '2026-10-09T20:00:00Z' });   // 2 sources, 3 docs overall with 'solo'
  await mk('solo', { link: [2], status: 'published', cat: 'assault', event: '2026-10-09T03:00:00Z', area: false });
  await mk('draftLinked', { link: [1] }); await mk('draftBare'); await mk('toEdit', { link: [0], status: 'published' }); await mk('toArchive', { status: 'published' }); await mk('toRemove', { status: 'published' });
  const fake: Connector = { slug: 'x-fake', fetchItems: async () => [{ canonicalUrl: 'https://example.org/fake/1', externalId: '1', title: 'Pressnote fake', publishedAt: null, language: null, bodyText: null, incidentBearing: true }] };
  app = createApp(pool, { jwtSecret: SECRET, connectors: [fake], rateLimitPerMinute: 10_000, loginLimit: 50 });
  T.admin = (await login('boss@example.org', 'admin-password-123')).body.token; T.rev = (await login('rev@example.org', 'reviewer-password-123')).body.token; T.gone = (await login('gone@example.org', 'reviewer-password-123')).body.token;
});
afterAll(async () => { await pool?.end(); });

describe('authentication and roles', () => {
  it('rejects every admin route without a valid token', async () => {
    for (const [m, u] of [['get', '/api/admin/ingestion-runs'], ['post', '/api/admin/ingest'], ['post', `/api/admin/incidents/${I.multi}/review`], ['post', `/api/admin/incidents/${I.multi}/correct`], ['post', `/api/admin/incidents/${I.multi}/archive`]] as const) {
      expect((await (request(app) as any)[m](u)).status, u).toBe(401);
      expect((await (request(app) as any)[m](u).set('Authorization', 'Bearer garbage')).status, u).toBe(401);
    }
  });
  it('gives the same generic answer for a wrong password and an unknown user', async () => {
    const a = await login('boss@example.org', 'wrong-password-xx'), b = await login('nobody@example.org', 'whatever-password');
    expect([a.status, b.status]).toEqual([401, 401]); expect(a.body).toEqual(b.body); expect(a.body).toEqual({ error: 'invalid_credentials' });
  });
  it('rejects forged and unsigned tokens', async () => {
    const forged = jwt.sign({}, 'some-other-secret-some-other-secret-0', { subject: '00000000-0000-0000-0000-000000000000', issuer: 'crimelens' });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"x","iss":"crimelens"}').toString('base64url')}.`;
    for (const t of [forged, none]) expect((await request(app).get('/api/admin/ingestion-runs').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });
  it('is disabled (503) when no strong secret is configured', async () => {
    expect((await request(createApp(pool, { jwtSecret: 'short' })).post('/api/admin/login').send({ email: 'boss@example.org', password: 'x' })).status).toBe(503);
  });
  it('reviewers cannot ingest or remove; role changes apply immediately', async () => {
    expect((await request(app).post('/api/admin/ingest').set(auth('rev')).send({})).status).toBe(403);
    expect((await request(app).post(`/api/admin/incidents/${I.toRemove}/archive`).set(auth('rev')).send({ reason: 'taken down by mistake', remove: true })).status).toBe(403);
    await pool.query(`UPDATE admin_users SET disabled_at = now() WHERE email='gone@example.org'`);   // existing token stops working at once
    expect((await request(app).get('/api/admin/ingestion-runs').set(auth('gone'))).status).toBe(401);
    expect((await login('gone@example.org', 'reviewer-password-123')).status).toBe(401);
    await pool.query(`UPDATE admin_users SET role='reviewer' WHERE email='boss@example.org'`);       // demotion applies to the same token
    expect((await request(app).post('/api/admin/ingest').set(auth('admin')).send({})).status).toBe(403);
    await pool.query(`UPDATE admin_users SET role='admin' WHERE email='boss@example.org'`);
  });
});

describe('review, correction and archive', () => {
  const review = (id: string, body: object, who = 'rev') => request(app).post(`/api/admin/incidents/${id}/review`).set(auth(who)).send(body);
  it('validates bodies strictly', async () => {
    for (const b of [{ status: 'disputed', explanation: 'short' }, { status: 'archived', explanation: 'long enough text' }, { status: 'disputed', explanation: 'long enough text', extra: 1 }, { status: 'bogus', explanation: 'long enough text' }])
      expect((await review(I.multi, b)).status, JSON.stringify(b)).toBe(400);
    expect((await review('not-a-uuid', { status: 'disputed', explanation: 'long enough text' })).status).toBe(400);
  });
  it('refuses statuses the linked evidence cannot support', async () => {
    expect((await review(I.draftLinked, { status: 'corroborated', explanation: 'two outlets reported it' })).body).toMatchObject({ error: 'insufficient_evidence' });
    expect((await review(I.draftLinked, { status: 'reported_by_official', explanation: 'police said so, apparently' })).status).toBe(409);
    expect((await review(I.draftBare, { status: 'reported_by_news', explanation: 'no source is linked yet', publish: true })).status).toBe(409);
  });
  it('records review, audit trail with before/after, and publishes only on request', async () => {
    const r = await review(I.draftLinked, { status: 'reported_by_news', explanation: 'Checked the linked news report.', publish: true });
    expect(r.body).toMatchObject({ verificationStatus: 'reported_by_news', publicationStatus: 'published' });
    expect((await request(app).get(`/api/incidents/${I.draftLinked}`)).status).toBe(200);
    expect((await pool.query('SELECT from_status, to_status FROM verification_reviews WHERE incident_id=$1', [I.draftLinked])).rows).toEqual([{ from_status: 'pending_review', to_status: 'reported_by_news' }]);
    const a = (await pool.query(`SELECT action, before, after FROM audit_events WHERE entity_id=$1`, [I.draftLinked])).rows[0];
    expect(a.action).toBe('incident.review'); expect(a.before.publication_status).toBe('draft'); expect(a.after.publication_status).toBe('published');
    expect((await review(I.multi, { status: 'corroborated', explanation: 'Police and news agree.' })).status).toBe(200);
  });
  it('correction updates fields, adds a visible correction entry and an audit record', async () => {
    const r = await request(app).post(`/api/admin/incidents/${I.toEdit}/correct`).set(auth('rev')).send({ headline: 'Corrected headline text', note: 'Category and headline were wrong.' });
    expect(r.body.verificationStatus).toBe('corrected');
    expect((await request(app).get(`/api/incidents/${I.toEdit}/timeline`)).body.items[0]).toMatchObject({ kind: 'correction', summary: 'Category and headline were wrong.' });
    expect((await pool.query(`SELECT before FROM audit_events WHERE entity_id=$1 AND action='incident.correct'`, [I.toEdit])).rows[0].before.headline).toBe('Fixture toEdit');
    expect((await request(app).post(`/api/admin/incidents/${I.toEdit}/correct`).set(auth('rev')).send({ note: 'nothing changed here at all' })).status).toBe(400);
  });
  it('archived and removed incidents leave the public API; removal is admin-only', async () => {
    expect((await request(app).post(`/api/admin/incidents/${I.toArchive}/archive`).set(auth('rev')).send({ reason: 'Outdated, superseded by newer report.' })).status).toBe(200);
    expect((await request(app).get(`/api/incidents/${I.toArchive}`)).status).toBe(404);
    expect((await request(app).post(`/api/admin/incidents/${I.toRemove}/archive`).set(auth('admin')).send({ reason: 'Inaccurate record, removed.', remove: true })).body.publicationStatus).toBe('removed');
    expect((await request(app).get(`/api/incidents/${I.toRemove}`)).status).toBe(404);
    expect((await pool.query(`SELECT action FROM audit_events WHERE entity_id=$1`, [I.toRemove])).rows[0].action).toBe('incident.remove');
  });
});

describe('manual ingestion and run history', () => {
  it('admin can trigger a run; it is audited and visible in history without stack traces', async () => {
    const r = await request(app).post('/api/admin/ingest').set(auth('admin')).send({ slug: 'x-fake' });
    expect(r.body.results[0]).toMatchObject({ outcome: 'success', created: 1 });
    expect((await request(app).post('/api/admin/ingest').set(auth('admin')).send({ slug: 'nope' })).status).toBe(404);
    const runs = (await request(app).get('/api/admin/ingestion-runs').set(auth('rev'))).body.items;
    expect(runs[0]).toMatchObject({ source: 'x-fake', triggeredBy: 'manual', outcome: 'success', error: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='ingest.manual'`)).rows[0].n).toBe(1);
  });
});

describe('analytics integrity', () => {
  const get = (p: string) => request(app).get(`/api/analytics/${p}`);
  it('separates incidents from collected reports and states provenance, period and caveats', async () => {
    const { body } = await get('summary?from=2026-10-01&to=2026-10-31');
    expect(body.data.incidents).toBe(2); expect(body.data.sourceDocumentsLinked).toBe(3);   // 2 incidents, 3 linked reports
    expect(body.provenance).toMatchObject({ kind: 'collected_reports', period: { from: '2026-10-01', to: '2026-10-31', dateBasis: 'event_date' } });
    expect(body.officialStatistics.available).toBe(false); expect(body.caveats.join(' ')).toMatch(/not official crime statistics/); expect(body.caveats.length).toBeGreaterThan(2);
  });
  it('buckets timelines in IST, never ranks areas, and rejects bad input', async () => {
    const t = (await get('timeline?bucket=day&from=2026-10-01&to=2026-10-31')).body;
    expect(t.data).toEqual([{ bucket: '2026-10-09', incidents: 1 }, { bucket: '2026-10-10', incidents: 1 }]);   // 20:00Z on the 9th is 01:30 IST on the 10th
    const a = (await get('areas')).body; expect(a.data.map((x: any) => x.area)).toEqual(['Beta Area', 'Unknown area']); for (const row of a.data) expect(Object.keys(row).sort()).toEqual(['area', 'incidents']);   // counts only: no rank, score or ratio fields
    expect((await get('categories')).body.data.map((x: any) => x.code).sort()).toEqual(['assault', 'theft']);
    expect((await get('timeline?bucket=year')).status).toBe(400); expect((await get("timeline?bucket=day';drop table incidents;--")).status).toBe(400);
  });
});

describe('draft listing for reviewers', () => {
  it('requires a token, lists only the requested publication status, and never leaks drafts publicly', async () => {
    expect((await request(app).get('/api/admin/incidents')).status).toBe(401);
    const drafts = (await request(app).get('/api/admin/incidents').set(auth('rev'))).body;
    expect(drafts.items.map((i: any) => i.id)).toContain(I.draftBare); expect(drafts.items.every((i: any) => i.publicationStatus === 'draft')).toBe(true);
    expect((await request(app).get('/api/incidents?pageSize=100')).body.items.map((i: any) => i.id)).not.toContain(I.draftBare);
    const removed = (await request(app).get('/api/admin/incidents?status=removed').set(auth('rev'))).body;
    expect(removed.items.map((i: any) => i.id)).toContain(I.toRemove);
    expect((await request(app).get('/api/admin/incidents?status=bogus').set(auth('rev'))).status).toBe(400);
  });
});

describe('merging duplicate incidents', () => {
  const merge = (id: string, body: object, who = 'rev') => request(app).post(`/api/admin/incidents/${id}/merge`).set(auth(who)).send(body);
  it('moves sources and timeline into the target, archives the duplicate, and records an audit trail', async () => {
    await mk('mTarget', { link: [0], status: 'published' }); await mk('mDup', { link: [1, 2], status: 'published' });
    await pool.query(`INSERT INTO incident_updates (incident_id, occurred_at, kind, summary) VALUES ($1, now(), 'arrest', 'Arrest reported on the duplicate record.')`, [I.mDup]);
    const r = await merge(I.mDup, { intoIncidentId: I.mTarget, reason: 'Same case reported twice.' });
    expect(r.body).toMatchObject({ mergedInto: I.mTarget, publicationStatus: 'archived', sourcesMoved: 2 });
    const t = (await request(app).get(`/api/incidents/${I.mTarget}`)).body;
    expect(t.sources).toHaveLength(3); expect(t.updates.map((u: any) => u.summary)).toEqual(expect.arrayContaining(['Arrest reported on the duplicate record.', 'A duplicate record was merged into this incident.']));
    expect(JSON.stringify(t)).not.toMatch(/Same case reported twice/);   // the internal reason is not public
    expect((await pool.query(`SELECT role FROM incident_sources WHERE incident_id=$1 AND role='primary'`, [I.mTarget])).rowCount).toBe(1);   // still exactly one primary source
    expect((await request(app).get(`/api/incidents/${I.mDup}`)).status).toBe(404);
    expect((await pool.query(`SELECT verification_note FROM incidents WHERE id=$1`, [I.mDup])).rows[0].verification_note).toMatch(/Merged into incident .*Same case reported twice/);
    expect((await pool.query(`SELECT after FROM audit_events WHERE action='incident.merge' AND entity_id=$1`, [I.mDup])).rows[0].after).toMatchObject({ targetId: I.mTarget, sourcesMoved: 2 });
  });
  it('handles overlapping sources without duplicating links', async () => {
    await mk('oA', { link: [0], status: 'published' }); await mk('oB', { link: [0], status: 'published' });
    expect((await merge(I.oB, { intoIncidentId: I.oA, reason: 'Identical source report.' })).body.sourcesMoved).toBe(0);
    expect((await request(app).get(`/api/incidents/${I.oA}`)).body.sources).toHaveLength(1);
  });
  it('rejects self-merges, inactive records, unknown ids and weak input', async () => {
    await mk('x1', { link: [0], status: 'published' });
    expect((await merge(I.x1, { intoIncidentId: I.x1, reason: 'A reason long enough.' })).body.error).toBe('cannot_merge_into_itself');
    expect((await merge(I.x1, { intoIncidentId: I.toArchive, reason: 'Target is archived already.' })).body.error).toBe('target_not_active');
    expect((await merge(I.toArchive, { intoIncidentId: I.x1, reason: 'Source is archived already.' })).body.error).toBe('source_not_active');
    expect((await merge(I.x1, { intoIncidentId: '00000000-0000-4000-8000-000000000000', reason: 'No such target.' })).status).toBe(404);
    expect((await merge(I.x1, { intoIncidentId: I.multi, reason: 'short' })).status).toBe(400);
    expect((await request(app).post(`/api/admin/incidents/${I.x1}/merge`).send({})).status).toBe(401);
  });
});
