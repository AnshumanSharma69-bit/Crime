import { z } from 'zod';

export const CATEGORY_CODES = ['murder','assault','robbery_burglary','theft','women_children','cyber_fraud','drugs','other','unknown'] as const;
export const VERIFICATION_STATUSES = ['pending_review','reported_by_news','reported_by_official','corroborated','corrected','disputed','archived'] as const;
export const SOURCE_STATUSES = ['connected','temporarily_unavailable','requires_configuration','manual_import','unsupported'] as const;
export const LOCATION_PRECISIONS = ['street','neighbourhood','police_station_area','city','unknown'] as const;

/** Schema for LLM/parser output. Confidence is ordinal on purpose: no numeric "truth score". */
export const IncidentCandidateSchema = z.object({
  kind: z.enum(['new_incident','update','opinion','historical','unrelated']),
  headline: z.string().min(5).max(200),
  categoryCode: z.enum(CATEGORY_CODES),
  summary: z.string().min(10).max(800),
  eventDate: z.string().datetime().nullable(),
  locality: z.string().max(120).nullable(),
  extractionConfidence: z.enum(['low','medium','high']),
}).strict();
export type IncidentCandidate = z.infer<typeof IncidentCandidateSchema>;

export const CATEGORY_LABELS: Record<(typeof CATEGORY_CODES)[number], string> = {
  murder: 'Murder and attempted murder', assault: 'Assault and other violent offences',
  robbery_burglary: 'Robbery and burglary', theft: 'Theft and vehicle theft',
  women_children: 'Crimes against women and children', cyber_fraud: 'Cybercrime and financial fraud',
  drugs: 'Drug-related offences', other: 'Other reported offences', unknown: 'Unknown or insufficient information',
};
export const VERIFICATION_LABELS: Record<(typeof VERIFICATION_STATUSES)[number], string> = {
  pending_review: 'Pending review', reported_by_news: 'Reported by news media',
  reported_by_official: 'Reported by an official source', corroborated: 'Corroborated by multiple sources',
  corrected: 'Corrected', disputed: 'Disputed', archived: 'Archived',
};
