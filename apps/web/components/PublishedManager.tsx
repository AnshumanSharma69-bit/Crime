'use client';
import { useEffect, useState } from 'react';
import { CATEGORY_CODES, CATEGORY_LABELS, VERIFICATION_LABELS } from '@crimelens/shared';
import { adminCall, errorText, loadPublished, type Draft } from '../lib/admin';

const box = 'rounded-[6px] border border-line bg-bg2 px-2 py-1.5 text-sm text-ink';

function Card({ d, others, token, role, done }: { d: Draft; others: Draft[]; token: string; role: 'admin' | 'reviewer'; done: (m: string) => void }) {
  const [headline, setHeadline] = useState(d.headline); const [summary, setSummary] = useState(d.summary); const [cat, setCat] = useState<string>(d.categoryCode);
  const [note, setNote] = useState(''); const [target, setTarget] = useState(''); const [err, setErr] = useState('');
  const ok = note.trim().length >= 10; const changed = headline !== d.headline || summary !== d.summary || cat !== d.categoryCode;
  const act = async (path: string, body: object, msg: string) => { const r = await adminCall(token, 'POST', `/incidents/${d.id}/${path}`, body); r.ok ? done(msg) : setErr(errorText(r)); };
  return <li className="space-y-2 rounded-[6px] border border-line p-3">
    <p className="text-dim">{VERIFICATION_LABELS[d.verificationStatus]} · {d.sources.length} source{d.sources.length === 1 ? '' : 's'} · {d.updates.length} timeline entr{d.updates.length === 1 ? 'y' : 'ies'}</p>
    <input aria-label={`Headline for ${d.id}`} className={`${box} w-full font-headline`} value={headline} onChange={(e) => setHeadline(e.target.value)} />
    <textarea aria-label={`Summary for ${d.id}`} className={`${box} w-full`} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
    <select aria-label={`Category for ${d.id}`} className={box} value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORY_CODES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}</select>
    <input aria-label={`Reason for ${d.id}`} className={`${box} w-full`} placeholder="Reason or note, used for every action below (10+ characters)" value={note} onChange={(e) => setNote(e.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      <button className={`${box} disabled:opacity-40`} disabled={!ok || !changed} onClick={() => act('correct', { ...(headline !== d.headline && { headline }), ...(summary !== d.summary && { summary }), ...(cat !== d.categoryCode && { categoryCode: cat }), note }, 'Correction saved.')}>Save correction</button>
      <button className={`${box} disabled:opacity-40`} disabled={!ok} onClick={() => act('archive', { reason: note }, 'Incident archived.')}>Archive</button>
      {role === 'admin' && <button className={`${box} disabled:opacity-40`} disabled={!ok} onClick={() => act('archive', { reason: note, remove: true }, 'Incident removed.')}>Remove</button>}
      <select aria-label={`Merge target for ${d.id}`} className={box} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Merge into…</option>{others.map((o) => <option key={o.id} value={o.id}>{o.headline}</option>)}</select>
      <button className={`${box} disabled:opacity-40`} disabled={!ok || !target} onClick={() => act('merge', { intoIncidentId: target, reason: note }, 'Merged. The duplicate is archived.')}>Merge</button></div>
    {err && <p role="alert" className="text-dim">{err}</p>}
  </li>;
}

export default function PublishedManager({ token, role }: { token: string; role: 'admin' | 'reviewer' }) {
  const [items, setItems] = useState<Draft[] | null | 'loading'>('loading'); const [msg, setMsg] = useState('');
  const load = async () => setItems(await loadPublished(token)); useEffect(() => { void load(); }, []);
  if (items === 'loading') return <p className="text-dim">Loading published incidents…</p>;
  if (!items) return <p role="alert" className="text-dim">Could not load published incidents.</p>;
  return <div className="space-y-3">
    <p className="text-dim">Corrections add a visible entry to the incident timeline. Archiving takes an incident off the public map. Removal is for inaccurate or harmful records and is admin-only. Every action is audited.</p>
    {msg && <p role="status" className="text-dim">{msg}</p>}
    {items.length === 0 ? <p className="text-dim">No published incidents.</p> : <ul className="space-y-3">{items.map((d) => <Card key={d.id} d={d} others={items.filter((o) => o.id !== d.id)} token={token} role={role} done={(m) => { setMsg(m); void load(); }} />)}</ul>}
  </div>;
}
