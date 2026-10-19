'use client';
import { useState } from 'react';
import { formatIST } from '@crimelens/shared';
import { loadHealth, login, runIngest, type Health } from '../lib/admin';
import ReviewQueue from './ReviewQueue';
import PublishedManager from './PublishedManager';

const t = (v: string | null) => (v ? formatIST(v) : 'never');
const field = 'rounded-[6px] border border-line bg-bg2 px-2 py-1.5 text-sm text-ink';

export default function AdminHealth() {
  const [auth, setAuth] = useState<{ token: string; role: 'admin' | 'reviewer' } | null>(null);   // memory only: nothing is persisted in the browser
  const [tab, setTab] = useState<'health' | 'review' | 'published'>('health'); const [health, setHealth] = useState<Health | null>(null); const [msg, setMsg] = useState(''); const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const refresh = async (token: string) => { const h = await loadHealth(token); setHealth(h); if (!h) setMsg('Could not load ingestion health.'); };

  if (!auth) return <main className="mx-auto max-w-sm space-y-3 p-6 text-sm">
    <h1 className="font-headline text-xl">Ingestion health</h1>
    <input aria-label="Email" className={`${field} w-full`} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
    <input aria-label="Password" type="password" className={`${field} w-full`} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
    <button className={`${field} w-full`} onClick={async () => { const a = await login(email, pw); if (!a) return setMsg('Sign-in failed.'); setMsg(''); setAuth(a); setPw(''); await refresh(a.token); }}>Sign in</button>
    {msg && <p role="alert" className="text-dim">{msg}</p>}</main>;

  return <main className="mx-auto max-w-5xl space-y-6 p-6 text-sm">
    <div className="flex items-center gap-3"><h1 className="font-headline text-xl">Ingestion health</h1><span className="text-dim">Signed in as {auth.role}</span>
      <button className={`${field} ml-auto`} onClick={() => refresh(auth.token)}>Refresh</button>
      {auth.role === 'admin' && <button className={field} onClick={async () => { setMsg('Running…'); setMsg(await runIngest(auth.token)); await refresh(auth.token); }}>Run ingestion now</button>}</div>
    <div className="flex gap-2 border-b border-line pb-2">{(['health', 'review', 'published'] as const).map((k) => <button key={k} aria-pressed={tab === k} className={`rounded-[6px] px-2 py-1 ${tab === k ? 'bg-bg2 text-ink' : 'text-dim hover:text-ink'}`} onClick={() => setTab(k)}>{k === 'health' ? 'Ingestion health' : k === 'review' ? 'Review queue' : 'Published incidents'}</button>)}</div>
    {tab === 'review' && <ReviewQueue token={auth.token} />}
    {tab === 'published' && <PublishedManager token={auth.token} role={auth.role} />}
    {msg && tab === 'health' && <p role="status" className="text-dim">{msg}</p>}
    {tab === 'health' && health && <>
      <section aria-label="Sources"><h2 className="mb-2 font-medium">Sources</h2><div className="overflow-x-auto"><table className="w-full text-left"><thead className="text-dim"><tr><th>Source</th><th>Status</th><th>Parser</th><th>Last checked</th><th>Last success</th><th>Last published item</th><th>Last run</th></tr></thead>
        <tbody>{health.sources.map((s) => <tr key={s.slug} className="border-t border-line"><td>{s.name}</td><td>{s.status.replace(/_/g, ' ')}</td><td>{s.parserStatus.replace(/_/g, ' ')}</td><td>{t(s.lastCheckedAt)}</td><td>{t(s.lastSuccessAt)}</td><td>{t(s.lastPublishedAt)}</td><td>{s.lastRunOutcome ?? 'none'}</td></tr>)}</tbody></table></div></section>
      <section aria-label="Recent runs"><h2 className="mb-2 font-medium">Recent runs</h2>{health.runs.length === 0 ? <p className="text-dim">No runs recorded yet.</p> : <div className="overflow-x-auto"><table className="w-full text-left"><thead className="text-dim"><tr><th>Started</th><th>Source</th><th>Outcome</th><th>Attempts</th><th>Found / new / updated</th><th>Trigger</th><th>Error</th></tr></thead>
        <tbody>{health.runs.map((r) => <tr key={r.id} className="border-t border-line"><td>{formatIST(r.startedAt)}</td><td>{r.source}</td><td>{r.outcome ?? 'running'}</td><td>{r.attempts}</td><td>{r.found} / {r.created} / {r.updated}</td><td>{r.triggeredBy}</td><td>{r.error ?? ''}</td></tr>)}</tbody></table></div>}</section></>}
  </main>;
}
