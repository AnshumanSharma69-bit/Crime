import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
// The map is replaced by a stub that reports a fixed viewport, so bounds-based loading can be tested without WebGL.
vi.mock('next/dynamic', async () => {
  const { useEffect } = await import('react');
  return { default: () => (p: { onBounds?: (b: number[]) => void }) => { useEffect(() => { p.onBounds?.([78.9, 21, 79.3, 21.3]); }, []); return null; } };
});
import Workspace from './Workspace';
import { parseFilters, toQuery } from '../lib/filters';

// Test-only fixtures. Production code never contains sample incidents.
const fixture = { id: 'a1', headline: 'Fixture incident headline', summary: 'Fixture summary text for testing.', categoryCode: 'theft',
  eventDate: null, publishedAt: '2026-10-09T09:45:00Z', updatedAt: '2026-10-09T09:45:00Z', locality: 'Fixture locality',
  location: { lat: 21.15, lng: 79.09, precision: 'neighbourhood', confidence: 'medium' }, sourceType: 'official_police',
  verificationStatus: 'reported_by_official', verificationNote: '', sources: [{ name: 'Fixture Source', url: 'https://example.org/p/1', publishedAt: null }], updates: [] };
const base = { caveats: ['Counts are incidents collected, not official crime statistics.'], provenance: { description: 'Distinct published incidents collected by CrimeLens', period: { from: null, to: null } } };
const analytics: Record<string, unknown> = {
  summary: { ...base, data: { incidents: 1, sourceDocumentsLinked: 3 }, officialStatistics: { available: false, note: 'No official aggregate statistics have been imported yet.' } },
  categories: { ...base, data: [{ code: 'theft', label: 'Theft and vehicle theft', incidents: 1 }] },
  timeline: { ...base, data: [{ bucket: '2026-10-09', incidents: 1 }], undatedIncidents: 0 },
};
function mockApi(o: { incidents?: unknown; down?: boolean; status?: unknown } = {}) {
  const f = vi.fn(async (url: string) => {
    if (o.down) throw new Error('down');
    const m = /\/api\/analytics\/(\w+)/.exec(url);
    const body = url.includes('/sources/status') ? (o.status ?? { items: [] }) : m ? analytics[m[1]] : (o.incidents ?? { items: [], total: 0 });
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal('fetch', f); return f;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Workspace states', () => {
  it('reports an unreachable API as unavailable, not as empty', async () => {
    mockApi({ down: true }); render(<Workspace />);
    expect(await screen.findByText(/incident service is unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/No incidents have been collected/i)).toBeNull();
  });
  it('shows an honest empty state when nothing is collected', async () => {
    mockApi(); render(<Workspace />);
    expect(await screen.findByText(/No incidents have been collected yet/i)).toBeTruthy();
  });
  it('rejects malformed API data', async () => {
    mockApi({ incidents: { items: [{ id: 1 }], total: 1 } }); render(<Workspace />);
    expect(await screen.findByText(/unexpected data/i)).toBeTruthy();
  });
  it('opens details with source link and approximate-location notice', async () => {
    mockApi({ incidents: { items: [fixture], total: 1 } }); render(<Workspace />);
    fireEvent.click(await screen.findByText('Fixture incident headline'));
    const link = await screen.findByRole('link', { name: /Fixture Source/ });
    expect(link.getAttribute('href')).toBe('https://example.org/p/1'); expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/approximate area, not the exact location/i)).toBeTruthy();
  });
});

describe('source status indicator', () => {
  it('says "never" when no source has synced, and never implies success', async () => {
    mockApi({ status: { items: [{ slug: 'a', name: 'A', status: 'requires_configuration', lastSuccessAt: null }, { slug: 'b', name: 'B', status: 'manual_import', lastSuccessAt: null }] } }); render(<Workspace />);
    expect(await screen.findByText(/Sources connected: 0 of 2/)).toBeTruthy(); expect(screen.getByText(/Last successful sync: never/)).toBeTruthy();
  });
  it('shows the latest successful sync in IST', async () => {
    mockApi({ status: { items: [{ slug: 'a', name: 'A', status: 'connected', lastSuccessAt: '2026-10-09T09:45:00Z' }, { slug: 'b', name: 'B', status: 'unsupported', lastSuccessAt: null }] } }); render(<Workspace />);
    expect(await screen.findByText(/Sources connected: 1 of 2/)).toBeTruthy(); expect(screen.getByText(/Last successful sync: .*3:15/)).toBeTruthy();
  });
  it('says "unknown" when the status API fails', async () => {
    mockApi({ down: true }); render(<Workspace />); expect(await screen.findByText(/Last successful sync: unknown/)).toBeTruthy();
  });
});

describe('layout controls', () => {
  it('toggles the theme and collapses the side panel', async () => {
    mockApi(); render(<Workspace />);
    fireEvent.click(await screen.findByLabelText('Switch to light theme')); expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByLabelText('Switch to dark theme')).toBeTruthy();
    const aside = document.querySelector('aside')!; expect(aside.className).not.toMatch(/\bhidden\b/);
    fireEvent.click(screen.getByLabelText('Hide side panel')); expect(aside.className).toMatch(/\bhidden\b/); expect(screen.getByLabelText('Show side panel')).toBeTruthy();
  });
});

describe('development fixtures', () => {
  it('shows a prominent banner when fixture sources are present, and not otherwise', async () => {
    mockApi({ status: { items: [{ slug: 'dev-fixture-news', name: 'x', status: 'manual_import', lastSuccessAt: null }] } }); render(<Workspace />);
    expect(await screen.findByText(/Development fixture data is loaded/)).toBeTruthy(); cleanup();
    mockApi({ status: { items: [{ slug: 'real', name: 'x', status: 'connected', lastSuccessAt: null }] } }); render(<Workspace />);
    await screen.findByText(/Sources connected: 1 of 1/); expect(screen.queryByText(/Development fixture data/)).toBeNull();
  });
});

describe('map view filter and overview', () => {
  it('sends the current map bounds only when "Only this map view" is on', async () => {
    const f = mockApi({ incidents: { items: [], total: 0 } }); render(<Workspace />);
    await screen.findByText(/No incidents have been collected yet/i);
    expect(f.mock.calls.some(([u]) => String(u).includes('/api/incidents') && String(u).includes('bbox='))).toBe(false);
    fireEvent.click(screen.getByLabelText(/Only this map view/i));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('/api/incidents') && String(u).includes('bbox=78.9,21,79.3,21.3'))).toBe(true));
  });
  it('overview separates incidents from reports and states provenance, caveats and missing official statistics', async () => {
    mockApi({ incidents: { items: [fixture], total: 1 } }); render(<Workspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'Overview' }));
    expect(await screen.findByText('Reports, not crimes')).toBeTruthy();
    expect(screen.getByText(/Distinct published incidents collected by CrimeLens/)).toBeTruthy();
    expect(screen.getByText(/not official crime statistics/)).toBeTruthy();
    expect(screen.getByText(/No official aggregate statistics have been imported yet/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: /Overview of collected reports/ })).getByText('Theft and vehicle theft')).toBeTruthy();
  });
  it('overview shows unavailable rather than invented numbers when analytics fail', async () => {
    mockApi({ down: true }); render(<Workspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'Overview' }));
    expect(await screen.findByText(/analytics service is unavailable/i)).toBeTruthy();
  });
});

describe('URL filters', () => {
  it('drops invalid values and round-trips valid ones', () => {
    const f = parseFilters(new URLSearchParams('category=theft&verification=nope&from=2026-10-01&to=bad&q=%20%20'));
    expect(f).toEqual({ category: 'theft', from: '2026-10-01' });
    expect(parseFilters(new URLSearchParams(toQuery(f)))).toEqual(f);
  });
});
