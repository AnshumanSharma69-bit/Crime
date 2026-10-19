import { z } from 'zod';
import { CATEGORY_CODES, VERIFICATION_STATUSES, type IncidentDTOType } from '@crimelens/shared';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bbox = z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/).transform((s) => s.split(',').map(Number) as [number, number, number, number])
  .refine(([a, b, c, d]) => a < c && b < d && a >= -180 && c <= 180 && b >= -90 && d <= 90, 'bbox must be minLng,minLat,maxLng,maxLat within world bounds');

export const FilterQuery = z.object({
  city: z.string().regex(/^[a-z0-9-]{1,40}$/).default('nagpur'),
  category: z.enum(CATEGORY_CODES).optional(), verification: z.enum(VERIFICATION_STATUSES).optional(),
  sourceType: z.enum(['official_police', 'news']).optional(),
  from: day.optional(), to: day.optional(), q: z.string().trim().min(1).max(100).optional(),
  locality: z.string().trim().min(1).max(100).optional(), bbox: bbox.optional(),
}).strict();
export const ListQuery = FilterQuery.extend({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const ClusterQuery = FilterQuery.extend({ zoom: z.coerce.number().min(0).max(20).default(10) }).strict();
export type Filter = z.infer<typeof FilterQuery>;

const like = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export const FROM_SQL = `
FROM incidents i
JOIN cities c ON c.id = i.city_id
LEFT JOIN areas a ON a.id = i.area_id
CROSS JOIN LATERAL (
  SELECT COALESCE(json_agg(json_build_object('name', src.name, 'url', d.canonical_url, 'publishedAt', d.published_at) ORDER BY d.published_at) FILTER (WHERE d.id IS NOT NULL), '[]') AS sources,
         MIN(d.published_at) AS published_at,
         COALESCE(bool_or(src.type IN ('official_police','official_dataset')), false) AS is_official
  FROM incident_sources x JOIN source_documents d ON d.id = x.document_id JOIN sources src ON src.id = d.source_id
  WHERE x.incident_id = i.id) s
CROSS JOIN LATERAL (
  SELECT COALESCE(json_agg(json_build_object('occurredAt', u.occurred_at, 'kind', u.kind, 'summary', u.summary) ORDER BY u.occurred_at NULLS LAST, u.id), '[]') AS updates
  FROM incident_updates u WHERE u.incident_id = i.id) u`;

/** Every value is bound as a parameter; only fixed SQL text is concatenated. */
export function buildWhere(f: Filter) {
  const p: unknown[] = [];
  const add = (v: unknown) => (p.push(v), `$${p.length}`);
  const w = [`i.publication_status = 'published'`, `c.slug = ${add(f.city)}`];
  if (f.category) w.push(`i.category_code = ${add(f.category)}`);
  if (f.verification) w.push(`i.verification_status = ${add(f.verification)}`);
  if (f.sourceType) w.push(`s.is_official = ${f.sourceType === 'official_police' ? 'true' : 'false'}`);
  // Date filters apply to the event date; incidents with no stated event date are excluded when they are used.
  if (f.from) w.push(`i.event_start >= (${add(f.from)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (f.to) w.push(`i.event_start < ((${add(f.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (f.q) { const t = add(`%${like(f.q)}%`); w.push(`(i.headline ILIKE ${t} OR i.summary ILIKE ${t} OR a.name ILIKE ${t} OR i.locality_text ILIKE ${t})`); }
  if (f.locality) w.push(`lower(COALESCE(a.name, i.locality_text)) = lower(${add(f.locality)})`);
  if (f.bbox) w.push(`i.location && ST_MakeEnvelope(${f.bbox.map(add).join(',')}, 4326)::geography`);
  return { where: w.join(' AND '), params: p };
}

export const SELECT_INCIDENT = `
SELECT i.id, i.headline, i.summary, i.category_code, i.event_start, i.updated_at, i.created_at, i.verification_status, i.verification_note,
  i.location_precision, i.location_confidence, ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng,
  COALESCE(a.name, i.locality_text) AS locality, s.sources, s.published_at, s.is_official, u.updates`;

export function toDTO(r: any): IncidentDTOType {
  return {
    id: r.id, headline: r.headline, summary: r.summary, categoryCode: r.category_code,
    eventDate: r.event_start ? new Date(r.event_start).toISOString() : null,
    publishedAt: new Date(r.published_at ?? r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    locality: r.locality ?? null,
    location: r.lat == null ? null : { lat: r.lat, lng: r.lng, precision: r.location_precision, confidence: r.location_confidence },
    sourceType: r.is_official ? 'official_police' : 'news',
    verificationStatus: r.verification_status, verificationNote: r.verification_note,
    sources: r.sources, updates: r.updates,
  };
}
