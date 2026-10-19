import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app';
import { makePool, migrate } from '../db';
import { importRecords } from './import';
import { createNominatimGeocoder, geocodeIncidents, geocoderFromEnv, type Geocoder } from './geocode';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
let pool: pg.Pool; let n = 0;
const draft = (locality?: string, o: object = {}) => importRecords(pool, [{ sourceSlug: 'g-src', url: `https://example.org/g/${++n}`, title: `Geo doc ${n}`, headline: `Geo fixture headline ${n}`, summary: 'Geocoding fixture summary text.', categoryCode: 'theft', ...(locality ? { locality } : {}), ...o }]);
const fake = (fn: (q: string) => Promise<{ lat: number; lng: number; label: string } | null>): Geocoder & { calls: string[] } => { const calls: string[] = []; return { name: 'fake', calls, geocode: async (q) => { calls.push(q); return fn(q); } }; };
const inc = async (head: string) => (await pool.query(`SELECT publication_status, location_precision AS prec, location_confidence AS conf, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM incidents WHERE headline = $1`, [head])).rows[0];
const NAGPUR = { lat: 21.1461, lng: 79.0849, label: 'Sitabuldi, Nagpur' };

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_geo_test WITH (FORCE)'); await admin.query('CREATE DATABASE crimelens_geo_test'); await admin.end();
  pool = makePool(`${BASE}/crimelens_geo_test`); await migrate(pool);
  await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status) VALUES ('g-src','G','news','https://example.org','manual_import','manual_import')`);
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { n = 0; await pool.query('TRUNCATE incidents, source_documents, geocode_cache, audit_events RESTART IDENTITY CASCADE'); });

describe('Nominatim client', () => {
  const body = (b: unknown, ok = true, status = 200) => vi.fn(async () => ({ ok, status, json: async () => b }));
  it('identifies itself, restricts to India, parses the first hit and returns null for no match', async () => {
    const f = body([{ lat: '21.1', lon: '79.1', display_name: 'X, Nagpur' }]);
    const g = createNominatimGeocoder({ contact: 'ops@example.org', fetchImpl: f as any, sleep: async () => {} });
    expect(await g.geocode('Sitabuldi, Nagpur')).toEqual({ lat: 21.1, lng: 79.1, label: 'X, Nagpur' });
    const [u, init] = f.mock.calls[0] as any; expect(String(u)).toContain('countrycodes=in'); expect(String(u)).toContain('limit=1'); expect(init.headers['User-Agent']).toMatch(/ops@example\.org/);
    expect(await createNominatimGeocoder({ contact: 'c', fetchImpl: body([]) as any }).geocode('nowhere')).toBeNull();
  });
  it('fails on HTTP errors and malformed answers', async () => {
    await expect(createNominatimGeocoder({ contact: 'c', fetchImpl: body([], false, 429) as any }).geocode('x')).rejects.toThrow('geocoder_http_429');
    await expect(createNominatimGeocoder({ contact: 'c', fetchImpl: body({ nope: 1 }) as any }).geocode('x')).rejects.toThrow('geocoder_invalid_response');
  });
  it('never sends requests faster than the configured interval', async () => {
    let t = 1_000; const sleeps: number[] = [];
    const g = createNominatimGeocoder({ contact: 'c', fetchImpl: body([]) as any, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, minIntervalMs: 1100 });
    await g.geocode('a'); t += 200; await g.geocode('b'); expect(sleeps).toEqual([900]);
  });
  it('is disabled without a provider and a contact', () => {
    expect(geocoderFromEnv({} as any)).toBeNull(); expect(geocoderFromEnv({ GEOCODER_PROVIDER: 'nominatim' } as any)).toBeNull();
    expect(geocoderFromEnv({ GEOCODER_PROVIDER: 'nominatim', CRAWLER_CONTACT: 'ops@example.org' } as any)).not.toBeNull();
  });
});

describe('locality is kept, and used as the starting point', () => {
  it('stores the place name even when no area matches, and shows it in the API', async () => {
    await draft('Zzz Unknown Colony'); await pool.query(`UPDATE incidents SET publication_status='published'`);
    const r = await request(createApp(pool, { rateLimitPerMinute: 1e4 })).get('/api/incidents'); expect(r.body.items[0].locality).toBe('Zzz Unknown Colony');
    expect((await request(createApp(pool, { rateLimitPerMinute: 1e4 })).get('/api/incidents?q=unknown%20colony')).body.total).toBe(1);
  });
});

describe('geocoding drafts', () => {
  it('adds an approximate, rounded, low-confidence location to a draft and audits it', async () => {
    await draft('Sitabuldi', { categoryCode: 'women_children' }); const g = fake(async () => NAGPUR);
    expect(await geocodeIncidents(pool, g)).toEqual({ geocoded: 1, cached: 0, notFound: 0, failed: 0 });
    expect(g.calls[0]).toBe('Sitabuldi, Nagpur, Maharashtra, India');
    expect(await inc('Geo fixture headline 1')).toEqual({ publication_status: 'draft', prec: 'neighbourhood', conf: 'low', lat: 21.15, lng: 79.08 });   // rounded to 2 decimals; sensitive categories are never finer
    expect((await pool.query(`SELECT after FROM audit_events WHERE action='geocode.locality'`)).rows[0].after).toMatchObject({ provider: 'fake', precision: 'neighbourhood', cached: false });
  });
  it('leaves published incidents, incidents without a place name, and incidents with coordinates alone', async () => {
    await draft('Sitabuldi'); await pool.query(`UPDATE incidents SET publication_status='published'`);
    await draft(); await draft('Dharampeth', { lat: 21.14, lng: 79.07, precision: 'neighbourhood' });
    const g = fake(async () => NAGPUR); await geocodeIncidents(pool, g); expect(g.calls).toEqual([]);
  });
  it('caches successes and failures, so repeats cost no provider calls', async () => {
    await draft('Sitabuldi'); await draft('Sitabuldi'); await draft('Atlantis'); await draft('Atlantis');
    const g = fake(async (q) => (q.startsWith('Sitabuldi') ? NAGPUR : null));
    expect(await geocodeIncidents(pool, g)).toEqual({ geocoded: 1, cached: 1, notFound: 2, failed: 0 }); expect(g.calls).toHaveLength(2);
    await draft('Atlantis'); await geocodeIncidents(pool, g); expect(g.calls).toHaveLength(2);   // still cached
  });
  it('rejects a result outside the city instead of placing the incident there', async () => {
    await draft('Springfield'); const g = fake(async () => ({ lat: 28.61, lng: 77.2, label: 'Delhi' }));
    expect(await geocodeIncidents(pool, g)).toMatchObject({ geocoded: 0, notFound: 1 }); expect((await inc('Geo fixture headline 1')).lat).toBeNull();
  });
  it('respects the per-run limit and survives provider errors without caching them', async () => {
    await draft('Alpha'); await draft('Beta'); await draft('Gamma');
    const g = fake(async () => NAGPUR); expect((await geocodeIncidents(pool, g, { limit: 2 })).geocoded).toBe(2); expect(g.calls).toHaveLength(2);
    const bad: Geocoder = { name: 'fake', geocode: async () => { throw new Error('geocoder_http_503'); } };
    expect(await geocodeIncidents(pool, bad)).toMatchObject({ failed: 1 }); expect((await pool.query(`SELECT count(*)::int AS c FROM geocode_cache WHERE query_key LIKE '%gamma%'`)).rows[0].c).toBe(0);
  });
  it('does nothing when no geocoder is configured', async () => {
    await draft('Sitabuldi'); expect(await geocodeIncidents(pool, null)).toEqual({ geocoded: 0, cached: 0, notFound: 0, failed: 0 }); expect((await inc('Geo fixture headline 1')).lat).toBeNull();
  });
});
