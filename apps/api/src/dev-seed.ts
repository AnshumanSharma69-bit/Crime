import type pg from 'pg';
import { insertDraftIncident } from './ingest/promote';

/** DEVELOPMENT ONLY. Loads clearly labelled fake incidents so the map, clusters, approximate-location rings and detail panel can be seen locally. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'db']);
export function assertSafeToSeed(databaseUrl: string | undefined, nodeEnv: string | undefined) {
  if (nodeEnv === 'production') throw new Error('refusing to seed fixture data when NODE_ENV=production');
  let host: string;
  try { host = new URL(databaseUrl ?? '').hostname; } catch { throw new Error('DATABASE_URL is missing or invalid'); }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`refusing to seed fixture data into a non-local database host "${host}"`);
}

const PREFIX = '[DEV FIXTURE] ';
type Fx = { src: 'police' | 'news' | 'both'; cat: string; head: string; daysAgo: number; loc?: [number, number]; prec?: string; status: string; updates?: { kind: string; summary: string }[] };
const FIXTURES: Fx[] = [
  { src: 'police', cat: 'theft', head: 'Two-wheeler reported stolen from a parking area', daysAgo: 1, loc: [79.09, 21.14], prec: 'neighbourhood', status: 'reported_by_official' },
  { src: 'news', cat: 'assault', head: 'Altercation reported outside a shop', daysAgo: 2, loc: [79.12, 21.16], prec: 'street', status: 'reported_by_news' },
  { src: 'both', cat: 'robbery_burglary', head: 'Shop break-in reported, arrest later announced', daysAgo: 3, loc: [79.07, 21.15], prec: 'neighbourhood', status: 'corroborated', updates: [{ kind: 'arrest', summary: 'Police later reported an arrest in the case.' }] },
  { src: 'police', cat: 'drugs', head: 'Seizure announced by police', daysAgo: 5, loc: [79.06, 21.12], prec: 'police_station_area', status: 'corrected', updates: [{ kind: 'correction', summary: 'The quantity in the original report was corrected.' }] },
  { src: 'news', cat: 'cyber_fraud', head: 'Online payment fraud reported (no location)', daysAgo: 4, status: 'reported_by_news' },
  ...[1, 2, 3, 4].map((k): Fx => ({ src: 'news', cat: 'theft', head: `Sample theft report ${k} (cluster demo)`, daysAgo: 5 + k, loc: [79.085 + 0.004 * k, 21.145], prec: 'neighbourhood', status: 'reported_by_news' })),
];

export async function removeDevFixtures(pool: pg.Pool): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM incidents WHERE headline LIKE $1 AND id IN (SELECT x.incident_id FROM incident_sources x JOIN source_documents d ON d.id = x.document_id JOIN sources s ON s.id = d.source_id WHERE s.slug LIKE 'dev-fixture-%')`, [`${PREFIX}%`]);
    await c.query(`DELETE FROM source_documents WHERE source_id IN (SELECT id FROM sources WHERE slug LIKE 'dev-fixture-%')`);
    const r = await c.query(`DELETE FROM sources WHERE slug LIKE 'dev-fixture-%'`);
    await c.query('COMMIT'); return r.rowCount ?? 0;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function seedDevFixtures(pool: pg.Pool) {
  await removeDevFixtures(pool);   // re-running replaces the fixtures instead of duplicating them
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const sid: Record<string, number> = {};
    for (const [kind, type] of [['police', 'official_police'], ['news', 'news']] as const)
      sid[kind] = (await c.query(`INSERT INTO sources (slug,name,type,url,collection_method,terms_notes,status) VALUES ($1,$2,$3,'https://example.org','manual_import','Development fixture, not real data.','manual_import') RETURNING id`,
        [`dev-fixture-${kind}`, `${PREFIX}${kind === 'police' ? 'Police' : 'News'} (not real)`, type])).rows[0].id;
    let docs = 0;
    for (const [i, f] of FIXTURES.entries()) {
      const kinds = f.src === 'both' ? (['police', 'news'] as const) : ([f.src] as const);
      const docIds: number[] = [];
      for (const k of kinds) {
        docIds.push((await c.query(`INSERT INTO source_documents (source_id,canonical_url,title,published_at,status) VALUES ($1,$2,$3,now() - ($4 || ' days')::interval,'processed') RETURNING id`,
          [sid[k], `https://example.org/dev-fixture/${i + 1}-${k}`, `${PREFIX}source report ${i + 1}`, String(f.daysAgo)])).rows[0].id); docs++;
      }
      const id = await insertDraftIncident(c, { citySlug: 'nagpur', categoryCode: f.cat, headline: PREFIX + f.head, summary: 'Fake record created for local development. It is not a real incident.',
        eventStart: new Date(Date.now() - f.daysAgo * 864e5).toISOString(), locality: null, lat: f.loc?.[1], lng: f.loc?.[0], precision: f.prec, confidence: 'medium', documentId: docIds[0], role: 'primary' });
      for (const d of docIds.slice(1)) await c.query(`INSERT INTO incident_sources (incident_id,document_id,role) VALUES ($1,$2,'corroboration')`, [id, d]);
      await c.query(`UPDATE incidents SET publication_status='published', verification_status=$2, verification_note='DEV FIXTURE: not a real incident.' WHERE id=$1`, [id, f.status]);
      for (const u of f.updates ?? []) await c.query(`INSERT INTO incident_updates (incident_id,occurred_at,kind,summary) VALUES ($1, now() - interval '1 day', $2, $3)`, [id, u.kind, u.summary]);
    }
    await c.query('COMMIT'); return { incidents: FIXTURES.length, documents: docs };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
