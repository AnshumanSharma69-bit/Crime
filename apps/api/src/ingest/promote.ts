import type pg from 'pg';

export type NewIncident = { citySlug: string; categoryCode: string; headline: string; summary: string; eventStart: string | null; locality: string | null;
  lat?: number; lng?: number; precision?: string; confidence?: string; documentId: number; role: 'primary' | 'corroboration' | 'update' };

/** Every incident created here is an unpublished draft awaiting review. Coordinates are stored only when supplied; nothing is geocoded or guessed. */
export async function insertDraftIncident(c: pg.PoolClient, f: NewIncident): Promise<string> {
  const city = (await c.query('SELECT id FROM cities WHERE slug = $1', [f.citySlug])).rows[0];
  if (!city) throw new Error(`unknown city "${f.citySlug}"`);
  const has = f.lat != null && f.lng != null;
  const id = (await c.query(
    `INSERT INTO incidents (city_id, category_code, headline, summary, event_start, area_id, location, location_precision, location_confidence, locality_text)
     VALUES ($1,$2,$3,$4,$5,(SELECT id FROM areas WHERE city_id = $1 AND lower(name) = lower($6) LIMIT 1),
       CASE WHEN $8::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9::float8, $8::float8), 4326)::geography END, $7, $10, $11) RETURNING id`,
    [city.id, f.categoryCode, f.headline, f.summary, f.eventStart, f.locality, has ? f.precision : 'unknown', has ? f.lat : null, has ? f.lng : null, f.confidence ?? 'low', f.locality?.trim().slice(0, 120) || null])).rows[0].id as string;
  await c.query('INSERT INTO incident_sources (incident_id, document_id, role) VALUES ($1,$2,$3)', [id, f.documentId, f.role]);
  return id;
}
