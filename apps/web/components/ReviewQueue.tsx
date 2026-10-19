'use client';
import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, VERIFICATION_LABELS, VERIFICATION_STATUSES, type IncidentDTOType } from '@crimelens/shared';
import { adminCall, errorText, loadQueue, type Cand, type Draft } from '../lib/admin';

const box = 'rounded-[6px] border border-line bg-bg2 px-2 py-1.5 text-sm text-ink';
type Match = { id: string; headline: string; match: string };
const catLabel = (c: string) => CATEGORY_LABELS[c as IncidentDTOType['categoryCode']] ?? c;

function CandidateCard({ c, token, done }: { c: Cand; token: string; done: (m: string) => void }) {
  const [reason, setReason] = useState(''); const [matches, setMatches] = useState<Match[] | null>(null); const [err, setErr] = useState('');
  const accept = async (body: object = {}) => {
    const r = await adminCall(token, 'POST', `/candidates/${c.id}/accept`, body);
    if (r.status === 409 && r.json?.error === 'possible_duplicate') { setMatches(r.json.matches); setErr(''); return; }
    r.ok ? done(`Candidate ${c.id} ${r.json.status}.`) : setErr(errorText(r));
  };
  return <li className="space-y-2 rounded-[6px] border border-line p-3">
    <p className="font-headline text-base">{c.candidate.headline}</p>
    <p className="text-dim">{catLabel(c.candidate.categoryCode)} · {c.candidate.locality ?? 'locality unknown'} · extraction confidence {c.candidate.extractionConfidence} · {c.kind.replace('_', ' ')}</p>
    <p>{c.candidate.summary}</p>
    <a className="underline" href={c.document.url} target="_blank" rel="noopener noreferrer">{c.document.title}</a>
    {matches && <div role="alert" className="rounded-[6px] border border-line p-2"><p className="font-medium">This looks like an existing incident:</p>
      <ul className="mt-1 space-y-1">{matches.map((m) => <li key={m.id} className="flex items-center gap-2"><span className="flex-1">{m.headline} <span className="text-dim">({m.match})</span></span>
        <button className={box} onClick={() => accept({ mergeIntoIncidentId: m.id })}>Merge into this</button></li>)}</ul>
      <button className={`${box} mt-2`} onClick={() => accept({ confirmDistinct: true })}>It is a different incident</button></div>}
    <div className="flex flex-wrap gap-2"><button className={box} onClick={() => accept()}>Accept as draft</button>
      <input aria-label={`Reject reason for candidate ${c.id}`} className={`${box} min-w-[12rem] flex-1`} placeholder="Reason to reject (10+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className={`${box} disabled:opacity-40`} disabled={reason.trim().length < 10} onClick={async () => { const r = await adminCall(token, 'POST', `/candidates/${c.id}/reject`, { reason }); r.ok ? done(`Candidate ${c.id} rejected.`) : setErr(errorText(r)); }}>Reject</button></div>
    {err && <p role="alert" className="text-dim">{err}</p>}
  </li>;
}

function DraftCard({ d, token, done }: { d: Draft; token: string; done: (m: string) => void }) {
  const [status, setStatus] = useState<string>('reported_by_news'); const [note, setNote] = useState(''); const [publish, setPublish] = useState(false); const [err, setErr] = useState('');
  const ok = note.trim().length >= 10;
  return <li className="space-y-2 rounded-[6px] border border-line p-3">
    <p className="font-headline text-base">{d.headline}</p>
    <p className="text-dim">{catLabel(d.categoryCode)} · {d.locality ?? 'locality unknown'} · {d.location ? `${d.location.precision.replace(/_/g, ' ')} location` : 'no location'} · currently {VERIFICATION_LABELS[d.verificationStatus]}</p>
    <p>{d.summary}</p>
    <p>Sources: {d.sources.length === 0 ? 'none linked' : d.sources.map((s, i) => <span key={s.url}>{i > 0 && ', '}<a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a></span>)}</p>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={`Verification status for ${d.id}`} className={box} value={status} onChange={(e) => setStatus(e.target.value)}>{VERIFICATION_STATUSES.filter((v) => v !== 'archived').map((v) => <option key={v} value={v}>{VERIFICATION_LABELS[v]}</option>)}</select>
      <input aria-label={`Explanation for ${d.id}`} className={`${box} min-w-[14rem] flex-1`} placeholder="Explain the decision (10+ characters)" value={note} onChange={(e) => setNote(e.target.value)} />
      <label className="flex items-center gap-1 text-dim"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish</label>
      <button className={`${box} disabled:opacity-40`} disabled={!ok} onClick={async () => { const r = await adminCall(token, 'POST', `/incidents/${d.id}/review`, { status, explanation: note, publish }); r.ok ? done('Review saved.') : setErr(errorText(r)); }}>Save review</button>
      <button className={`${box} disabled:opacity-40`} disabled={!ok} onClick={async () => { const r = await adminCall(token, 'POST', `/incidents/${d.id}/archive`, { reason: note }); r.ok ? done('Incident archived.') : setErr(errorText(r)); }}>Archive</button></div>
    {err && <p role="alert" className="text-dim">{err}</p>}
  </li>;
}

export default function ReviewQueue({ token }: { token: string }) {
  const [q, setQ] = useState<{ drafts: Draft[]; candidates: Cand[] } | null | 'loading'>('loading'); const [msg, setMsg] = useState('');
  const load = async () => setQ(await loadQueue(token));
  useEffect(() => { void load(); }, []);
  const done = (m: string) => { setMsg(m); void load(); };
  if (q === 'loading') return <p className="text-dim">Loading the review queue…</p>;
  if (!q) return <p role="alert" className="text-dim">Could not load the review queue.</p>;
  return <div className="space-y-6">
    {msg && <p role="status" className="text-dim">{msg}</p>}
    <section aria-label="Candidates awaiting review"><h2 className="mb-2 font-medium">Candidates awaiting review ({q.candidates.length})</h2>
      {q.candidates.length === 0 ? <p className="text-dim">None waiting.</p> : <ul className="space-y-3">{q.candidates.map((c) => <CandidateCard key={c.id} c={c} token={token} done={done} />)}</ul>}</section>
    <section aria-label="Draft incidents"><h2 className="mb-2 font-medium">Draft incidents ({q.drafts.length})</h2>
      {q.drafts.length === 0 ? <p className="text-dim">No drafts waiting. Imported records and accepted candidates appear here.</p> : <ul className="space-y-3">{q.drafts.map((d) => <DraftCard key={d.id} d={d} token={token} done={done} />)}</ul>}</section>
  </div>;
}
