import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { IncidentPage } from '@crimelens/shared';
import { createApp } from './app';
import { makePool, migrate, seedSources } from './db';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
let pool: pg.Pool; let app: ReturnType<typeof createApp>; const ids: Record<string, string> = {};

const pt = (lng: number, lat: number) => `ST_SetSRID(ST_MakePoint(${lng},${lat}),4326)::geography`;
async function incident(key: string, o: { cat: string; v: string; status?: string; loc?: [number, number]; prec?: string; event?: string; doc?: number }) {
  const { rows } = await pool.query(
    `INSERT INTO incidents (city_id,category_code,headline,summary,event_start,area_id,location,location_precision,location_confidence,verification_status,publication_status)
     VALUES (1,$1,$2,'Test fixture summary text.',$3,(SELECT id FROM areas WHERE name='Fixture Area'),${o.loc ? pt(...o.loc) : 'NULL'},$4,'medium',$5,$6) RETURNING id`,
    [o.cat, `Fixture ${key}`, o.event ?? null, o.prec ?? 'unknown', o.v, o.status ?? 'published']);
  ids[key] = rows[0].id;
  if (o.doc) await pool.query(`INSERT INTO incident_sources (incident_id,document_id,role) VALUES ($1,$2,'primary')`, [rows[0].id, o.doc]);
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_test WITH (FORCE)');
  await admin.query('CREATE DATABASE crimelens_test');
  await admin.end();
  pool = makePool(`${BASE}/crimelens_test`);
  await migrate(pool); await seedSources(pool);
  await pool.query(`INSERT INTO areas (city_id,name,kind) VALUES (1,'Fixture Area','locality')`);
  await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status) VALUES
    ('t-police','Fixture Police','official_police','https://example.org/police','html_listing','connected'),
    ('t-news','Fixture News','news','https://example.org/news','rss','connected')`);
  await pool.query(`INSERT INTO source_documents (source_id,canonical_url,title,published_at) VALUES
    ((SELECT id FROM sources WHERE slug='t-police'),'https://example.org/police/1','Police note 1','2026-10-09T09:45:00Z'),
    ((SELECT id FROM sources WHERE slug='t-news'),'https://example.org/news/1','News 1','2026-10-08T06:00:00Z')`);
  const [pd, nd] = (await pool.query('SELECT id FROM source_documents ORDER BY id')).rows.map((r) => r.id);
  await incident('A', { cat: 'theft', v: 'reported_by_official', loc: [79.09, 21.15], prec: 'neighbourhood', event: '2026-10-09T03:00:00Z', doc: pd });
  await incident('B', { cat: 'assault', v: 'reported_by_news', loc: [79.3, 21.3], prec: 'street', event: '2026-09-01T03:00:00Z', doc: nd });
  await incident('C', { cat: 'theft', v: 'pending_review', status: 'draft', loc: [79.09, 21.15], prec: 'street', doc: pd });
  await incident('D', { cat: 'other', v: 'reported_by_news', doc: nd });
  await pool.query(`INSERT INTO incident_updates (incident_id,kind,summary,occurred_at) VALUES ($1,'arrest','Fixture arrest reported.','2026-10-10T03:00:00Z')`, [ids.A]);
  app = createApp(pool, { rateLimitPerMinute: 10_000 });
});
afterAll(async () => { await pool?.end(); });

describe('migrations', () => {
  it('are idempotent', async () => expect(await migrate(pool)).toEqual([]));
});
describe('public basics', () => {
  it('health ok, security headers set, 404 is JSON', async () => {
    const r = await request(app).get('/api/health'); expect(r.body).toEqual({ status: 'ok', database: 'ok' });
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-powered-by']).toBeUndefined();
    expect((await request(app).get('/api/nope')).body).toEqual({ error: 'not_found' });
  });
  it('lists cities and the source registry with honest status', async () => {
    expect((await request(app).get('/api/cities')).body.items[0]).toMatchObject({ slug: 'nagpur', hasBoundary: false });
    const s = (await request(app).get('/api/sources/status')).body.items.find((x: any) => x.slug === 'nagpur-police-press-notes');
    expect(s).toMatchObject({ status: 'requires_configuration', parserStatus: 'not_implemented', lastSuccessAt: null });
  });
  it('serves an OpenAPI document covering the incident routes', async () => {
    const d = (await request(app).get('/api/openapi.json')).body; expect(d.openapi).toMatch(/^3\./); expect(Object.keys(d.paths)).toContain('/api/incidents/{id}/timeline');
  });
});
describe('incidents', () => {
  it('returns only published incidents, matching the frontend contract', async () => {
    const r = await request(app).get('/api/incidents'); expect(r.status).toBe(200);
    expect(IncidentPage.safeParse(r.body).success).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/body_?text/i);   // fetched document text is internal and never served
    expect(r.body.total).toBe(3); expect(r.body.items.map((i: any) => i.id)).not.toContain(ids.C);
  });
  it('filters by category, source type, verification, dates and locality', async () => {
    const ids_ = async (qs: string) => (await request(app).get(`/api/incidents?${qs}`)).body.items.map((i: any) => i.id);
    expect(await ids_('category=assault')).toEqual([ids.B]);
    expect(await ids_('sourceType=official_police')).toEqual([ids.A]);
    expect(await ids_('verification=reported_by_news')).toHaveLength(2);
    expect(await ids_('from=2026-10-01&to=2026-10-09')).toEqual([ids.A]);   // 09:00 IST on 9 Oct is inside the inclusive day
    expect(await ids_('locality=fixture%20area')).toHaveLength(3);
  });
  it('paginates server-side', async () => {
    const r = await request(app).get('/api/incidents?pageSize=1&page=2'); expect(r.body.items).toHaveLength(1); expect(r.body.total).toBe(3);
  });
  it('detail, sources and timeline; drafts and bad ids are rejected', async () => {
    const d = await request(app).get(`/api/incidents/${ids.A}`); expect(d.body.sources[0]).toMatchObject({ name: 'Fixture Police', url: 'https://example.org/police/1' });
    expect((await request(app).get(`/api/incidents/${ids.A}/timeline`)).body.items[0]).toMatchObject({ kind: 'arrest' });
    expect((await request(app).get(`/api/incidents/${ids.A}/sources`)).body.items).toHaveLength(1);
    expect((await request(app).get(`/api/incidents/${ids.C}`)).status).toBe(404);
    expect((await request(app).get('/api/incidents/not-a-uuid')).status).toBe(400);
  });
});
describe('spatial queries', () => {
  it('bbox returns only incidents inside the box', async () => {
    const r = await request(app).get('/api/incidents?bbox=79.0,21.0,79.2,21.2'); expect(r.body.items.map((i: any) => i.id)).toEqual([ids.A]);
  });
  it('map points exclude unmapped and unpublished incidents', async () => {
    const r = await request(app).get('/api/map/incidents'); expect(r.body.features).toHaveLength(2);
    expect(r.body.features.find((f: any) => f.properties.id === ids.A).properties.approximate).toBe(true);
  });
  it('clusters conserve counts and separate at high zoom', async () => {
    const total = async (z: number) => (await request(app).get(`/api/map/clusters?zoom=${z}`)).body.features;
    expect((await total(3)).reduce((n: number, f: any) => n + f.properties.count, 0)).toBe(2);
    expect(await total(16)).toHaveLength(2);
  });
});
describe('malicious and invalid input', () => {
  it('treats SQL metacharacters as data', async () => {
    const r = await request(app).get('/api/incidents').query({ q: "'; DROP TABLE incidents; --" }); expect(r.status).toBe(200); expect(r.body.total).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM incidents')).rows[0].n).toBe(4);
  });
  it('rejects bad enums, bbox, unknown params and array injection without leaking internals', async () => {
    for (const qs of ['category=arson', 'bbox=1,2,3', 'bbox=10,10,5,5', 'pageSize=9999', 'evil=1', 'category=theft&category=drugs']) {
      const r = await request(app).get(`/api/incidents?${qs}`); expect(r.status, qs).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/stack|node_modules|SELECT/i);
    }
  });
  it('reports a database outage as a generic 503/500, not an error dump', async () => {
    const dead = createApp(new pg.Pool({ connectionString: `${BASE}/no_such_db`, connectionTimeoutMillis: 2000 }));
    expect((await request(dead).get('/api/health')).body).toEqual({ status: 'degraded', database: 'unavailable' });
    const r = await request(dead).get('/api/incidents'); expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'internal_error' });
  });
});
