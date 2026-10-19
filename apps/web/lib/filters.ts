import { z } from 'zod';
import { CATEGORY_CODES, VERIFICATION_STATUSES } from '@crimelens/shared';

const schema = {
  category: z.enum(CATEGORY_CODES), verification: z.enum(VERIFICATION_STATUSES),
  sourceType: z.enum(['official_police', 'news']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  q: z.string().trim().min(1).max(100),
} as const;
export type Filters = { [K in keyof typeof schema]?: z.infer<(typeof schema)[K]> };

/** Invalid or unknown URL params are dropped, never passed through. */
export function parseFilters(sp: URLSearchParams): Filters {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(schema) as (keyof typeof schema)[]) {
    const raw = sp.get(k);
    if (raw == null) continue;
    const r = schema[k].safeParse(raw);
    if (r.success) out[k] = r.data;
  }
  return out as Filters;
}
export function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  return p.toString();
}
