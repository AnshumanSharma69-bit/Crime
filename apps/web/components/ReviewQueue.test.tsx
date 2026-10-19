import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ReviewQueue from './ReviewQueue';

const draft = { id: 'a1', headline: 'Fixture draft incident', summary: 'Fixture summary text for testing.', categoryCode: 'theft', eventDate: null, publishedAt: '2026-10-09T09:45:00Z', updatedAt: '2026-10-09T09:45:00Z',
  locality: null, location: null, sourceType: 'news', verificationStatus: 'pending_review', verificationNote: '', sources: [{ name: 'Fixture Source', url: 'https://example.org/s/1', publishedAt: null }], updates: [], publicationStatus: 'draft' };
const cand = { id: 1, kind: 'new_incident', status: 'pending_review', candidate: { headline: 'Candidate headline text', summary: 'Candidate summary text here.', categoryCode: 'theft', locality: 'Sitabuldi', eventDate: null, extractionConfidence: 'low' }, document: { title: 'Candidate source doc', url: 'https://example.org/c/1' } };
type Handler = (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown };
function api(h: Partial<Record<string, Handler>> = {}) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/^.*\/api\/admin/, '')}`;
    const r = (h[key] ?? (key.startsWith('GET /incidents') ? () => ({ ok: true, status: 200, body: { items: [draft] } }) : key.startsWith('GET /candidates') ? () => ({ ok: true, status: 200, body: { items: [cand] } }) : () => ({ ok: true, status: 200, body: { status: 'accepted' } })))(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f); return f;
}
const bodies = (f: ReturnType<typeof vi.fn>, path: string) => f.mock.calls.filter(([u, i]) => String(u).endsWith(path) && i?.method === 'POST').map(([, i]) => JSON.parse(i.body));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ReviewQueue', () => {
  it('lists candidates and drafts with their sources', async () => {
    api(); render(<ReviewQueue token="t" />);
    expect(await screen.findByText('Candidate headline text')).toBeTruthy(); expect(screen.getByText('Fixture draft incident')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fixture Source' }).getAttribute('href')).toBe('https://example.org/s/1');
  });
  it('shows an honest error instead of an empty queue when loading fails', async () => {
    api({ 'GET /incidents?status=draft': () => ({ ok: false, status: 500, body: { error: 'internal_error' } }) }); render(<ReviewQueue token="t" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the review queue/);
  });
  it('turns a duplicate warning into an explicit merge decision', async () => {
    let calls = 0;
    const f = api({ 'POST /candidates/1/accept': () => (++calls === 1
      ? { ok: false, status: 409, body: { error: 'possible_duplicate', matches: [{ id: 'x1', headline: 'Existing similar incident', match: 'duplicate' }] } }
      : { ok: true, status: 200, body: { status: 'merged' } }) });
    render(<ReviewQueue token="t" />);
    fireEvent.click(await screen.findByText('Accept as draft'));
    expect(await screen.findByText('Existing similar incident', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText('Merge into this'));
    await waitFor(() => expect(bodies(f, '/candidates/1/accept')[1]).toEqual({ mergeIntoIncidentId: 'x1' }));
    expect(await screen.findByText(/Candidate 1 merged/)).toBeTruthy();
  });
  it('requires a real reason before rejecting', async () => {
    const f = api(); render(<ReviewQueue token="t" />);
    const btn = await screen.findByText('Reject') as HTMLButtonElement; expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reject reason for candidate 1'), { target: { value: 'Opinion piece, not an incident.' } }); expect(btn.disabled).toBe(false);
    fireEvent.click(btn); await waitFor(() => expect(bodies(f, '/candidates/1/reject')[0]).toEqual({ reason: 'Opinion piece, not an incident.' }));
  });
  it('shows the API reason when evidence does not support a status', async () => {
    api({ 'POST /incidents/a1/review': () => ({ ok: false, status: 409, body: { error: 'insufficient_evidence', detail: 'needs two or more independent sources' } }) }); render(<ReviewQueue token="t" />);
    await screen.findByText('Fixture draft incident');
    fireEvent.change(screen.getByLabelText('Explanation for a1'), { target: { value: 'Two outlets reported it.' } });
    fireEvent.click(screen.getByText('Save review'));
    expect(await screen.findByText('needs two or more independent sources')).toBeTruthy();
  });
});
