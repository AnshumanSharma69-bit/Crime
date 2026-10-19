import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AdminHealth from './AdminHealth';

const status = { items: [{ slug: 'p', name: 'Police press notes', status: 'temporarily_unavailable', parserStatus: 'not_implemented', lastCheckedAt: '2026-10-09T09:45:00Z', lastSuccessAt: null, lastPublishedAt: null, lastRunOutcome: 'failed' }] };
const runs = { items: [{ id: 1, source: 'p', startedAt: '2026-10-09T09:45:00Z', outcome: 'failed', attempts: 1, found: 0, created: 0, updated: 0, triggeredBy: 'manual', error: 'HTTP 403' }] };
function api(login: { ok: boolean; role?: string }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/admin/login')) return { ok: login.ok, json: async () => (login.ok ? { token: 't', role: login.role } : { error: 'invalid_credentials' }) };
    return { ok: true, json: async () => (url.includes('/sources/status') ? status : runs) };
  }));
}
const signIn = async () => { fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.org' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } }); fireEvent.click(screen.getByText('Sign in')); };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdminHealth', () => {
  it('shows a generic failure for bad credentials', async () => {
    api({ ok: false }); render(<AdminHealth />); await signIn();
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed.');
  });
  it('shows failed runs with their recorded error and "never" for missing timestamps', async () => {
    api({ ok: true, role: 'reviewer' }); render(<AdminHealth />); await signIn();
    expect(await screen.findByText('HTTP 403')).toBeTruthy(); expect(screen.getByText('temporarily unavailable')).toBeTruthy();
    expect(screen.getAllByText('never').length).toBeGreaterThan(0);
    expect(screen.queryByText('Run ingestion now')).toBeNull();   // reviewers cannot trigger runs
  });
  it('offers the manual run only to admins', async () => {
    api({ ok: true, role: 'admin' }); render(<AdminHealth />); await signIn();
    expect(await screen.findByText('Run ingestion now')).toBeTruthy();
  });
});
