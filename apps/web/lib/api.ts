import { z } from 'zod';
import { IncidentPage, type IncidentPageType } from '@crimelens/shared';
import { toQuery, type Filters } from './filters';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export type Bbox = [number, number, number, number];
export type FetchResult = { ok: true; data: IncidentPageType } | { ok: false; reason: 'unavailable' | 'invalid' };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const bboxParam = (b: Bbox) => `&bbox=${[clamp(b[0], -180, 180), clamp(b[1], -90, 90), clamp(b[2], -180, 180), clamp(b[3], -90, 90)].join(',')}`;

/** Never substitutes sample data: failures are reported as failures. Responses are schema-checked. */
export async function fetchIncidents(city: string, f: Filters, signal?: AbortSignal, bbox?: Bbox | null): Promise<FetchResult> {
  try {
    const res = await fetch(`${BASE}/api/incidents?${toQuery({ ...f })}&city=${encodeURIComponent(city)}${bbox ? bboxParam(bbox) : ''}`, { signal });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const parsed = IncidentPage.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: 'invalid' };
  } catch { return { ok: false, reason: 'unavailable' }; }
}

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal }); if (!res.ok) return null;
    const p = schema.safeParse(await res.json()); return p.success ? p.data : null;
  } catch { return null; }
}

export const SourceStatus = z.object({ items: z.array(z.object({ slug: z.string(), name: z.string(), status: z.string(), lastSuccessAt: z.string().nullable() })) });
export const fetchSourceStatus = (signal?: AbortSignal) => getJson('/api/sources/status', SourceStatus, signal);

const base = { caveats: z.array(z.string()), provenance: z.object({ description: z.string(), period: z.object({ from: z.string().nullable(), to: z.string().nullable() }) }) };
export const Summary = z.object({ ...base, data: z.object({ incidents: z.number(), sourceDocumentsLinked: z.number() }), officialStatistics: z.object({ available: z.boolean(), note: z.string() }) });
export const Categories = z.object({ ...base, data: z.array(z.object({ code: z.string(), label: z.string(), incidents: z.number() })) });
export const Timeline = z.object({ ...base, data: z.array(z.object({ bucket: z.string(), incidents: z.number() })), undatedIncidents: z.number() });
export type Analytics = { summary: z.infer<typeof Summary> | null; categories: z.infer<typeof Categories> | null; timeline: z.infer<typeof Timeline> | null };

export async function fetchAnalytics(city: string, f: Filters, bbox: Bbox | null, signal?: AbortSignal): Promise<Analytics> {
  const qs = `?${toQuery({ ...f })}&city=${encodeURIComponent(city)}${bbox ? bboxParam(bbox) : ''}`;
  const [summary, categories, timeline] = await Promise.all([
    getJson(`/api/analytics/summary${qs}`, Summary, signal), getJson(`/api/analytics/categories${qs}`, Categories, signal), getJson(`/api/analytics/timeline${qs}&bucket=day`, Timeline, signal)]);
  return { summary, categories, timeline };
}
