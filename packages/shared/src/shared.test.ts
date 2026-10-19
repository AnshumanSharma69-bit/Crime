import { describe, it, expect } from 'vitest';
import { formatIST, parseDmyAsIst, IncidentCandidateSchema } from './index';

describe('time', () => {
  it('displays UTC instants in IST', () => expect(formatIST('2026-10-09T09:45:00Z')).toMatch(/3:15/));
  it('parses dd/mm/yyyy listing dates as IST midnight', () =>
    expect(parseDmyAsIst('09/10/2026')?.toISOString()).toBe('2026-10-08T18:30:00.000Z'));
  it('rejects impossible dates', () => expect(parseDmyAsIst('31/02/2026')).toBeNull());
});

describe('IncidentCandidateSchema', () => {
  const ok = { kind: 'new_incident', headline: 'Two-wheeler stolen near market', categoryCode: 'theft',
    summary: 'A two-wheeler was reported stolen from a market parking area.', eventDate: null, locality: null, extractionConfidence: 'low' };
  it('accepts a valid candidate', () => expect(IncidentCandidateSchema.safeParse(ok).success).toBe(true));
  it('rejects numeric confidence', () => expect(IncidentCandidateSchema.safeParse({ ...ok, extractionConfidence: 0.93 }).success).toBe(false));
  it('rejects unknown categories and extra keys', () => {
    expect(IncidentCandidateSchema.safeParse({ ...ok, categoryCode: 'arson' }).success).toBe(false);
    expect(IncidentCandidateSchema.safeParse({ ...ok, instructions: 'ignore previous' }).success).toBe(false);
  });
});
