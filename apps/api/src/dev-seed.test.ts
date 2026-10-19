import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from './app';
import { makePool, migrate, seedSources } from './db';
import { assertSafeToSeed, removeDevFixtures, seedDevFixtures } from './dev-seed';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
let pool: pg.Pool; let app: ReturnType<typeof createApp>;
const n = async (sql: string) => (await pool.query(sql)).rows[0].n as number;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_devseed_test WITH (FORCE)'); await admin.query('CREATE DATABASE crimelens_devseed_test'); await admin.end();
  pool = makePool(`${BASE}/crimelens_devseed_test`); await migrate(pool); await seedSources(pool);
  app = createApp(pool, { rateLimitPerMinute: 10_000 });
});
afterAll(async () => { await pool?.end(); });

describe('dev fixtures', () => {
  it('refuses production, remote and missing databases', () => {
    expect(() => assertSafeToSeed('postgresql://u:p@localhost:5432/x', 'production')).toThrow(/production/);
    expect(() => assertSafeToSeed('postgresql://u:p@db.example.com:5432/x', undefined)).toThrow(/non-local/);
    expect(() => assertSafeToSeed(undefined, undefined)).toThrow(/missing or invalid/);
    expect(() => assertSafeToSeed('postgresql://u:p@localhost:5432/x', 'development')).not.toThrow();
  });
  it('loads labelled fixtures that exercise every map and detail state', async () => {
    expect(await seedDevFixtures(pool)).toEqual({ incidents: 9, documents: 10 });
    const list = (await request(app).get('/api/incidents?pageSize=50')).body;
    expect(list.total).toBe(9); expect(list.items.every((i: any) => i.headline.startsWith('[DEV FIXTURE]'))).toBe(true);
    expect(new Set(list.items.map((i: any) => i.verificationStatus))).toEqual(new Set(['reported_by_official', 'reported_by_news', 'corroborated', 'corrected']));
    expect(new Set(list.items.map((i: any) => i.location?.precision ?? 'none'))).toEqual(new Set(['neighbourhood', 'street', 'police_station_area', 'none']));
    expect((await request(app).get('/api/map/incidents')).body.features).toHaveLength(8);
    const status = (await request(app).get('/api/sources/status')).body.items.map((s: any) => s.slug);
    expect(status).toEqual(expect.arrayContaining(['dev-fixture-police', 'dev-fixture-news']));
    expect((await request(app).get('/api/analytics/summary')).body.data).toMatchObject({ incidents: 9, sourceDocumentsLinked: 10 });
  });
  it('is repeatable without duplicating', async () => {
    await seedDevFixtures(pool); expect(await n('SELECT count(*)::int AS n FROM incidents')).toBe(9);
  });
  it('removal deletes only the fixtures', async () => {
    await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status) VALUES ('other','Other','news','https://example.org/o','manual_import','manual_import')`);
    const d = (await pool.query(`INSERT INTO source_documents (source_id,canonical_url,title) VALUES ((SELECT id FROM sources WHERE slug='other'),'https://example.org/o/1','Other doc') RETURNING id`)).rows[0].id;
    const i = (await pool.query(`INSERT INTO incidents (city_id,category_code,headline,summary,publication_status) VALUES (1,'theft','Other incident','Not a fixture record.','published') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO incident_sources (incident_id,document_id,role) VALUES ($1,$2,'primary')`, [i, d]);
    expect(await removeDevFixtures(pool)).toBe(2);
    expect(await n('SELECT count(*)::int AS n FROM incidents')).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM sources WHERE slug LIKE 'dev-fixture-%'`)).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM sources WHERE slug IN ('other','nagpur-police-press-notes','ncrb-crime-in-india','nagpur-police-dashboard')`)).toBe(4);
    expect(await n(`SELECT count(*)::int AS n FROM source_documents`)).toBe(1);
  });
});
