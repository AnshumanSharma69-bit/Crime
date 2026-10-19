import { z } from 'zod';
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const Status = z.object({ items: z.array(z.object({ slug: z.string(), name: z.string(), status: z.string(), parserStatus: z.string(), lastCheckedAt: z.string().nullable(), lastSuccessAt: z.string().nullable(), lastPublishedAt: z.string().nullable(), lastRunOutcome: z.string().nullable() })) });
const Runs = z.object({ items: z.array(z.object({ id: z.number(), source: z.string(), startedAt: z.string(), outcome: z.string().nullable(), attempts: z.number(), found: z.number(), created: z.number(), updated: z.number(), triggeredBy: z.string(), error: z.string().nullable() })) });
export type Health = { sources: z.infer<typeof Status>['items']; runs: z.infer<typeof Runs>['items'] };

export async function login(email: string, password: string): Promise<{ token: string; role: 'admin' | 'reviewer' } | null> {
  try {
    const r = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const p = z.object({ token: z.string(), role: z.enum(['admin', 'reviewer']) }).safeParse(await r.json()); return r.ok && p.success ? p.data : null;
  } catch { return null; }
}
export async function loadHealth(token: string): Promise<Health | null> {
  try {
    const [s, r] = await Promise.all([fetch(`${BASE}/api/sources/status`), fetch(`${BASE}/api/admin/ingestion-runs`, { headers: { Authorization: `Bearer ${token}` } })]);
    const ps = Status.safeParse(await s.json()), pr = Runs.safeParse(await r.json());
    return s.ok && r.ok && ps.success && pr.success ? { sources: ps.data.items, runs: pr.data.items } : null;
  } catch { return null; }
}
export async function runIngest(token: string): Promise<string> {
  try {
    const r = await fetch(`${BASE}/api/admin/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const b = await r.json(); return r.ok ? (b.results as { slug: string; outcome: string; reason?: string }[]).map((x) => `${x.slug}: ${x.outcome}${x.reason ? ` (${x.reason})` : ''}`).join('; ') || 'No connectors ran.' : `Request failed (${r.status}).`;
  } catch { return 'Request failed.'; }
}

// ---- review queue ----
import { IncidentDTO } from '@crimelens/shared';
const Draft = IncidentDTO.extend({ publicationStatus: z.string() });
const Cand = z.object({ id: z.number(), kind: z.string(), candidate: z.object({ headline: z.string(), summary: z.string(), categoryCode: z.string(), locality: z.string().nullable(), eventDate: z.string().nullable(), extractionConfidence: z.string() }).passthrough(), document: z.object({ title: z.string(), url: z.string() }) });
export type Draft = z.infer<typeof Draft>; export type Cand = z.infer<typeof Cand>;
export type Call = { ok: boolean; status: number; json: any };

export async function adminCall(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Call> {
  try {
    const r = await fetch(`${BASE}/api/admin${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } catch { return { ok: false, status: 0, json: null }; }
}
export async function loadQueue(token: string): Promise<{ drafts: Draft[]; candidates: Cand[] } | null> {
  const [d, c] = await Promise.all([adminCall(token, 'GET', '/incidents?status=draft'), adminCall(token, 'GET', '/candidates')]);
  const pd = z.object({ items: z.array(Draft) }).safeParse(d.json), pc = z.object({ items: z.array(Cand) }).safeParse(c.json);
  return d.ok && c.ok && pd.success && pc.success ? { drafts: pd.data.items, candidates: pc.data.items } : null;
}
export const errorText = (c: Call) => c.status === 0 ? 'Could not reach the API.' : c.json?.detail ?? c.json?.error ?? `Request failed (${c.status}).`;

export async function loadPublished(token: string): Promise<Draft[] | null> {
  const r = await adminCall(token, 'GET', '/incidents?status=published');
  const p = z.object({ items: z.array(Draft) }).safeParse(r.json); return r.ok && p.success ? p.data.items : null;
}
