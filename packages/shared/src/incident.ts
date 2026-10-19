import { z } from 'zod';
import { CATEGORY_CODES, VERIFICATION_STATUSES, LOCATION_PRECISIONS } from './taxonomy';

const iso = z.string().datetime({ offset: true });
export const IncidentDTO = z.object({
  id: z.string(), headline: z.string(), summary: z.string(),
  categoryCode: z.enum(CATEGORY_CODES),
  eventDate: iso.nullable(), publishedAt: iso, updatedAt: iso,
  locality: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number(), precision: z.enum(LOCATION_PRECISIONS), confidence: z.enum(['low', 'medium', 'high']) }).nullable(),
  sourceType: z.enum(['official_police', 'news']),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  verificationNote: z.string(),
  sources: z.array(z.object({ name: z.string(), url: z.string().url(), publishedAt: iso.nullable() })),
  updates: z.array(z.object({ occurredAt: iso.nullable(), kind: z.string(), summary: z.string() })).default([]),
});
export const IncidentPage = z.object({ items: z.array(IncidentDTO), total: z.number().int() });
export type IncidentDTOType = z.infer<typeof IncidentDTO>;
export type IncidentPageType = z.infer<typeof IncidentPage>;
