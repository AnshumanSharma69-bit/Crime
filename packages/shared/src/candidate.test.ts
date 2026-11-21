import { describe, expect, it } from 'vitest';
import { IncidentCandidateSchema } from './taxonomy';

const base = { kind: 'new_incident', headline: 'Two-wheeler stolen near market', categoryCode: 'theft', summary: 'A two-wheeler was reported stolen near the market.', locality: 'Sitabuldi', extractionConfidence: 'medium' };
describe('candidate event dates', () => {
  it('accepts UTC and India-time timestamps, and reads a bare date as midnight India time', () => {
    expect(IncidentCandidateSchema.safeParse({ ...base, eventDate: '2026-10-15T09:00:00Z' }).success).toBe(true);
    expect(IncidentCandidateSchema.safeParse({ ...base, eventDate: '2026-10-15T09:00:00+05:30' }).success).toBe(true);
    const bare = IncidentCandidateSchema.safeParse({ ...base, eventDate: '2026-10-15' });
    expect(bare.success && bare.data.eventDate).toBe('2026-10-15T00:00:00+05:30');
    expect(IncidentCandidateSchema.safeParse({ ...base, eventDate: null }).success).toBe(true);
  });
  it('rejects things that are not dates', () => {
    for (const eventDate of ['yesterday', '15/10/2026', '2026-13-45', '']) expect(IncidentCandidateSchema.safeParse({ ...base, eventDate }).success, eventDate).toBe(false);
  });
});
