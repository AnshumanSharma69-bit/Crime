import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import PublishedManager from './PublishedManager';

const inc = (id: string, headline: string) => ({ id, headline, summary: 'Fixture summary text for testing.', categoryCode: 'theft', eventDate: null, publishedAt: '2026-10-09T09:45:00Z', updatedAt: '2026-10-09T09:45:00Z',
  locality: null, location: null, sourceType: 'news', verificationStatus: 'reported_by_news', verificationNote: '', sources: [{ name: 'S', url: 'https://example.org/s', publishedAt: null }], updates: [], publicationStatus: 'published' });
function api(post?: (path: string) => { ok: boolean; status: number; body: unknown }) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/admin/, '');
    const r = init?.method === 'POST' ? (post?.(path) ?? { ok: true, status: 200, body: { ok: true } }) : { ok: true, status: 200, body: { items: [inc('a1', 'First incident'), inc('b2', 'Second incident')] } };
    return { ok: r.ok, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f); return f;
}
const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, i]) => i?.method === 'POST').map(([u, i]) => ({ path: String(u).replace(/^.*\/api\/admin/, ''), body: JSON.parse(i.body) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PublishedManager', () => {
  it('sends only the fields that changed, and only with a real reason', async () => {
    const f = api(); render(<PublishedManager token="t" role="reviewer" />);
    const save = await screen.findAllByText('Save correction'); const b = save[0] as HTMLButtonElement; expect(b.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Headline for a1'), { target: { value: 'Corrected headline text' } }); expect(b.disabled).toBe(true);   // still no reason
    fireEvent.change(screen.getByLabelText('Reason for a1'), { target: { value: 'The original headline was wrong.' } }); expect(b.disabled).toBe(false);
    fireEvent.click(b); await waitFor(() => expect(posts(f)[0]).toEqual({ path: '/incidents/a1/correct', body: { headline: 'Corrected headline text', note: 'The original headline was wrong.' } }));
    expect(await screen.findByText('Correction saved.')).toBeTruthy();
  });
  it('offers removal to admins only', async () => {
    api(); const { unmount } = render(<PublishedManager token="t" role="reviewer" />); await screen.findAllByText('Archive'); expect(screen.queryByText('Remove')).toBeNull(); unmount();
    render(<PublishedManager token="t" role="admin" />); expect((await screen.findAllByText('Remove')).length).toBe(2);
  });
  it('merges into another incident chosen from the list, never into itself', async () => {
    const f = api(); render(<PublishedManager token="t" role="reviewer" />);
    await screen.findAllByText('Merge'); const sel = screen.getByLabelText('Merge target for a1') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'b2']);
    fireEvent.change(sel, { target: { value: 'b2' } }); fireEvent.change(screen.getByLabelText('Reason for a1'), { target: { value: 'Same case reported twice.' } });
    fireEvent.click(screen.getAllByText('Merge')[0]); await waitFor(() => expect(posts(f)[0]).toEqual({ path: '/incidents/a1/merge', body: { intoIncidentId: 'b2', reason: 'Same case reported twice.' } }));
  });
  it('shows the server reason when an action is refused', async () => {
    api(() => ({ ok: false, status: 403, body: { error: 'forbidden' } })); render(<PublishedManager token="t" role="admin" />);
    await screen.findAllByText('Archive'); fireEvent.change(screen.getByLabelText('Reason for a1'), { target: { value: 'Outdated, superseded.' } }); fireEvent.click(screen.getAllByText('Archive')[0]);
    expect(await screen.findByText('forbidden')).toBeTruthy();
  });
  it('says so, rather than showing an empty list, when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal_error' }) }))); render(<PublishedManager token="t" role="admin" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load published incidents/);
  });
});
