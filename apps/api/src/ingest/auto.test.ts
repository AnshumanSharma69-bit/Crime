import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app';
import { makePool, migrate } from '../db';
import { autoAcceptCandidates, autoPublishDrafts, policyFromEnv, reasonToHold, revokeAutoPublished, AUTO_NOTE } from './auto';
import type { Geocoder } from './geocode';
import { geocodeIncidents } from './geocode';
import { importRecords } from './import';
import { runPipeline } from './pipeline';

const BASE = process.env.TEST_PG_BASE ?? 'postgresql://crimelens:crimelens_dev_only@localhost:5432';
let pool: pg.Pool; let app: ReturnType<typeof createApp>; let n = 0;
const policy = policyFromEnv({} as any);
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const geo: Geocoder = { name: 'fake', geocode: async () => ({ lat: 21.15, lng: 79.08, label: 'Fixture, Nagpur' }) };
const cand = (o: Record<string, unknown> = {}) => ({ kind: 'new_incident', headline: `Fixture incident report number ${++n}`, categoryCode: 'theft', summary: 'A fixture summary of what the police reported.', eventDate: ago(3), locality: 'Sitabuldi', extractionConfidence: 'medium', ...o });
async function addCandidate(payload: object, source = 'a-police') {
  const d = (await pool.query(`INSERT INTO source_documents (source_id,canonical_url,title,body_text) VALUES ((SELECT id FROM sources WHERE slug=$1),$2,'Doc','text') RETURNING id`, [source, `https://example.org/auto/${++n}.pdf`])).rows[0].id;
  return (await pool.query(`INSERT INTO extraction_candidates (document_id,kind,payload) VALUES ($1,'new_incident',$2) RETURNING id`, [d, JSON.stringify(payload)])).rows[0].id as number;
}
const q = async (sql: string) => (await pool.query(sql)).rows;
const count = async (t: string, where = 'true') => (await pool.query(`SELECT count(*)::int AS c FROM ${t} WHERE ${where}`)).rows[0].c as number;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  await admin.query('DROP DATABASE IF EXISTS crimelens_auto_test WITH (FORCE)'); await admin.query('CREATE DATABASE crimelens_auto_test'); await admin.end();
  pool = makePool(`${BASE}/crimelens_auto_test`); await migrate(pool); app = createApp(pool, { rateLimitPerMinute: 1e5 });
});
afterAll(async () => { delete process.env.AUTO_PUBLISH; await pool?.end(); });
beforeEach(async () => {
  delete process.env.AUTO_PUBLISH;
  await pool.query('TRUNCATE incidents, extraction_candidates, source_documents, sources, geocode_cache, audit_events RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO sources (slug,name,type,url,collection_method,status) VALUES ('a-police','Police','official_police','https://example.org','html_listing','connected'),('a-news','News','news','https://example.org/n','rss','connected')`);
});

describe('what may proceed automatically', () => {
  it('accepts a clean official-source candidate as a draft, keeps its place name, and records why', async () => {
    const id = await addCandidate(cand());
    expect(await autoAcceptCandidates(pool, policy)).toEqual({ accepted: 1, held: {} });
    expect((await q(`SELECT publication_status, locality_text, location IS NULL AS no_loc FROM incidents`))[0]).toEqual({ publication_status: 'draft', locality_text: 'Sitabuldi', no_loc: true });
    expect((await q(`SELECT status FROM extraction_candidates WHERE id=${id}`))[0].status).toBe('accepted');
    expect(await count('audit_events', `action IN ('candidate.auto_accept','incident.auto_created')`)).toBe(2);
  });
  it.each([
    ['not_official_source', {}, 'a-news'], ['sensitive_or_unknown_category', { categoryCode: 'women_children' }], ['sensitive_or_unknown_category', { categoryCode: 'unknown' }],
    ['low_confidence', { extractionConfidence: 'low' }], ['no_locality', { locality: null }], ['placeholder_text', { summary: 'Police arrested [NAME] after a theft was reported.' }],
    ['implausible_date', { eventDate: ago(400) }], ['implausible_date', { eventDate: ago(-30) }],
  ])('holds %s for a person', async (reason, over, source = 'a-police') => {
    const id = await addCandidate(cand(over), source as string);
    const out = await autoAcceptCandidates(pool, policy);
    expect(out).toEqual({ accepted: 0, held: { [reason]: 1 } }); expect((await q(`SELECT status FROM extraction_candidates WHERE id=${id}`))[0].status).toBe('pending_review'); expect(await count('incidents')).toBe(0);
  });
  it('holds likely duplicates, including two near-identical candidates in the same run', async () => {
    await addCandidate(cand({ headline: 'Two-wheeler stolen near Sitabuldi market', eventDate: ago(3) })); await addCandidate(cand({ headline: 'Two-wheeler stolen near Sitabuldi market area', eventDate: ago(3) }));
    expect(await autoAcceptCandidates(pool, policy)).toEqual({ accepted: 1, held: { possible_duplicate: 1 } });
    await addCandidate(cand({ headline: 'Two-wheeler stolen near the Sitabuldi market again', eventDate: ago(3) }));
    expect((await autoAcceptCandidates(pool, policy)).held).toEqual({ possible_duplicate: 2 });   // the first held one is still waiting too
  });
  it('can be made stricter: high confidence only', async () => {
    await addCandidate(cand());
    expect(await autoAcceptCandidates(pool, policyFromEnv({ AUTO_MIN_CONFIDENCE: 'high' } as any))).toEqual({ accepted: 0, held: { low_confidence: 1 } });
  });
  it('reasonToHold is a pure rule check', () => expect(reasonToHold(cand() as any, 'official_police', policy)).toBeNull());
});

describe('publishing', () => {
  it('publishes an automatic draft once it has a location, labels it as unreviewed, and serves it publicly', async () => {
    await addCandidate(cand({ headline: 'Chain snatching reported near Dharampeth square' }));
    await autoAcceptCandidates(pool, policy);
    expect(await autoPublishDrafts(pool)).toEqual({ published: 0, waitingForLocation: 1 });   // no location yet: stays a draft
    expect((await request(app).get('/api/incidents')).body.total).toBe(0);
    expect((await geocodeIncidents(pool, geo)).geocoded).toBe(1);
    expect(await autoPublishDrafts(pool)).toEqual({ published: 1, waitingForLocation: 0 });
    const item = (await request(app).get('/api/incidents')).body.items[0];
    expect(item).toMatchObject({ verificationStatus: 'reported_by_official', verificationNote: AUTO_NOTE, sourceType: 'official_police' }); expect(item.location).toMatchObject({ precision: 'neighbourhood', confidence: 'low' });
    expect((await q(`SELECT last_reviewed_at FROM incidents`))[0].last_reviewed_at).toBeNull();   // honestly unreviewed
    expect(await count('audit_events', `action='incident.auto_publish'`)).toBe(1);
  });
  it('never auto-publishes drafts it did not create, or ones a person has touched', async () => {
    await importRecords(pool, [{ sourceSlug: 'a-police', url: 'https://example.org/imp/1', title: 'Import doc', headline: 'Imported fixture headline', summary: 'Imported fixture summary text.', categoryCode: 'theft', lat: 21.15, lng: 79.08, precision: 'neighbourhood' }]);
    await addCandidate(cand()); await autoAcceptCandidates(pool, policy); await geocodeIncidents(pool, geo);
    await pool.query(`UPDATE incidents SET last_reviewed_at = now() WHERE headline LIKE 'Fixture incident report%'`);   // a reviewer has looked at the automatic one
    expect(await autoPublishDrafts(pool)).toEqual({ published: 0, waitingForLocation: 0 }); expect(await count('incidents', `publication_status='published'`)).toBe(0);
  });
  it('can be undone: revoked incidents leave the map and are not republished; ones a person edited are left alone', async () => {
    await addCandidate(cand({ headline: 'Burglary reported near Gandhibagh market' })); await addCandidate(cand({ headline: 'Vehicle theft reported near Itwari station', locality: 'Itwari' }));
    await autoAcceptCandidates(pool, policy); await geocodeIncidents(pool, geo); await autoPublishDrafts(pool);
    expect(await count('incidents', `publication_status='published'`)).toBe(2);
    await pool.query(`UPDATE incidents SET verification_note = 'Checked by a reviewer against the PDF.', last_reviewed_at = now() WHERE headline LIKE 'Vehicle theft%'`);
    expect(await revokeAutoPublished(pool)).toBe(1);
    expect((await request(app).get('/api/incidents')).body.items.map((i: any) => i.headline)).toEqual(['Vehicle theft reported near Itwari station']);
    expect(await autoPublishDrafts(pool)).toEqual({ published: 0, waitingForLocation: 0 });   // not republished
    expect(await count('audit_events', `action='incident.auto_revoke'`)).toBe(1);
  });
});

describe('the pipeline', () => {
  const adapter = { extract: async () => [cand({ headline: 'Shop break-in reported near Gandhibagh', locality: 'Gandhibagh' })] };
  const doc = () => pool.query(`INSERT INTO source_documents (source_id,canonical_url,title,body_text) VALUES ((SELECT id FROM sources WHERE slug='a-police'),'https://example.org/p/1.pdf','Afternoon Pressnote','text')`);
  it('is OFF by default: candidates wait for a person and nothing is published', async () => {
    await doc(); const out = await runPipeline(pool, [], {}, adapter, 'manual', geo);
    expect(out.auto).toBeNull(); expect(out.published).toBeNull(); expect(out.extraction.candidates).toBe(1); expect(await count('incidents')).toBe(0);
  });
  it('with AUTO_PUBLISH=true goes from extracted text to a published map incident in one run', async () => {
    process.env.AUTO_PUBLISH = 'true'; await doc(); const out = await runPipeline(pool, [], {}, adapter, 'manual', geo);
    expect(out.auto).toEqual({ accepted: 1, held: {} }); expect(out.geocoding.geocoded).toBe(1); expect(out.published).toEqual({ published: 1, waitingForLocation: 0 });
    expect((await request(app).get('/api/map/incidents')).body.features).toHaveLength(1);
  });
});
