import type pg from 'pg';
import { z } from 'zod';

export interface Geocoder { name: string; geocode(query: string): Promise<{ lat: number; lng: number; label: string } | null> }
const Hits = z.array(z.object({ lat: z.string(), lon: z.string(), display_name: z.string() }));

/**
 * Nominatim client. The public instance's usage policy expects an identifying User-Agent, at most 1 request per second, caching and low volume;
 * check the current policy before relying on it, or point GEOCODER_URL at your own instance.
 */
export function createNominatimGeocoder(o: { contact: string; baseUrl?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; minIntervalMs?: number }): Geocoder {
  const f = o.fetchImpl ?? fetch, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), now = o.now ?? Date.now, gap = o.minIntervalMs ?? 1100;
  let last = Number.NEGATIVE_INFINITY;   // the first request never waits
  return {
    name: 'nominatim',
    async geocode(query) {
      const wait = last + gap - now(); if (wait > 0) await sleep(wait); last = now();
      const u = new URL('/search', o.baseUrl ?? 'https://nominatim.openstreetmap.org');
      u.search = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'in' }).toString();
      const res = await f(u, { headers: { 'User-Agent': `CrimeLens/0.1 (${o.contact})`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`geocoder_http_${res.status}`);
      const hits = Hits.safeParse(await res.json()); if (!hits.success) throw new Error('geocoder_invalid_response');
      const h = hits.data[0]; if (!h) return null;
      const lat = Number(h.lat), lng = Number(h.lon); if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('geocoder_invalid_response');
      return { lat, lng, label: h.display_name };
    },
  };
}
/** Off unless a provider is chosen AND a contact is configured (the provider's policy requires identification). */
export const geocoderFromEnv = (env: NodeJS.ProcessEnv = process.env): Geocoder | null =>
  env.GEOCODER_PROVIDER === 'nominatim' && env.CRAWLER_CONTACT ? createNominatimGeocoder({ contact: env.CRAWLER_CONTACT, baseUrl: env.GEOCODER_URL || undefined }) : null;

const round2 = (n: number) => Math.round(n * 100) / 100;   // about 1.1 km: neighbourhood level, never a street or address

/**
 * Gives DRAFT incidents that have a place name but no coordinates an approximate position. Results are cached, capped per run, kept only if they fall near the city,
 * rounded to neighbourhood level and marked low confidence. A failure leaves the incident untouched; nothing is ever guessed.
 */
export async function geocodeIncidents(pool: pg.Pool, geocoder: Geocoder | null, o: { limit?: number } = {}) {
  const out = { geocoded: 0, cached: 0, notFound: 0, failed: 0 };
  if (!geocoder) return out;
  const rows = (await pool.query(`SELECT i.id, i.city_id, COALESCE(a.name, i.locality_text) AS locality, c.name AS city, c.state FROM incidents i JOIN cities c ON c.id = i.city_id LEFT JOIN areas a ON a.id = i.area_id
    WHERE i.publication_status = 'draft' AND i.location IS NULL AND COALESCE(a.name, i.locality_text) IS NOT NULL ORDER BY i.created_at LIMIT 100`)).rows;
  let calls = 0; const limit = o.limit ?? 10;
  for (const r of rows) {
    const q = `${r.locality}, ${r.city}, ${r.state}, India`; const key = `${geocoder.name}|${q.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    let hit: { status: string; lat?: number; lng?: number } | undefined = (await pool.query(`SELECT status, lat, lng FROM geocode_cache WHERE query_key = $1 AND (status = 'ok' OR fetched_at > now() - interval '30 days')`, [key])).rows[0];
    const cached = !!hit;
    if (!hit) {
      if (calls >= limit) continue;
      calls++;
      try {
        const g = await geocoder.geocode(q);
        hit = g ? { status: 'ok', lat: g.lat, lng: g.lng } : { status: 'not_found' };
        if (g && !(await pool.query(`SELECT ST_DWithin(ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, centroid, 40000) AS near FROM cities WHERE id = $3`, [g.lng, g.lat, r.city_id])).rows[0].near) hit = { status: 'not_found' };   // outside the city: reject
        await pool.query(`INSERT INTO geocode_cache (query_key, provider, status, lat, lng, label) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (query_key) DO UPDATE SET status = EXCLUDED.status, lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, fetched_at = now()`, [key, geocoder.name, hit.status, hit.lat ?? null, hit.lng ?? null, g?.label ?? null]);
      } catch { out.failed++; continue; }   // transient: nothing cached, retried on a later run
    }
    if (hit.status !== 'ok') { out.notFound++; continue; }
    const upd = await pool.query(`UPDATE incidents SET location = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, location_precision = 'neighbourhood', location_confidence = 'low' WHERE id = $1 AND location IS NULL AND publication_status = 'draft'`, [r.id, round2(hit.lng!), round2(hit.lat!)]);
    if (upd.rowCount) {
      await pool.query(`INSERT INTO audit_events (action, entity_type, entity_id, after) VALUES ('geocode.locality','incident',$1,$2)`, [r.id, JSON.stringify({ provider: geocoder.name, query: q, precision: 'neighbourhood', cached })]);
      cached ? out.cached++ : out.geocoded++;
    }
  }
  return out;
}
